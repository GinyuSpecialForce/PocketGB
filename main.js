// PocketGB — Electron main process
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { isPatchPath } = require('./src/core/patch');
const { extractRomTitle, titleLooksBroken, basenameOf } = require('./src/core/romtitle');
const { gbaHeaderValid } = require('./src/core/gba-header');
const updater = require('./src/main/updater');

// Startup banner — this is the line you see when launching from a terminal.
const pkg = require('./package.json');
console.log(`PocketGB version ${pkg.version}`);

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
// path.basename strips separators, but a bare '.' or '..' key would still
// climb out of shots/ — reject it here so every shot/cover handler is confined
// (they all funnel through this and already catch the throw).
const gameShotsDir = (key) => {
  const safe = path.basename(String(key));
  if (!safe || safe === '.' || safe === '..') throw new Error('bad key');
  const d = path.join(shotsDir(), safe); fs.mkdirSync(d, { recursive: true }); return d;
};
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

// ---- link cable (netplay: TCP bridge between two PocketGB instances) ----
// Extracted into src/core/netlink.js so it's unit-testable; the LAN option
// (bind 0.0.0.0) makes real two-machine play possible — the old code only
// ever bound loopback, so two computers could never connect.
const { NetLink } = require('./src/core/netlink');
let link = null;
function getLink() {
  if (!link) {
    // Peer bytes must reach the Game Boy's serial side or netplay is
    // half-duplex (our bytes go out, the peer's vanish). Buffer them here and
    // batch one IPC send per 8ms tick instead of one round-trip per byte —
    // the Serial layer is byte-oriented, so a burst arriving together is fine.
    const linkInbox = [];
    link = new NetLink({
      onStatus: (st) => {
        send('link-status', st);
        // keep the renderer's separate 'hosting port' channel fed (UI text)
        send('link-hosting', st.hosting ? (st.port || 0) : 0);
      },
      onError: (msg) => send('link-error', msg),
      onByte: (b) => linkInbox.push(b),
    });
    setInterval(() => {
      if (linkInbox.length) { send('link-data', Uint8Array.from(linkInbox)); linkInbox.length = 0; }
    }, 8);
  }
  return link;
}
function linkStatus() { return link ? link.status : { hosting: false, connected: false, port: null }; }
function romKey(romPath) {
  return Buffer.from(romPath.toLowerCase()).toString('base64url');
}

// ---- Discord Rich Presence + play-time stats (#10) ----
// Both live in the MAIN process: presence needs the local Discord IPC pipe
// (the renderer is app://-origin sandboxed) and play time must keep counting
// honestly no matter what the renderer tab is doing. The tracker only
// advances on an explicit 'playtime-tick' from the renderer while a game is
// actually running (loaded, unpaused, window focused).
const { buildActivity, DiscordRpcClient } = require('./src/main/discord-rpc');
const { addTime, getTime, fmtPlaytime, PlaySession } = require('./src/main/playtime');
const DISCORD_CLIENT_ID = '1421819172729315499';
let discord = null; // latched client (reconnects after Discord restarts)
let discordTimer = null;
const playSession = new PlaySession();
let discordActivityOn = readSettings()['discordRpc'] !== false; // default ON

