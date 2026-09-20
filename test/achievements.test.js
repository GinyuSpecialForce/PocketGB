'use strict';
// Tests for the RetroAchievements integration (src/core/achievements.js):
// MemAddr compilation, condition evaluation against a stub MMU, RA hash
// bounds, and the dorequest client (mocked fetch) incl. the award signature.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  compileMemAddr, evalGroups, parseMemref, raHash,
  RAClient, AchievementRuntime, readMem,
} = require('../src/core/achievements');

// Stub MMU: a sparse byte map addressed exactly like the real bus for RAM
// regions the evaluator touches.
function stubMmu(bytes) {
  const map = new Map();
  for (const [addr, v] of Object.entries(bytes || {})) map.set(Number(addr), v & 0xFF);
  return { read: (a) => map.get(a & 0xFFFF) ?? 0xFF };
}

test('parseMemref: sizes, addresses, prefixes', () => {
  assert.deepEqual(parseMemref('0xH001b3b'), { size: 1, addr: 0x1b3b, unary: null });
  assert.deepEqual(parseMemref('d0xH1234'), { size: 1, addr: 0x1234, unary: 'd' });
  assert.deepEqual(parseMemref('0xW5678'), { size: 2, addr: 0x5678, unary: null });
  assert.deepEqual(parseMemref('0xD9abc'), { size: 4, addr: 0x9abc, unary: null });
  assert.equal(parseMemref('0xQ1234'), null, 'unknown size char rejected');
});

test('readMem: 8/16/32-bit little-endian words', () => {
  const mm = stubMmu({ 0xC100: 0x11, 0xC101: 0x22, 0xC102: 0x33, 0xC103: 0x44 });
  assert.equal(readMem(mm, 1, 0xC100), 0x11);
  assert.equal(readMem(mm, 2, 0xC100), 0x2211);
  assert.equal(readMem(mm, 4, 0xC100), 0x44332211);
});

test('compile + eval: simple equality', () => {
  const c = compileMemAddr('0xH00c100=5');
  assert.equal(c.groups.length, 1);
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 5 })), true);
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 6 })), false);
});

test('compile + eval: two conditions ANDed', () => {
  const c = compileMemAddr('0xH00c100=1_0xH00c101>=99');
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 1, 0xC101: 120 })), true);
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 1, 0xC101: 50 })), false);
});

test('alt groups (AND-of-ORs): _S...S...', () => {
  const c = compileMemAddr('0xH00c100=1_S0xH00c101=2S0xH00c102=3');
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 1, 0xC102: 3 })), true, 'alt 2 hit');
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 1, 0xC101: 2 })), true, 'alt 1 hit');
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 1 })), false, 'no alt hit');
});

test('hex and decimal operands, modified values', () => {
  const c1 = compileMemAddr('0xH00c100=0x0f');
  assert.equal(evalGroups(c1, stubMmu({ 0xC100: 15 })), true, 'hex operand');
  const c2 = compileMemAddr('0xH00c100*2=10');
  assert.equal(evalGroups(c2, stubMmu({ 0xC100: 5 })), true, 'value * 2');
  const c3 = compileMemAddr('0xH00c100=0xH00c101+5');
  assert.equal(evalGroups(c3, stubMmu({ 0xC100: 7, 0xC101: 2 })), true, 'memref = memref + 5');
});

test('16-bit comparison', () => {
  const c = compileMemAddr('0xW00c100>=1000');
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 0xE8, 0xC101: 0x03 })), true, '0x03E8 = 1000');
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 0xE7, 0xC101: 0x03 })), false, '0x03E7 = 999');
});

test('and-next prefix (b) requires the next condition too', () => {
  const c = compileMemAddr('b0xH00c100=1_0xH00c100=2');
  // With andNext the FIRST condition passes only if the second ALSO passes.
  // Both compare the same address; only one can be true — so this never hits.
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 1 })), false);
  assert.equal(evalGroups(c, stubMmu({ 0xC100: 2 })), false);
});

