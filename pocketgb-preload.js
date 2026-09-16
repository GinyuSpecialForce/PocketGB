// PocketGB — preload: context-isolated IPC bridge
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pocketgb', {
  openRomDialog: () => ipcRenderer.send('open-rom-dialog'),
  onRomOpened: (cb) => ipcRenderer.on('rom-opened', (e, info) => cb(info)),
  writeSav: (path, u8) => ipcRenderer.send('write-sav', path, u8),
  readSav: (path) => ipcRenderer.invoke('read-sav', path),
  writeState: (path, u8) => ipcRenderer.send('write-state', path, u8),
  readState: (path) => ipcRenderer.invoke('read-state', path),
  listStates: (key) => ipcRenderer.invoke('list-states', key),
  onReset: (cb) => ipcRenderer.on('reset', () => cb()),
  onPause: (cb) => ipcRenderer.on('pause', (e, paused) => cb(paused)),
  onMute: (cb) => ipcRenderer.on('mute', (e, muted) => cb(muted)),
  onSaveState: (cb) => ipcRenderer.on('save-state', (e, slot) => cb(slot)),
  onLoadState: (cb) => ipcRenderer.on('load-state', (e, slot) => cb(slot)),
  onAppQuitting: (cb) => ipcRenderer.on('app-quitting', () => cb()),
  setSetting: (k, v) => ipcRenderer.send('set-setting', k, v),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openRomPath: (p) => ipcRenderer.send('open-rom-path', p),
  saveFile: (name, b64) => ipcRenderer.invoke('save-file', name, b64),
  linkHost: (port) => ipcRenderer.invoke('link-host', port),
  linkJoin: (port) => ipcRenderer.invoke('link-join', port),
  linkStop: () => ipcRenderer.invoke('link-stop'),
  linkSend: (b) => ipcRenderer.send('link-send', b),
  onLinkData: (cb) => ipcRenderer.on('link-data', (e, u8) => cb(u8)),
  onLinkStatus: (cb) => ipcRenderer.on('link-status', (e, st) => cb(st)),
  onLinkHosting: (cb) => ipcRenderer.on('link-hosting', (e, port) => cb(port)),
  onLinkError: (cb) => ipcRenderer.on('link-error', (e, msg) => cb(msg)),
});
