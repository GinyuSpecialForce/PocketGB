// PocketGB — Electron main process
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { isPatchPath } = require('./src/core/patch');
const { extractRomTitle, titleLooksBroken, basenameOf } = require('./src/core/romtitle');
const updater = require('./src/main/updater');

let win = null;
let currentRom = null; // { name, path, dir }
let saveTimer = null;

const userDir = () => app.getPath('userData');

// app:// must be registered BEFORE the ready event: a standard, secure scheme
// so the page gets a real origin and the COOP/COEP headers below can enable
// crossOriginIsolated (→ SharedArrayBuffer → zero-copy audio ring).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
const savesDir = () => { const d = path.join(userDir(), 'saves'); fs.mkdirSync(d, { recursive: true }); return d; };
const statesDir = () => { const d = path.join(userDir(), 'states'); fs.mkdirSync(d, { recursive: true }); return d; };
const shotsDir = () => { const d = path.join(userDir(), 'shots'); fs.mkdirSync(d, { recursive: true }); return d; };
const gameShotsDir = (key) => { const d = path.join(shotsDir(), path.basename(String(key))); fs.mkdirSync(d, { recursive: true }); return d; };
const coversDir = () => { const d = path.join(userDir(), 'covers'); fs.mkdirSync(d, { recursive: true }); return d; };
const SHOTS_KEEP = 100; // per-game screenshot history cap

// ---- settings store (per-game + global) ----
const settingsPath = () => path.join(userDir(), 'settings.json');
let settingsCache = null;
function readSettings() {
  if (settingsCache) return settingsCache;
  try { settingsCache = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { settingsCache = {}; }
  return settingsCache;
}
function writeSetting(key, value) {
  const s = readSettings();
  s[key] = value;
  settingsCache = s;
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s)); } catch (err) { console.error('settings write failed', err); }
}

function send(ch, ...args) { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); }

// ---- link cable (localhost TCP bridge between two PocketGB instances) ----
let linkServer = null; // net.Server while hosting
let linkSock = null;   // net.Socket while connected

function linkStatus() {
  return { hosting: !!linkServer, connected: !!(linkSock && !linkSock.destroyed) };
}

function startLinkServer(port) {
  stopLink();
  linkServer = net.createServer((sock) => {
    if (linkSock && !linkSock.destroyed) { sock.destroy(); return; } // single-peer link
    linkSock = sock;
    sock.on('data', (buf) => send('link-data', new Uint8Array(buf)));
    sock.on('close', () => { if (linkSock === sock) { linkSock = null; send('link-status', linkStatus()); } });
    sock.on('error', () => {}); // close handles cleanup
    send('link-status', linkStatus());
  });
  linkServer.on('error', (err) => {
    send('link-error', String((err && err.message) || err));
    linkServer = null;
    send('link-status', linkStatus());
  });
  linkServer.listen(port || 0, '127.0.0.1', () => {
    send('link-hosting', linkServer.address().port); // share this port with the peer
  });
}

function joinLink(port, host) {
  stopLink();
  const target = (typeof host === 'string' && host.length) ? host : '127.0.0.1';
  const sock = net.connect(port || 8765, target);
  linkSock = sock;
  sock.on('connect', () => send('link-status', linkStatus()));
  sock.on('data', (buf) => send('link-data', new Uint8Array(buf)));
  sock.on('close', () => { if (linkSock === sock) { linkSock = null; send('link-status', linkStatus()); } });
  sock.on('error', (err) => { send('link-error', String((err && err.message) || err)); });
}

function stopLink() {
  if (linkSock) { linkSock.destroy(); linkSock = null; }
  if (linkServer) { linkServer.close(); linkServer = null; }
}