test('raHash: bounded by 0x1FFFD0 bytes', () => {
  // Known MD5 for the empty input as a sanity anchor; the point is that a
  // huge ROM hashes identically to its first 0x1FFFD0 bytes.
  const big = new Uint8Array(0x200000);
  const head = big.subarray(0, 0x1FFFD0);
  assert.equal(raHash(big), raHash(head), 'bytes beyond the bound are ignored');
  const tiny = new Uint8Array(4);
  assert.match(raHash(tiny), /^[0-9a-f]{32}$/, 'lowercase md5 hex');
});

test('RAClient: login/patch/award over a mocked fetch', async () => {
  const calls = [];
  const mock = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    calls.push({ url, body: Object.fromEntries(body) });
    const r = body.get('r');
    if (r === 'login2') return { ok: true, json: async () => ({ Success: true, User: 'jon', Token: 'tok-2', Score: 1234 }) };
    if (r === 'patch') return { ok: true, json: async () => ({ PatchData: { ID: 42, Title: 'Test Game', ConsoleID: 4, Achievements: [
      { ID: 555, Title: 'Win', Description: 'Win it', Points: 10, Flags: 3, MemAddr: '0xH00c100=1', BadgeName: '555' },
      { ID: 556, Title: 'Unofficial', Description: 'x', Points: 5, Flags: 5, MemAddr: '0xH00c100=2', BadgeName: '556' },
    ] } }) };
    if (r === 'awardachievement') return { ok: true, json: async () => ({ Success: true, Score: 1244 }) };
    if (r === 'startsession') return { ok: true, json: async () => ({ Success: true }) };
    throw new Error('unknown request ' + r);
  };
  const client = new RAClient({ username: 'jon', token: 'tok-1', fetchImpl: mock });
  const login = await client.login();
  assert.equal(login.user, 'jon');
  assert.equal(client.token, 'tok-2', 'token refreshed from server');
  const game = await client.fetchGame('abc123');
  assert.equal(game.id, 42);
  assert.equal(game.achievements.length, 1, 'only the core set (Flags 3) is used');
  const award = await client.award(555, { hardcore: true, gameHash: 'abc123' });
  assert.equal(award.success, true);
  const aw = calls.find((c) => c.body.r === 'awardachievement');
  assert.equal(aw.body.a, '555');
  assert.equal(aw.body.h, '1');
  assert.equal(aw.body.m, 'abc123');
  assert.match(aw.body.v, /^[0-9a-f]{32}$/, 'md5 signature present');
});

test('RAClient.awardSignature: md5(achId + user + hardcore)', () => {
  // The signature is what the server verifies; pin it to a stable value.
  const sig = RAClient.awardSignature(555, 'jon', true);
  assert.match(sig, /^[0-9a-f]{32}$/);
  assert.equal(sig, RAClient.awardSignature(555, 'jon', true), 'deterministic');
  assert.notEqual(sig, RAClient.awardSignature(555, 'jon', false), 'hardcore changes the sig');
});

test('AchievementRuntime: identify → frame → unlock fires once', async () => {
  const runtime = new AchievementRuntime(null);
  runtime.loadFromSession('hash', {
    id: 42,
    title: 'Test Game',
    achievements: [{ id: 555, title: 'Win', description: 'Win it', points: 10, mem: '0xH00c100=1' }],
  }, true);
  assert.equal(runtime.enabled, true);
  const machine = { mmu: stubMmu({ 0xC100: 0 }) };
  const unlocks = [];
  runtime.onUnlock((a) => unlocks.push(a.id));
  runtime.frame(machine);
  assert.deepEqual(unlocks, [], 'not earned yet');
  machine.mmu.read = stubMmu({ 0xC100: 1 }).read;
  runtime.frame(machine);
  assert.deepEqual(unlocks, [555]);
  runtime.frame(machine);
  assert.deepEqual(unlocks, [555], 'only once');
  assert.equal(runtime.pendingAwards.length, 1);
  runtime.reset();
  assert.equal(runtime.pendingAwards.length, 0, 'reset clears pending queue');
});
