// PocketGB — Electron main process
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

let win = null;
let currentRom = null; // { name, path, dir }
let saveTimer = null;

const userDir = () => app.getPath('userData');
const savesDir = () => { const d = path.join(userDir(), 'saves'); fs.mkdirSync(d, { recursive: true }); return d; };
const statesDir = () => { const d = path.join(userDir(), 'states'); fs.mkdirSync(d, { recursive: true }); return d; };

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

function joinLink(port) {
  stopLink();
  const sock = net.connect(port || 8765, '127.0.0.1');
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
  win.loadFile('index.html');
  win.setMenuBarVisibility(true);
}

function openRomDialog() {
  dialog.showOpenDialog(win, {
    title: 'Open Game Boy ROM',
    filters: [{ name: 'Game Boy ROMs', extensions: ['gb', 'gbc', 'bin', 'rom'] }],
    properties: ['openFile'],
  }).then(({ canceled, filePaths }) => {
    if (!canceled && filePaths[0]) loadRomFromPath(filePaths[0]);
  });
}

function loadRomFromPath(romPath) {
  try {
    const data = fs.readFileSync(romPath);
    if (data.length < 0x150) throw new Error('File too small to be a Game Boy ROM');
    const name = path.basename(romPath);
    const title = data.slice(0x134, 0x143).toString('latin1').replace(/\0+$/g, '').trim() || name;
    currentRom = { name, path: romPath, dir: path.dirname(romPath), title };

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
    label: r.title || path.basename(r.path),
    click: () => loadRomFromPath(r.path),
  }));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' },
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  ipcMain.on('menu-refresh', () => buildMenu()); // refreshes Recent ROMs + slot state
  ipcMain.on('open-rom-dialog', () => openRomDialog());
  ipcMain.on('set-setting', (e, key, value) => {
    if (typeof key !== 'string' || key.length > 128) return;
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
  ipcMain.on('write-state', (e, statePath, u8) => {
    try {
      const p = path.isAbsolute(statePath) ? statePath : path.join(statesDir(), path.basename(statePath));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(u8));
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
  ipcMain.handle('list-states', (e, key) => {
    try {
      const d = statesDir();
      return fs.readdirSync(d).filter(f => f.startsWith(key) && f.endsWith('.state'))
        .map(f => ({ slot: parseInt(f.slice(key.length + 1), 10), file: f }));
    } catch { return []; }
  });

  // link cable
  ipcMain.handle('link-host', (e, port) => { startLinkServer(Number(port) || 0); return linkStatus(); });
  ipcMain.handle('link-join', (e, port) => { joinLink(Number(port) || 8765); return linkStatus(); });
  ipcMain.handle('link-stop', () => { stopLink(); return linkStatus(); });
  ipcMain.on('link-send', (e, b) => {
    if (linkSock && !linkSock.destroyed) linkSock.write(Buffer.from([b & 0xFF]));
  });

  buildMenu();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });

app.on('before-quit', () => {
  stopLink();
  send('app-quitting');
});