function romKey(romPath) {
  return Buffer.from(romPath.toLowerCase()).toString('base64url');
}

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 560,
    minWidth: 320, minHeight: 320,
    title: 'PocketGB',
    backgroundColor: '#0b0f14',
    webPreferences: {
      preload: path.join(__dirname, 'pocketgb-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL('app://bundle/index.html');
  win.setMenuBarVisibility(true);
}

function openRomDialog() {
  dialog.showOpenDialog(win, {
    title: 'Open Game Boy ROM',
    filters: [
      { name: 'Game Boy ROMs and Patches', extensions: ['gb', 'gbc', 'bin', 'rom', 'ips', 'ups', 'bps', 'aps', 'rup', 'ppf', 'vcdiff', 'xdelta'] },
      { name: 'ROM files', extensions: ['gb', 'gbc', 'bin', 'rom'] },
      { name: 'Patches (IPS/UPS/BPS/APS/RUP/PPF/xdelta)', extensions: ['ips', 'ups', 'bps', 'aps', 'rup', 'ppf', 'vcdiff', 'xdelta'] },
    ],
    properties: ['openFile', 'multiSelections'],
  }).then(({ canceled, filePaths }) => {
    if (canceled || !filePaths.length) return;
    const romPath = filePaths.find((p) => !isPatchPath(p)) || filePaths[0];
    let patchPath = filePaths.find(isPatchPath) || null;
    if (!patchPath) {
      // auto-apply a same-named patch sitting beside the ROM (ROM-hack convention)
      for (const ext of ['.ips', '.ups', '.bps', '.aps', '.rup', '.ppf', '.vcdiff', '.xdelta']) {
        const candidate = romPath.replace(/\.[^.]+$/, '') + ext;
        if (fs.existsSync(candidate)) { patchPath = candidate; break; }
      }
    }
    loadRomFromPath(romPath, patchPath);
  });
}

function loadRomFromPath(romPath, patchPath) {
  try {
    if (/\.hdrbak$/i.test(romPath)) throw new Error('That is a header backup written by PocketGB, not a game. Open the .gb/.gbc file instead.');
    const data = fs.readFileSync(romPath);
    if (data.length < 0x150) throw new Error('File too small to be a Game Boy ROM');
    const name = path.basename(romPath);
    const title = extractRomTitle(data) || name;
    currentRom = { name, path: romPath, dir: path.dirname(romPath), title };
    let patchBytes = null, patchName = null;
    if (patchPath && isPatchPath(patchPath)) {
      try { patchBytes = fs.readFileSync(patchPath); patchName = path.basename(patchPath); }
      catch { patchBytes = null; }
    }

    // Recent ROMs list (kept in recent.json AND settings.json for the library UI)
    const recent = readRecent();
    const filtered = recent.filter(r => r.path !== romPath);
    filtered.unshift({ path: romPath, title, last: Date.now() });
    fs.writeFileSync(path.join(userDir(), 'recent.json'), JSON.stringify(filtered.slice(0, 10)));
    writeSetting('recent', filtered.slice(0, 12));
    buildMenu(); // refresh Recent ROMs immediately

    // Battery save path
    const savePath = path.join(savesDir(), romKey(romPath) + '.sav');
    send('rom-opened', {
      name,
      title,
      path: romPath,
      bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      patch: patchBytes,
      patchName,
      savePath,
      statesDir: statesDir(),
      statesKey: romKey(romPath),
    });
    if (win) win.setTitle(`PocketGB — ${title}`);
  } catch (err) {
    dialog.showErrorBox('Could not open ROM', String(err.message || err));
  }
}

function readRecent() {
  try { return JSON.parse(fs.readFileSync(path.join(userDir(), 'recent.json'), 'utf8')); }
  catch { return []; }
}

function recentItems() {
  return readRecent().map(r => ({
    label: (!titleLooksBroken(r.title) ? r.title : null) || basenameOf(r.path),
    click: () => loadRomFromPath(r.path),
  }));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => updater.checkExplicit() },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Open ROM…', accelerator: 'CmdOrCtrl+O', click: () => openRomDialog() },
      { label: 'Open Recent', submenu: recentItems().length ? recentItems() : [{ label: 'No Recent ROMs', enabled: false }] },
      { type: 'separator' },
      { label: 'Reset', accelerator: 'CmdOrCtrl+R', click: () => send('reset') },
      { type: 'separator' },
      { role: isMac ? 'close' : 'quit' },
    ] },
    { label: 'Emulation', submenu: [
      { label: 'Pause', type: 'checkbox', accelerator: 'CmdOrCtrl+P', click: (mi) => send('pause', mi.checked) },
      { label: 'Mute', type: 'checkbox', accelerator: 'CmdOrCtrl+M', click: (mi) => send('mute', mi.checked) },
      { label: 'Force DMG Mode (restarts ROM)', type: 'checkbox', click: (mi) => send('force-dmg', mi.checked) },
      { type: 'separator' },
      { label: 'Save State', submenu: [0,1,2,3,4,5,6,7,8,9].map(i => ({
          label: `Slot ${i}`, accelerator: isMac ? `Cmd+Shift+${i}` : `Ctrl+Shift+${i}`,
          click: () => send('save-state', i),
      })) },
      { label: 'Load State', submenu: [0,1,2,3,4,5,6,7,8,9].map(i => ({
          label: `Load State Slot ${i}`, accelerator: isMac ? `Cmd+${i}` : `Ctrl+${i}`,
          click: () => send('load-state', i),
      })) },
    ] },
    ...(isMac ? [] : [{ role: 'help', submenu: [
      { label: 'Check for Updates…', click: () => updater.checkExplicit() },
      { type: 'separator' },
      { label: 'About PocketGB', role: 'about' },
    ] }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // ---- app:// protocol with cross-origin isolation headers ----
  // Serving over plain file:// leaves the page without crossOriginIsolated,
  // so SharedArrayBuffer (the zero-copy lock-free audio ring) is unavailable
  // and audio falls back to per-block postMessage copies — audibly laggy.
  // COOP/COEP response headers flip crossOriginIsolated on.
  const COOP_COEP = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
  protocol.handle('app', (request) => {
    try {
      // app://bundle/index.html → <project>/index.html
      const u = new URL(request.url);
      let p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (p === '' || p.endsWith('/')) p += 'index.html';
      const root = __dirname; // main.js lives in the bundle root
      const full = path.normalize(path.join(root, p));
      if (!full.startsWith(path.normalize(root))) {
        return new Response('forbidden', { status: 403 }); // stay inside the bundle
      }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json',
        '.wasm': 'application/wasm', '.map': 'application/json', '.woff2': 'font/woff2' };
      const data = fs.readFileSync(full);
      return new Response(data, {
        headers: { 'content-type': types[path.extname(full).toLowerCase()] || 'application/octet-stream', ...COOP_COEP },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  ipcMain.on('menu-refresh', () => buildMenu()); // refreshes Recent ROMs + slot state
  ipcMain.on('open-rom-dialog', () => openRomDialog());
  ipcMain.on('set-setting', (e, key, value) => {
    // Key shape: game:<base64url-of-rom-path>:<field> — long ROM paths base64 out
    // well past 128 chars (SMB Deluxe's key is 156), so the bound must stay
    // generous; 512 still rejects runaway/abusive keys while accepting every
    // realistic path. Value must survive a JSON round-trip.
    if (typeof key !== 'string' || key.length > 512) return;
    writeSetting(key, value);
  });
  ipcMain.handle('get-settings', () => readSettings());
  ipcMain.handle('open-path', async (e, p) => {
    try {
      if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
      await shell.openPath(p);
      return true;
    } catch { return false; }
  });
  ipcMain.on('open-rom-path', (e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) loadRomFromPath(p);
  });
  ipcMain.handle('save-file', async (e, name, b64) => {
    try {
      const safe = path.basename(String(name)).replace(/[^\w.-]/g, '_');
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('desktop'), safe),
      });
      if (canceled || !filePath) return null;
      fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
      return filePath;
    } catch (err) { console.error('save-file failed', err); return null; }
  });
  ipcMain.on('write-sav', (e, savePath, u8) => {
    try {
      const p = path.isAbsolute(savePath) ? savePath : path.join(savesDir(), path.basename(savePath));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(u8));
    } catch (err) { console.error('sav write failed', err); }
  });
  ipcMain.on('write-state', (e, statePath, u8, thumbB64) => {
    try {
      const p = path.isAbsolute(statePath) ? statePath : path.join(statesDir(), path.basename(statePath));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(u8));
      if (typeof thumbB64 === 'string' && thumbB64.length) {
        fs.writeFileSync(p + '.png', Buffer.from(thumbB64, 'base64'));
      }
    } catch (err) { console.error('state write failed', err); }
  });
  ipcMain.handle('read-sav', (e, savePath) => {
    try {
      const p = path.isAbsolute(savePath) ? savePath : path.join(savesDir(), path.basename(savePath));
      return fs.readFileSync(p).buffer.slice(0);
    } catch { return null; }
  });
  ipcMain.handle('read-state', (e, statePath) => {
    try {
      const p = path.isAbsolute(statePath) ? statePath : path.join(statesDir(), path.basename(statePath));
      return fs.readFileSync(p).buffer.slice(0);
    } catch { return null; }
  });
  // ---- library management ----
  // removeRomFromRecent(path): drops the entry from both recent stores.
  // Returns true if anything was removed.
  function removeRomFromRecent(romPath) {
    const recent = readRecent().filter(r => r.path !== romPath);
    const before = readRecent().length;
    fs.writeFileSync(path.join(userDir(), 'recent.json'), JSON.stringify(recent));
    writeSetting('recent', recent.slice(0, 12));
    buildMenu(); // refresh the File > Open Recent submenu
    return recent.length !== before;
  }

  // deleteGameData(romPath): best-effort removal of every artifact derived
  // from this ROM — battery .sav, all save-states, all state thumbnails.
  function deleteGameData(romPath) {
    const key = romKey(romPath);
    const removed = { sav: 0, states: 0 };
    try {
      const sav = path.join(savesDir(), key + '.sav');
      if (fs.existsSync(sav)) { fs.unlinkSync(sav); removed.sav = 1; }
    } catch { /* best-effort */ }
    try {
      for (const f of fs.readdirSync(statesDir())) {
        if (f.startsWith(key) && (f.endsWith('.state') || f.endsWith('.state.png'))) {
          try { fs.unlinkSync(path.join(statesDir(), f)); removed.states++; } catch { }
        }
      }
    } catch { /* best-effort */ }
    try {
      fs.rmSync(gameShotsDir(key), { recursive: true, force: true });
      try { fs.unlinkSync(path.join(coversDir(), `${key}.png`)); } catch { }
    } catch { /* best-effort */ }
    return removed;
  }

  ipcMain.handle('delete-rom', (e, romPath) => {
    if (typeof romPath !== 'string' || !path.isAbsolute(romPath)) return { ok: false, reason: 'bad path' };
    const gameFiles = deleteGameData(romPath);
    const removed = removeRomFromRecent(romPath);
    // If the deleted game is currently running, close it back to the library.
    if (currentRom && currentRom.path === romPath && win && !win.isDestroyed()) {
      currentRom = null;
      win.loadURL('app://bundle/index.html');
    }
    return { ok: true, removed, removedFromList: removed };
  });
  ipcMain.handle('delete-saves', (e, romPath) => {
    if (typeof romPath !== 'string' || !path.isAbsolute(romPath)) return { ok: false, reason: 'bad path' };
    const removed = deleteGameData(romPath);
    return { ok: true, removed };
  });

  // ---- screenshot history (per-game gallery) ----
  // Shots live in userData/shots/<romKey>/<timestamp>.png; the newest SHOTS_KEEP
  // are kept per game. Cover art is copied to covers/<romKey>.png and rendered
  // by the library card instead of the save-state thumbnail.
  ipcMain.handle('save-shot', (e, key, b64) => {
    try {
      const dir = gameShotsDir(key);
      const file = path.join(dir, `${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(String(b64), 'base64'));
      // cap the history: drop oldest beyond SHOTS_KEEP
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - SHOTS_KEEP))) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { }
      }
      return { ok: true, file };
    } catch (err) { return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('list-shots', (e, key) => {
    try {
      const dir = gameShotsDir(key);
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .sort()
        .reverse() // newest first
        .map((f) => {
          const full = path.join(dir, f);
          return { file: f, mtime: fs.statSync(full).mtimeMs };
        });
    } catch { return []; }
  });
  ipcMain.handle('read-shot', (e, key, file) => {
    try {
      const dir = gameShotsDir(key);
      const safe = path.basename(String(file));
      if (!safe.endsWith('.png')) return null;
      return fs.readFileSync(path.join(dir, safe)).toString('base64');
    } catch { return null; }
  });
  ipcMain.handle('delete-shot', (e, key, file) => {
    try {
      const dir = gameShotsDir(key);
      fs.unlinkSync(path.join(dir, path.basename(String(file))));
      return { ok: true };
    } catch (err) { return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('set-cover', (e, romPath, key, file) => {
    try {
      // file may be a gallery shot name or null to clear the override
      if (!file) {
        try { fs.unlinkSync(path.join(coversDir(), `${key}.png`)); } catch { }
        return { ok: true, cleared: true };
      }
      const src = path.join(gameShotsDir(key), path.basename(String(file)));
      fs.copyFileSync(src, path.join(coversDir(), `${key}.png`));
      return { ok: true };
    } catch (err) { return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('read-cover', (e, romPath, key) => {
    try {
      return fs.readFileSync(path.join(coversDir(), `${key}.png`)).toString('base64');
    } catch { return null; }
  });

  // Shader packs: read a .pbg-fx file as text so the renderer can parse/compile it.
  // The active pack is fs.watch'ed so saving it in an editor hot-reloads live.
  let packWatcher = null, packWatchDebounce = null, packWatchedPath = null;
  function watchShaderPack(p) {
    try {
      if (packWatcher) { packWatcher.close(); packWatcher = null; packWatchedPath = null; }
      if (!p) return;
      packWatchedPath = p;
      packWatcher = fs.watch(p, () => {
        clearTimeout(packWatchDebounce);
        packWatchDebounce = setTimeout(() => {
          if (win && !win.isDestroyed()) win.webContents.send('shader-pack-changed', packWatchedPath);
        }, 300);
      });
    } catch { /* watch is best-effort */ }
  }
  ipcMain.handle('read-shader-pack', (e, packPath) => {
    try {
      if (typeof packPath !== 'string' || !path.isAbsolute(packPath)) return { ok: false, error: 'bad path' };
      if (!packPath.toLowerCase().endsWith('.pbg-fx')) return { ok: false, error: 'not a .pbg-fx file' };
      const text = fs.readFileSync(packPath, 'utf8');
      watchShaderPack(packPath);
      return { ok: true, text, path: packPath };
    } catch (err) { return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('open-shader-pack', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Load shader pack',
      properties: ['openFile'],
      filters: [{ name: 'PocketGB shader packs', extensions: ['pbg-fx'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    try {
      const text = fs.readFileSync(p, 'utf8');
      watchShaderPack(p);
      return { ok: true, text, path: p };
    }
    catch (err) { return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('read-thumbnail', (e, statePath) => {
    try {
      const p = path.isAbsolute(statePath) ? statePath : path.join(statesDir(), path.basename(statePath));
      const buf = fs.readFileSync(p + '.png');
      return buf.toString('base64');
    } catch { return null; }
  });
  ipcMain.handle('list-states', (e, key) => {
    try {
      const d = statesDir();
      return fs.readdirSync(d).filter(f => f.startsWith(key) && f.endsWith('.state'))
        .map(f => {
          const slot = parseInt(f.slice(key.length + 1), 10);
          let mtime = 0, hasThumb = false;
          try { mtime = fs.statSync(path.join(d, f)).mtimeMs; } catch { }
          try { hasThumb = fs.existsSync(path.join(d, f + '.png')); } catch { }
          return { slot, file: f, mtime, hasThumb };
        });
    } catch { return []; }
  });

  // link cable
  ipcMain.handle('link-host', (e, port) => { startLinkServer(Number(port) || 0); return linkStatus(); });
  ipcMain.handle('link-join', (e, port, host) => { joinLink(Number(port) || 8765, host); return linkStatus(); });
  ipcMain.handle('link-stop', () => { stopLink(); return linkStatus(); });
  ipcMain.on('link-send', (e, b) => {
    if (linkSock && !linkSock.destroyed) linkSock.write(Buffer.from([b & 0xFF]));
  });

  buildMenu();
  createWindow();

  // Auto-update: silent background checks; explicit check via Help menu.
  updater.start((text) => send('update-status', text));
  ipcMain.handle('check-for-updates', () => updater.checkExplicit());

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });

app.on('before-quit', () => {
  updater.stop();
  stopLink();
  send('app-quitting');
});