function activityPayload() {
  if (!currentRom) return null;
  return buildActivity({
    title: currentRom.title,
    state: playSession.key ? `playing — session ${fmtPlaytime(playSession.elapsed)}` : 'in the library',
    elapsedSeconds: playSession.key ? playSession.elapsed : undefined,
  });
}
function pushPresence() {
  if (!discordActivityOn || !discord) return;
  discord.setActivity(activityPayload());
}
function ensureDiscord() {
  if (!discordActivityOn) return;
  if (!discord) {
    discord = new DiscordRpcClient({
      clientId: DISCORD_CLIENT_ID,
      onClose: () => {
        // Discord quit (or the pipe vanished) — retry in the background so a
        // restarted Discord picks the presence back up on its own.
        if (discordTimer) clearTimeout(discordTimer);
        discordTimer = setTimeout(() => { discordTimer = null; ensureDiscord(); }, 15000);
      },
    });
  }
  if (discord.sock) return; // connected (or already mid-reconnect)
  discord.connect().then(() => pushPresence()).catch(() => { /* not running; onClose fires the retry */ });
}
function stopDiscordRetry() { if (discordTimer) { clearTimeout(discordTimer); discordTimer = null; } }
function flushPlaytime() {
  const key = playSession.key;
  if (!key) return;
  const whole = playSession.take();
  if (whole > 0) {
    writeSetting(`game:${key}:playtime`, getTime(readSettings(), key) + whole);
    send('playtime-updated', { key, total: getTime(readSettings(), key) });
  }
}

