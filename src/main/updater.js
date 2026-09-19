// PocketGB — auto-update (main process), dual-mode.
//
//   • Packaged install (DMG/NSIS): electron-updater against the release feed —
//     silent background download, installs on restart. Unchanged behavior.
//   • Git clone / source checkout: git-based updates — `git fetch origin`,
//     fast-forward-only merge onto the upstream branch (local work is NEVER
//     discarded; a diverged repo or a failing merge is reported, not forced),
//     `npm install` when the lockfile changed, then restart to apply.
//   • Neither (plain unpacked folder): update checks report why they can't run.
//
// The git engine is separated from Electron so tests can drive it against a
// scratch repository with an injected runner.
'use strict';

const { execFile } = require('child_process');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const FIRST_CHECK_MS = 30 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const NPM_TIMEOUT_MS = 5 * 60 * 1000;

// ---------- pure helpers (unit-tested) ----------

// Given a list of changed paths (old..new), decide whether dependencies must
// be reinstalled before the update is usable.
function needsNpmInstall(changedFiles) {
  if (!Array.isArray(changedFiles)) return false;
  return changedFiles.some((f) => f === 'package.json' || f === 'package-lock.json');
}

// Pick the upstream ref for the current HEAD state.
// state: { branch, hasOriginHead, originBranch }
function upstreamRefFor(state) {
  if (!state) return null;
  if (state.branch && state.originBranch) return `origin/${state.originBranch}`;
  if (state.branch && state.hasOriginHead) return 'origin/HEAD'; // detached-adjacent setups
  return null;
}

// ---------- git engine (cwd + runner injectable for tests) ----------

