'use strict';
// Tests for the local multiplayer hub flags: the spawned player-2 window
// parses its argv into an auto-load/auto-link plan, and spawn args never leak
// stale --pgb- flags between launches.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseHubArgs, buildSpawnArgs } = require('../src/main/hub');

test('parseHubArgs: plain launch is not the second player', () => {
  const p = parseHubArgs(['/Applications/PocketGB.app', '.']);
  assert.strictEqual(p.second, false);
  assert.strictEqual(p.rom, null);
  assert.strictEqual(p.role, null);
});

test('parseHubArgs: reads second-player flags', () => {
  const p = parseHubArgs(['app', '--pgb-second', '--pgb-rom=/games/Tetris.gb', '--pgb-join=8765']);
  assert.strictEqual(p.second, true);
  assert.strictEqual(p.rom, '/games/Tetris.gb');
  assert.strictEqual(p.role, 'join');
  assert.strictEqual(p.port, 8765);
});

test('parseHubArgs: host with OS-assigned port 0', () => {
  const p = parseHubArgs(['app', '--pgb-second', '--pgb-host=0']);
  assert.strictEqual(p.second, true);
  assert.strictEqual(p.role, 'host');
  assert.strictEqual(p.port, 0);
});

test('parseHubArgs: malformed numbers fall back to 0 and stay parseable', () => {
  const p = parseHubArgs(['app', '--pgb-second', '--pgb-join=abc']);
  assert.strictEqual(p.role, 'join');
  assert.strictEqual(p.port, 0);
});

test('buildSpawnArgs: appends flags, strips stale ones from baseArgs', () => {
  const args = buildSpawnArgs({
    baseArgs: ['electron', '.', '--pgb-second', '--pgb-host=999'],
    rom: '/g/Mario.gb',
    role: 'join',
    port: 8765,
  });
  assert.strictEqual(args.filter((a) => a === '--pgb-second').length, 1, 'no duplicate second flag');
  assert.ok(!args.includes('--pgb-host=999'), 'stale host flag stripped');
  assert.deepStrictEqual(args[args.length - 3], '--pgb-second');
  assert.ok(args.includes('--pgb-rom=/g/Mario.gb'));
  assert.ok(args.includes('--pgb-join=8765'));
});

test('buildSpawnArgs: rom-less and role-less launches still mark second', () => {
  const args = buildSpawnArgs({ baseArgs: ['app'] });
  assert.deepStrictEqual(args, ['app', '--pgb-second']);
});