// Called by loadRomFromPath for every ROM open — starts/switches the play
// session, commits the previous game's seconds, refreshes presence.
function onRomOpenedForPresence(romPath) {
  const key = romKey(romPath);
  flushPlaytime();
  playSession.start(key);
  ensureDiscord();
  pushPresence();
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
      { name: 'Game Boy / Advance ROMs and Patches', extensions: ['gb', 'gbc', 'gba', 'bin', 'rom', 'ips', 'ups', 'bps', 'aps', 'rup', 'ppf', 'vcdiff', 'xdelta'] },
      { name: 'ROM files', extensions: ['gb', 'gbc', 'gba', 'bin', 'rom'] },
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
    if (data.length < 0xC0) throw new Error('File too small to be a supported ROM');
    const isGba = gbaHeaderValid(data);
    if (!isGba && data.length < 0x150) throw new Error('File too small to be a Game Boy ROM');
    const name = path.basename(romPath);
    const title = isGba
      ? (new TextDecoder().decode(data.subarray(0xA0, 0xAC)).replace(/\0/g, '').trim() || name)
      : (extractRomTitle(data) || name);
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
      kind: isGba ? 'gba' : 'gb',
      bios: isGba ? (() => {
        try {
          const b = fs.readFileSync(path.join(__dirname, 'gba_bios.bin'));
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        } catch { return null; }
      })() : null,
      statesDir: statesDir(),
      statesKey: romKey(romPath),
    });
    if (win) win.setTitle(`PocketGB — ${title}`);
    onRomOpenedForPresence(romPath);
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
        })
        .filter(s => Number.isFinite(s.slot)); // 'resume.state' is not a numbered slot
    } catch { return []; }
  });
  // Delete one save-state (bytes + optional thumbnail) by full path.
  ipcMain.handle('delete-state', (e, statePath) => {
    try {
      const p = path.isAbsolute(statePath) ? statePath : path.join(statesDir(), path.basename(statePath));
      if (path.dirname(p) !== statesDir()) return { ok: false, error: 'not a state path' };
      try { fs.unlinkSync(p); } catch { /* already gone */ }
      try { fs.unlinkSync(p + '.png'); } catch { /* no thumbnail */ }
      return { ok: true };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // link cable (netplay)
  ipcMain.handle('link-host', async (e, port, lan) => {
    try { const p = await getLink().host(Number(port) || 0, { lan: !!lan }); return { ...linkStatus(), port: p }; }
    catch (err) { return { ...linkStatus(), error: String((err && err.message) || err) }; }
  });
  ipcMain.handle('link-join', async (e, port, host) => {
    try { await getLink().join(Number(port) || 8765, host); return linkStatus(); }
    catch (err) { return { ...linkStatus(), error: String((err && err.message) || err) }; }
  });
  ipcMain.handle('link-stop', () => { if (link) link.stop(); return linkStatus(); });
  ipcMain.on('link-send', (e, b) => { if (link) link.send(b); });

  // ---- RetroAchievements (network lives here: the COEP-locked renderer
  // can only fetch same-origin app:// URLs) ----
  const { RAClient } = require('./src/core/achievements');
  let raClient = null;
  ipcMain.handle('ra-login', async (e, username, apiKey) => {
    try {
      raClient = new RAClient({ username: String(username || ''), token: String(apiKey || '') });
      const res = await raClient.login();
      writeSetting('ra.user', res.user);
      return { ok: true, user: res.user, score: res.score, softcore: res.softcore };
    } catch (err) {
      raClient = null;
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('ra-logout', () => { raClient = null; writeSetting('ra.user', null); return { ok: true }; });
  ipcMain.handle('ra-session', async (e, romB64) => {
    // Identify the loaded ROM and hand the renderer the compiled set.
    try {
      if (!raClient) return { ok: false, error: 'not logged in' };
      const rom = Buffer.from(String(romB64 || ''), 'base64');
      const { raHash } = require('./src/core/achievements');
      const hash = raHash(rom);
      const game = await raClient.fetchGame(hash);
      return { ok: true, hash, game };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('ra-award', async (e, achId, hardcore, gameHash) => {
    try {
      if (!raClient) return { ok: false, error: 'not logged in' };
      const res = await raClient.award(achId, { hardcore: !!hardcore, gameHash });
      return { ok: !!res.success, error: res.error };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('ra-whoami', () => ({ user: readSettings()['ra.user'] || null }));

  // ---- cheat database lookup (gamehacking.org) ----
  // Network lives here like RA: the COEP-locked renderer can't fetch off-origin.
  // ghcrc is GH's full-file CRC32 — an exact version match when present.
  const { CheatDbClient, crc32Hex, splitCheatLines } = require('./src/core/cheatdb');
  let cheatDb = null;
  function getCheatDb() {
    if (!cheatDb) cheatDb = new CheatDbClient({});
    return cheatDb;
  }
  ipcMain.handle('cheatdb-search', async (e, sys, query, ghcrc) => {
    try {
      if (typeof sys !== 'string' || typeof query !== 'string') return { ok: false, error: 'bad query' };
      let games = await getCheatDb().searchGamesWithFallback(sys, query);
      let exactCrc = false;
      if (ghcrc) {
        const byCrc = games.filter((g) => (g.crc || '').toUpperCase() === String(ghcrc).toUpperCase());
        if (byCrc.length === 1) { games = byCrc; exactCrc = true; }
      }
      return { ok: true, games, exactCrc };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('cheatdb-codes', async (e, gamId) => {
    try {
      const groups = await getCheatDb().fetchGroups(gamId);
      return { ok: true, groups, url: require('./src/core/cheatdb').CheatDbClient.sourceUrl(gamId) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('cheatdb-crc', (e, bytes) => {
    try {
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 0x150) return { ok: false, error: 'bad rom' };
      return { ok: true, crc: crc32Hex(new Uint8Array(bytes)) };
    } catch (err) { return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle('cheatdb-split-lines', (e, text) => ({ ok: true, lines: splitCheatLines(String(text || '')) }));

  // ---- local multiplayer hub ----
  // Spawns a second PocketGB with --pgb-* flags (src/main/hub.js); the new
  // instance auto-loads the ROM and raises its end of the link cable. The
  // first window hosts when the user asks for player-2 — hosting with port 0
  // lets the OS pick a free loopback port, so "2-player" just works.
  const { parseHubArgs, buildSpawnArgs, childRole } = require('./src/main/hub');
  ipcMain.handle('hub-spawn', async (e, { rom, role, port } = {}) => {
    try {
      if (rom && (typeof rom !== 'string' || !path.isAbsolute(rom) || !fs.existsSync(rom))) {
        return { ok: false, error: 'bad rom path' };
      }
      if (role && role !== 'host' && role !== 'join') return { ok: false, error: 'bad role' };
      // The role is the PARENT's end of the cable. 'host': bind now so the
      // child can join a known port; the child gets the opposite role
      // (childRole) — passing 'host' through used to make the child host the
      // same port → EADDRINUSE and no connection. 'join': the child must HOST
      // on a fixed port, otherwise nobody ever listens and join fails.
      let hostPort = Number(port) || 0;
      let childArgsRole = null;
      let childPort = 0;
      if (role === 'host') {
        const st = await getLink().host(hostPort, { lan: false });
        hostPort = st.port || hostPort;
        childArgsRole = 'join';
        childPort = hostPort;
      } else if (role === 'join') {
        childArgsRole = 'host';
        childPort = hostPort || 8765; // child hosts where the parent will join
      }
      // Anchor the app path explicitly: `electron .` resolves argv[1]
      // relative to the child's cwd, which is not our project dir.
      const args = buildSpawnArgs({ baseArgs: [app.getAppPath()], rom: rom || null, role: childArgsRole, port: childPort });
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, args, {
        cwd: path.dirname(process.execPath),
        detached: false,
        stdio: 'ignore',
      });
      child.on('error', (err) => send('link-error', `player 2 launch failed: ${err.message}`));
      return { ok: true, pid: child.pid, port: hostPort };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // ---- presence + play-time IPC ----
  ipcMain.on('playtime-tick', (e, seconds) => {
    const s = Number(seconds);
    if (!playSession.key || !Number.isFinite(s) || s <= 0) return;
    playSession.tick(Math.min(s, 5)); // clamp: a stalled renderer can't fast-forward the clock
    if (playSession.played >= 15) flushPlaytime(); // commit every ~15s of play
    pushPresence(); // keeps the session elapsed on the profile fresh
  });
  ipcMain.on('playtime-pause', (e, { paused } = {}) => {
    if (paused && playSession.key) flushPlaytime();
    if (discord && discord.ready) {
      // Paused shows as idle-style presence without killing the game details.
      discord.setActivity(buildActivity({
        title: currentRom ? currentRom.title : undefined,
        state: 'paused',
      }));
    }
  });
  ipcMain.handle('playtime-get', (e, key) => ({ key, total: getTime(readSettings(), key) }));
  ipcMain.handle('presence-toggle', (e, on) => {
    discordActivityOn = !!on;
    writeSetting('discordRpc', discordActivityOn);
    if (discordActivityOn) { ensureDiscord(); pushPresence(); }
    else if (discord) { discord.clearActivity(); discord.destroy(); stopDiscordRetry(); }
    return { on: discordActivityOn };
  });
  ipcMain.handle('presence-status', () => ({ on: discordActivityOn, connected: !!(discord && discord.sock && discord.ready) }));

  buildMenu();
  createWindow();

  // Local-multiplayer hub: this instance may BE the player-2 window.
  // Auto-load the ROM, then auto-raise the link cable per the flags. The
  // renderer drives ROM loading, so this hand-off happens over IPC.
  const hub = parseHubArgs(process.argv);
  if (hub.second) {
    win.webContents.once('did-finish-load', () => {
      // This window IS player 2: load the ROM through the normal main-process
      // path (builds the full rom-opened payload), then raise the cable.
      if (hub.rom) loadRomFromPath(hub.rom);
      if (hub.role === 'host') {
        getLink().host(hub.port, { lan: false }).catch(() => { /* status shows it */ });
      } else if (hub.role === 'join') {
        // small delay: the ROM must be loading before the first serial bytes
        setTimeout(() => { getLink().join(hub.port || 8765, '127.0.0.1').catch(() => {}); }, 1500);
      }
    });
  }

  // Auto-update: silent background checks; explicit check via Help menu.
  updater.start((text) => send('update-status', text));
  ipcMain.handle('check-for-updates', () => updater.checkExplicit());

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });

app.on('before-quit', () => {
  updater.stop();
  if (link) link.dispose();
  flushPlaytime(); // bank the last partial tick before the process goes away
  if (discord) { try { discord.clearActivity(); discord.destroy(); } catch { /* pipe may be gone */ } }
  stopDiscordRetry();
  send('app-quitting');
});
