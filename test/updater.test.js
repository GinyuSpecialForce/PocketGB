'use strict';
// Tests for the git-based auto-updater (src/main/updater.js). Electron is never
// required — the git engine takes an injected runner, and the "origin" side is
// a real scratch repo so the whole fetch / ff-merge / deps pipeline is exercised.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeGitEngine, needsNpmInstall, upstreamRefFor } = require('../src/main/updater');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pgb-upd-')); }

// origin repo with one commit; work = a clone of origin
function makeOriginAndClone() {
  const origin = tmpdir();
  git(origin, 'init', '-q');
  git(origin, 'config', 'user.email', 't@t');
  git(origin, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(origin, 'app.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  fs.writeFileSync(path.join(origin, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'init');
  const work = tmpdir();
  git(work, 'clone', '-q', origin + '/.git', '.');
  git(work, 'config', 'user.email', 'w@t');
  git(work, 'config', 'user.name', 'w');
  return { origin, work };
}

// commit new file contents on origin's main branch
function commitUpstream(origin, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(origin, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'upstream commit');
}

function engineFor(work, log) {
  return makeGitEngine({
    cwd: work,
    runGit: async (args) => {
      if (log) log.push(['git', ...args]);
      try {
        return execFileSync('git', args, { cwd: work, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      } catch (e) {
        throw new Error(String(e.stderr || e.message));
      }
    },
    runNpm: async () => 'npm-ok',
  });
}

// ---------- pure helpers ----------

test('needsNpmInstall triggers only on dependency files', () => {
  assert.strictEqual(needsNpmInstall(['README.md', 'src/core/cpu.js']), false);
  assert.strictEqual(needsNpmInstall(['package.json']), true);
  assert.strictEqual(needsNpmInstall(['src/a.js', 'package-lock.json']), true);
  assert.strictEqual(needsNpmInstall([]), false);
  assert.strictEqual(needsNpmInstall(null), false);
});

test('upstreamRefFor prefers origin/<branch> and falls back safely', () => {
  assert.strictEqual(upstreamRefFor({ branch: 'main', originBranch: 'main' }), 'origin/main');
  assert.strictEqual(upstreamRefFor({ branch: 'main', originBranch: null, hasOriginHead: true }), 'origin/HEAD');
  assert.strictEqual(upstreamRefFor({ branch: null }), null);
  assert.strictEqual(upstreamRefFor(null), null);
});

// ---------- git engine against real scratch repos ----------

test('up-to-date clone reports no update', async () => {
  const { origin, work } = makeOriginAndClone();
  assert.ok(origin && work);
  const eng = engineFor(work);
  const res = await eng.check();
  assert.strictEqual(res.status, 'up-to-date');
});

test('upstream commits are detected and applied via ff merge', async () => {
  const { origin, work } = makeOriginAndClone();
  commitUpstream(origin, { 'src/core/cpu.js': '// faster\n' });

  const eng = engineFor(work);
  const res = await eng.check();
  assert.strictEqual(res.status, 'available');
  assert.ok(res.newHead && res.ref === 'origin/main' && res.oldHead);

  const applied = await eng.apply(res);
  assert.strictEqual(applied.installed, true);
  assert.strictEqual(applied.restartedDeps, false, 'no dependency files changed');
  const head = git(work, 'rev-parse', 'HEAD').trim();
  assert.strictEqual(head, res.newHead, 'work repo fast-forwarded');
  assert.strictEqual(fs.readFileSync(path.join(work, 'src/core/cpu.js'), 'utf8'), '// faster\n');
});

test('dependency changes schedule npm install', async () => {
  const { origin, work } = makeOriginAndClone();
  commitUpstream(origin, { 'package.json': JSON.stringify({ name: 'x', version: '1.1.0' }) });

  const eng = engineFor(work);
  const res = await eng.check();
  assert.strictEqual(res.status, 'available');
  const applied = await eng.apply(res);
  assert.strictEqual(applied.restartedDeps, true);
});

test('diverged local work is reported, never overwritten', async () => {
  const { origin, work } = makeOriginAndClone();
  commitUpstream(origin, { 'app.js': 'upstream\n' });
  // local commit on top of the old base → diverged
  fs.writeFileSync(path.join(work, 'local.txt'), 'mine\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'local work');

  const eng = engineFor(work);
  const res = await eng.check();
  assert.strictEqual(res.status, 'diverged');
  const headBefore = git(work, 'rev-parse', 'HEAD').trim();
  await assert.rejects(() => eng.apply(res), /nothing to apply/);
  assert.strictEqual(git(work, 'rev-parse', 'HEAD').trim(), headBefore, 'local commit untouched');
});

test('uncommitted local changes survive an ff update', async () => {
  const { origin, work } = makeOriginAndClone();
  commitUpstream(origin, { 'src/other.js': '// upstream\n' });
  const dirty = 'my uncommitted edits\n';
  fs.writeFileSync(path.join(work, 'app.js'), dirty);

  const eng = engineFor(work);
  const res = await eng.check();
  assert.strictEqual(res.status, 'available');
  await eng.apply(res);
  assert.strictEqual(fs.readFileSync(path.join(work, 'app.js'), 'utf8'), dirty, 'dirty file untouched');
  assert.ok(fs.existsSync(path.join(work, 'src/other.js')), 'update content landed');
});

test('non-git folder is rejected with a clear error', async () => {
  const dir = tmpdir();
  const eng = makeGitEngine({ cwd: dir });
  await assert.rejects(() => eng.check(), /not a git clone/);
});
