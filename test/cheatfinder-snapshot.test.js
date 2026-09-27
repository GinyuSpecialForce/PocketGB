'use strict';
// Snapshot-mode tests for CheatFinder: the GBA stock-core path where scans
// read decoded save states (see mgba-state.js) instead of live RAM. Uses a
// synthetic state PNG (same builder idea as mgba-state.test.js) and async
// search/narrow/promote — mirroring the real flow through app.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { CheatFinder } = require('../src/core/cheats');
const { decodeState, LAYOUT } = require('../src/core/mgba-state');

// Synthetic state PNG with a controllable EWRAM byte at bus 0x02000100.
const MARK = 0x02000100; // → payload EWRAM base + 0x100
async function makeStatePng(ewByte) {
  const payload = new Uint8Array(LAYOUT.total);
  const off = LAYOUT.ewram.at + 0x100;
  payload[off] = ewByte;
  payload[off + 1] = 0x99 + (ewByte & 3); // moves with MARK: exercises changed/eq/gt together
  payload[LAYOUT.iwram.at + 0x20] = 0x77; // an IWRAM byte, constant across states
  const zip = await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const mk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const n = data.length;
    out[0] = (n >>> 24) & 255; out[1] = (n >>> 16) & 255; out[2] = (n >>> 8) & 255; out[3] = n & 255;
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  };
  const ihdr = mk('IHDR', new Uint8Array(13));
  const gbAs = mk('gbAs', new Uint8Array(zip));
  const iend = mk('IEND', new Uint8Array(0));
  const png = new Uint8Array(8 + ihdr.length + gbAs.length + iend.length);
  png.set(sig, 0); let o = 8;
  for (const c of [ihdr, gbAs, iend]) { png.set(c, o); o += c.length; }
  return png;
}

// The app's snapshot provider/reader wiring (mirrors app.js retargetFinder).
function snapshotFinder(states) {
  let i = 0;
  const f = new CheatFinder(() => null);
  f.snapshotMode = true;
  f.addressProvider = () => new Uint32Array([0x02000000, MARK, 0x02000101, 0x03000020]);
  f.snapshotProvider = async () => decodeState(states[Math.min(i++, states.length - 1)]);
  f.snapshotReader = (state, addr) => state.readBus(addr);
  return f;
}

test('snapshot search finds the value at EWRAM/IWRAM bus addresses', async () => {
  const f = snapshotFinder([await makeStatePng(42)]);
  const n = await f.search(42);
  assert.strictEqual(n, 1);
  assert.ok(f.candidates.has(MARK));
  assert.strictEqual(f.candidates.get(MARK), 42);
  assert.strictEqual(f.snapshot.ewram[0x100], 42, 'last decoded state is kept');
});

test('snapshot narrow: changed / unchanged / eq / gt with fresh states', async () => {
  const states = [await makeStatePng(10), await makeStatePng(25), await makeStatePng(25)];
  const f = snapshotFinder(states);
  await f.search(null);
  assert.strictEqual(f.candidates.size, 4, 'unknown init takes the whole map');
  assert.strictEqual(await f.narrow({ op: 'changed' }), 2, 'MARK and MARK+1 changed');
  assert.strictEqual(await f.narrow({ op: 'unchanged' }), 2, 'second state identical');
  assert.strictEqual(await f.narrow({ op: 'gt', value: 20 }), 2);
  assert.ok(f.candidates.has(MARK) && f.candidates.has(MARK + 1));
  assert.strictEqual(await f.narrow({ op: 'eq', value: 25 }), 1, 'only MARK is 25 (its neighbor moved with it)');
  assert.strictEqual(await f.narrow({ op: 'eq', value: 99 }), 0, 'filters can empty the set');
});

test('snapshot candidates are stored under unmirrored bus addresses', async () => {
  const f = snapshotFinder([await makeStatePng(7)]);
  await f.search(7);
  assert.ok(f.candidates.has(0x02000100), 'exact bus address');
  assert.ok(!f.candidates.has(0x0A000100), 'no mirror alias keys');
  assert.ok(!f.candidates.has(0x0A001010), 'mirror of MARK+1 absent too');
});

test('snapshot read() serves the last decoded state; freeze builds a VBA code', async () => {
  const f = snapshotFinder([await makeStatePng(9)]);
  await f.search(9);
  assert.strictEqual(f.read(MARK), 9);
  assert.strictEqual(f.read(0x03000020), 0x77, 'IWRAM byte via the same state');
  assert.strictEqual(f.read(0x04000000), 0, 'unmapped bus address reads as 0');
  // freeze without an explicit value promotes at the snapshot's value
  // (a freeze-surface engine — same contract the app uses in live mode)
  const added = [];
  const r = f.freeze(MARK, { freeze: (addr, v) => added.push(`${addr.toString(16)}:${v.toString(16)}`) });
  assert.ok(!r.error);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0], '2000100:9');
  // explicit value wins over the snapshot
  const added2 = [];
  f.freeze(MARK, { freeze: (addr, v) => added2.push(`${addr.toString(16)}:${v.toString(16)}`) }, 0x63);
  assert.strictEqual(added2[0], '2000100:63');
});

test('reset clears the snapshot too', async () => {
  const f = snapshotFinder([await makeStatePng(1)]);
  await f.search(1);
  assert.ok(f.snapshot);
  f.reset();
  assert.strictEqual(f.snapshot, null);
  assert.strictEqual(f.read(MARK), 0);
});
