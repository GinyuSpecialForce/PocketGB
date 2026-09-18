// PocketGB — auto-update (main process)
//
// Wraps electron-updater with a conservative policy:
//   • background check 30 s after launch, then every 4 h — silent download,
//     installs on next restart, no prompts.
//   • explicit check (Help → Check for Updates…) — prompts once the download
//     finishes with a Restart Now / Later choice.
//   • every state change is reported via onStatus() so the renderer's status
//     line can mirror it; background errors never open dialogs.
// In unpackaged (dev) runs every call is a harmless no-op: there is no
// app-update.yml and no feed to talk to.
'use strict';

const { app, autoUpdater, dialog } = require('electron');
const { ipcMain } = require('electron');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const FIRST_CHECK_MS = 30 * 1000;

let onStatus = () => {};
let initialized = false;
let firstTimer = null;
let intervalTimer = null;
let explicitCheck = false; // true while a user-initiated check is in flight
let lastPercentBucket = -1;

function updateAvailable() { return autoUpdater.updateAvailable === true; }

function report(text) {
  try { onStatus(text); } catch { /* renderer gone */ }
}

function bind() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null; // we do our own reporting

  autoUpdater.on('checking-for-update', () => report('checking for updates…'));

  autoUpdater.on('update-not-available', () => {
    report('up to date');
    if (explicitCheck) {
      explicitCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'PocketGB',
        message: 'PocketGB is up to date',
        detail: `Version ${app.getVersion()} is the latest release.`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-available', (info) => {
    report(`downloading update ${info && info.version ? info.version : ''}…`.replace('  ', ' '));
    lastPercentBucket = -1;
  });

  autoUpdater.on('download-progress', (p) => {
    // Report in 10% buckets so the status line doesn't spam IPC.
    const pct = (p && p.percent) || 0;
    const bucket = Math.min(90, Math.floor(pct / 10) * 10);
    if (bucket > lastPercentBucket) {
      lastPercentBucket = bucket;
      report(`downloading update… ${bucket}%+`);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const v = (info && info.version) || '';
    report(`update ${v} ready — installs on restart`);
    if (explicitCheck) {
      explicitCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'PocketGB',
        message: `Version ${v} is ready to install`,
        detail: 'Restart PocketGB to apply the update. It will also install automatically the next time you quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
      }).catch(() => {});
    }
  });

  autoUpdater.on('error', (err) => {
    explicitCheck = false;
    console.error('auto-update error:', err && err.message ? err.message : err);
    report('update check failed');
    if (updateAvailable() === false) { /* nothing else to do */ }
  });
}

function start(onStatusCb) {
  if (typeof onStatusCb === 'function') onStatus = onStatusCb;
  if (initialized) return;
  initialized = true;
  bind();

  if (!app.isPackaged) return; // dev run: no feed, stay silent

  firstTimer = setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, FIRST_CHECK_MS);
  intervalTimer = setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, CHECK_INTERVAL_MS);
}

// Menu / renderer entry point: user-visible behavior.
function checkExplicit() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      title: 'PocketGB',
      message: 'Auto-update is disabled in development builds',
      detail: 'Updates are checked when you run an installed copy of PocketGB.',
      buttons: ['OK'],
    });
    return { disabled: true };
  }
  explicitCheck = true;
  autoUpdater.checkForUpdates().catch(() => { explicitCheck = false; });
  return { started: true };
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (intervalTimer) clearInterval(intervalTimer);
}

module.exports = { start, stop, checkExplicit };