function makeGitEngine(opts = {}) {
  const cwd = opts.cwd;
  const runGit = opts.runGit || defaultRunGit;
  const runNpm = opts.runNpm || defaultRunNpm;
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  async function defaultRunGit(args) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').toString().trim();
          reject(new Error(msg || `git ${args[0]} failed`));
        } else resolve(stdout.toString());
      });
    });
  }
  async function defaultRunNpm(args) {
    return new Promise((resolve, reject) => {
      execFile(npmCmd, args, { cwd, timeout: NPM_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || '').toString().trim() || 'npm install failed'));
        else resolve(stdout.toString());
      });
    });
  }

  // Snapshot of the repo relevant to updating. Throws with a readable message
  // when the folder isn't a usable git clone.
  async function inspect() {
    try {
      await runGit(['rev-parse', '--is-inside-work-tree']);
    } catch (e) {
      const err = new Error('not a git clone — auto-update unavailable');
      err.code = 'NOT_A_REPO';
      throw err;
    }
    const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const detached = branch === 'HEAD';
    let hasOrigin = false;
    try {
      const remotes = (await runGit(['remote'])).trim().split('\n').filter(Boolean);
      hasOrigin = remotes.includes('origin');
    } catch { hasOrigin = false; }
    if (!hasOrigin) {
      const err = new Error('no origin remote — auto-update unavailable');
      err.code = 'NO_ORIGIN';
      throw err;
    }
    // Prefer origin/<same-branch>; fall back to origin/HEAD.
    let originBranch = null;
    if (!detached) {
      try {
        await runGit(['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
        originBranch = branch;
      } catch { originBranch = null; }
    }
    return { branch, detached, originBranch, hasOriginHead: true };
  }

  // Fetch and compare. Returns:
  //   { status: 'up-to-date' } |
  //   { status: 'available', ref, newHead, short } |
  //   { status: 'diverged' } |
  //   { status: 'detached' }
  async function check() {
    const info = await inspect();
    if (info.detached && !info.originBranch) return { status: 'detached' };
    const ref = upstreamRefFor(info);
    if (!ref) return { status: 'detached' };
    await runGit(['fetch', '--quiet', 'origin']);
    const local = (await runGit(['rev-parse', 'HEAD'])).trim();
    const remote = (await runGit(['rev-parse', ref])).trim();
    if (local === remote) return { status: 'up-to-date' };
    // Only offer a fast-forward; a diverged repo stays user-owned.
    try {
      await runGit(['merge-base', '--is-ancestor', 'HEAD', ref]);
    } catch {
      return { status: 'diverged', ref, local, remote };
    }
    const short = (await runGit(['rev-parse', '--short', remote])).trim();
    return { status: 'available', ref, newHead: remote, short, oldHead: local };
  }

  // Apply a checked update: ff-only merge, npm install when deps changed.
  // Returns { installed: true, short, restartedDeps } or throws.
  async function apply(checkResult, onProgress = () => {}) {
    if (!checkResult || checkResult.status !== 'available') {
      throw new Error('nothing to apply');
    }
    onProgress(`updating from ${checkResult.ref}…`);
    await runGit(['merge', '--ff-only', checkResult.ref]);
    const changed = (await runGit(['diff', '--name-only', `${checkResult.oldHead}..${checkResult.newHead}`]))
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const deps = needsNpmInstall(changed);
    if (deps) {
      onProgress('dependencies changed — running npm install…');
      await runNpm(['install', '--no-audit', '--no-fund']);
    }
    return { installed: true, short: checkResult.short, restartedDeps: deps };
  }

  return { inspect, check, apply };
}

// ---------- Electron wiring ----------

let onStatus = () => {};
let initialized = false;
let busy = false;
let firstTimer = null;
let intervalTimer = null;
let mode = 'none'; // 'packaged' | 'git' | 'none'
let engine = null;

function report(text) {
  try { onStatus(text); } catch { /* renderer gone */ }
}

function repoRoot() {
  const { app } = require('electron');
  // Unpackaged run from a clone: app.getAppPath() is the folder with package.json.
  return app.getAppPath();
}

async function checkOnce({ explicit }) {
  if (busy) return { busy: true };
  busy = true;
  try {
    report('checking for updates…');
    const res = await engine.check();
    if (res.status === 'up-to-date') {
      report('up to date');
      if (explicit) await inform('PocketGB is up to date', 'You are running the latest version from origin.');
      return res;
    }
    if (res.status === 'detached') {
      const msg = 'HEAD is detached (or no upstream branch) — update check skipped';
      report(msg);
      if (explicit) await inform('Cannot check for updates', msg);
      return res;
    }
    if (res.status === 'diverged') {
      const msg = 'local commits diverged from origin — pull manually to update';
      report(msg);
      if (explicit) await inform('Update skipped', `${msg}\n\nPocketGB never discards local work.`);
      return res;
    }
    // available
    const done = await engine.apply(res, (t) => report(t));
    const msg = done.restartedDeps
      ? `update ${done.short} installed (+npm install) — restart to apply`
      : `update ${done.short} installed — restart to apply`;
    report(msg);
    if (explicit) {
      const choice = await restartDialog(`Version ${done.short} is ready`, 'Restart PocketGB now to run the update?');
      if (choice) restartNow();
    }
    return res;
  } catch (err) {
    console.error('auto-update error:', err && err.message ? err.message : err);
    report(`update check failed: ${err && err.message ? err.message : 'error'}`);
    if (explicit) await inform('Update failed', err && err.message ? err.message : String(err));
    return { error: true };
  } finally {
    busy = false;
  }
}

// --- dialogs (lazy electron; tests never reach these) ---
async function inform(title, detail) {
  try {
    const { dialog } = require('electron');
    await dialog.showMessageBox({ type: 'info', title: 'PocketGB', message: title, detail, buttons: ['OK'] });
  } catch { /* no electron (tests) */ }
}
async function restartDialog(title, detail) {
  try {
    const { dialog } = require('electron');
    const { response } = await dialog.showMessageBox({
      type: 'info', title: 'PocketGB', message: title, detail,
      buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
    });
    return response === 0;
  } catch { return false; }
}
function restartNow() {
  try {
    const { app } = require('electron');
    app.relaunch();
    app.exit(0);
  } catch { /* no electron */ }
}

// ---------- public API (unchanged shape) ----------

function detectMode() {
  try {
    const { app } = require('electron');
    if (app.isPackaged) return 'packaged';
  } catch { /* tests: no electron */ }
  try {
    const fs = require('fs');
    const path = require('path');
    if (fs.existsSync(path.join(repoRoot(), '.git'))) return 'git';
  } catch { /* fs unavailable */ }
  return 'none';
}

function start(onStatusCb) {
  if (typeof onStatusCb === 'function') onStatus = onStatusCb;
  if (initialized) return;
  initialized = true;
  mode = detectMode();

  if (mode === 'packaged') {
    bindPackagedUpdater();
    firstTimer = setTimeout(() => packagedCheck().catch(() => {}), FIRST_CHECK_MS);
    intervalTimer = setInterval(() => packagedCheck().catch(() => {}), CHECK_INTERVAL_MS);
    return;
  }
  if (mode === 'git') {
    engine = makeGitEngine({ cwd: repoRoot() });
    firstTimer = setTimeout(() => { checkOnce({ explicit: false }); }, FIRST_CHECK_MS);
    intervalTimer = setInterval(() => { checkOnce({ explicit: false }); }, CHECK_INTERVAL_MS);
    return;
  }
  // 'none': checks will explain why they can't run.
}

// Menu / renderer entry point.
function checkExplicit() {
  if (mode === 'packaged') {
    if (!app_isPackagedSafe()) return { disabled: true };
    explicitCheck = true;
    require('electron').autoUpdater.checkForUpdates().catch(() => { explicitCheck = false; });
    return { started: true, mode: 'packaged' };
  }
  if (mode === 'git') {
    checkOnce({ explicit: true });
    return { started: true, mode: 'git' };
  }
  inform('Auto-update unavailable', 'This copy is neither an installed build nor a git clone.\nClone the repository with git to enable self-updating.');
  return { disabled: true, mode: 'none' };
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (intervalTimer) clearInterval(intervalTimer);
}

// ---------- packaged-mode internals (electron-updater, unchanged behavior) ----------

let explicitCheck = false;
let lastPercentBucket = -1;

function app_isPackagedSafe() {
  try { return require('electron').app.isPackaged; } catch { return false; }
}

function packagedCheck() {
  return require('electron').autoUpdater.checkForUpdates();
}

function bindPackagedUpdater() {
  const { app, autoUpdater, dialog } = require('electron');

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => report('checking for updates…'));
  autoUpdater.on('update-not-available', () => {
    report('up to date');
    if (explicitCheck) {
      explicitCheck = false;
      dialog.showMessageBox({
        type: 'info', title: 'PocketGB',
        message: 'PocketGB is up to date',
        detail: `Version ${app.getVersion()} is the latest release.`,
        buttons: ['OK'],
      }).catch(() => {});
    }
  });
  autoUpdater.on('update-available', (info) => {
    report(`downloading update ${info && info.version ? info.version : ''}…`.replace('  ', ' '));
    lastPercentBucket = -1;
  });
  autoUpdater.on('download-progress', (p) => {
    const pct = (p && p.percent) || 0;
    const bucket = Math.min(90, Math.floor(pct / 10) * 10);
    if (bucket > lastPercentBucket) { lastPercentBucket = bucket; report(`downloading update… ${bucket}%+`); }
  });
  autoUpdater.on('update-downloaded', (info) => {
    const v = (info && info.version) || '';
    report(`update ${v} ready — installs on restart`);
    if (explicitCheck) {
      explicitCheck = false;
      dialog.showMessageBox({
        type: 'info', title: 'PocketGB',
        message: `Version ${v} is ready to install`,
        detail: 'Restart PocketGB to apply the update. It will also install automatically the next time you quit.',
        buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
      }).then(({ response }) => { if (response === 0) setImmediate(() => autoUpdater.quitAndInstall()); }).catch(() => {});
    }
  });
  autoUpdater.on('error', (err) => {
    explicitCheck = false;
    console.error('auto-update error:', err && err.message ? err.message : err);
    report('update check failed');
  });
}

module.exports = {
  start, stop, checkExplicit,
  // testable core
  makeGitEngine, needsNpmInstall, upstreamRefFor,
  get mode() { return mode; },
};
