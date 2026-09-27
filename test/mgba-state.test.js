'use strict';
// Tests for the mGBA save-state codec (src/core/mgba-state.js).
// Builds synthetic mGBA-style state PNGs (signature + IHDR + gbAs + IEND with
// a zlib-wrapped fixed-layout payload) and verifies decode/patch/rebuild.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  MgbaState, decodeState, rebuildStatePng, patchState,
  findPngChunk, replacePngChunk, busToPayload, describeLayout, LAYOUT,
} = require('../src/core/mgba-state');

// ---- synthetic state PNG builder -------------------------------------------
// CRC32 (PNG polynomial, no table — fine for test-sized data).
function crc32(bytes) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = (crc ^ bytes[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const n = data.length;
  out[0] = (n >>> 24) & 255; out[1] = (n >>> 16) & 255; out[2] = (n >>> 8) & 255; out[3] = n & 255;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + n));
  out[8 + n] = (crc >>> 24) & 255; out[9 + n] = (crc >>> 16) & 255; out[10 + n] = (crc >>> 8) & 255; out[11 + n] = crc & 255;
  return out;
}
// A valid-enough PNG: signature, tiny IHDR, the zipped gbAs payload, IEND.
async function makeStatePng(ewramFill = 0x11, iwramFill = 0x22) {
  const total = LAYOUT.total;
  const payload = new Uint8Array(total);
  payload.fill(ewramFill, LAYOUT.ewram.at, LAYOUT.ewram.at + LAYOUT.ewram.size);
  payload.fill(iwramFill, LAYOUT.iwram.at, LAYOUT.iwram.at + LAYOUT.iwram.size);
  const zip = await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = chunk('IHDR', new Uint8Array(13));
  const gbAs = chunk('gbAs', new Uint8Array(zip));
  const iend = chunk('IEND', new Uint8Array(0));
  const png = new Uint8Array(sig.length + ihdr.length + gbAs.length + iend.length);
  let o = 0;
  for (const c of [sig, ihdr, gbAs, iend]) { png.set(c, o); o += c.length; }
  return png;
}

test('findPngChunk walks chunks and replacePngChunk swaps data in place', () => {
  const png = new Uint8Array(8);
  png.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const a = chunk('aaAA', new Uint8Array([9]));
  const b = chunk('gbAs', data);
  const full = new Uint8Array(8 + a.length + b.length);
  full.set(png, 0); full.set(a, 8); full.set(b, 8 + a.length);
  const c = findPngChunk(full, 'gbAs');
  assert.ok(c, 'found gbAs');
  assert.strictEqual(c.len, 5);
  assert.deepStrictEqual(Array.from(full.subarray(c.off, c.off + 5)), [1, 2, 3, 4, 5]);
  assert.strictEqual(findPngChunk(full, 'zzZZ'), null);
  // replace: same total length, data swapped, other chunk untouched
  const out = replacePngChunk(full, 'gbAs', new Uint8Array([7, 8]));
  assert.strictEqual(out.length, full.length - 3);
  const c2 = findPngChunk(out, 'gbAs');
  assert.deepStrictEqual(Array.from(out.subarray(c2.off, c2.off + 2)), [7, 8]);
  const ca = findPngChunk(out, 'aaAA');
  assert.strictEqual(out[ca.off], 9);
  // corrupt length → null (walk bails safely)
  const bad = Uint8Array.from(full);
  bad[8] = 0x7F; bad[9] = 0xFF; bad[10] = 0xFF; bad[11] = 0xFF; // huge aaAA length
  assert.strictEqual(findPngChunk(bad, 'gbAs'), null);
});

test('decodeState reads EWRAM/IWRAM windows; busToPayload decodes the bus map', async () => {
  const png = await makeStatePng(0x11, 0x22);
  const st = await decodeState(png);
  assert.ok(st instanceof MgbaState);
  assert.strictEqual(st.payload.length, LAYOUT.total);
  assert.strictEqual(st.ewram.length, LAYOUT.ewram.size);
  assert.strictEqual(st.iwram.length, LAYOUT.iwram.size);
  assert.strictEqual(st.ewram[0x5000], 0x11);
  assert.strictEqual(st.iwram[0x1FF0], 0x22);
  // bus decode: exact + mirror handling (mirrors repeat the region every
  // size bytes inside 0x02FFFFFF / 0x03FFFFFF, like the real bus)
  assert.strictEqual(busToPayload(0x02000000), LAYOUT.ewram.at);
  assert.strictEqual(busToPayload(0x02035000), LAYOUT.ewram.at + 0x35000);
  assert.strictEqual(busToPayload(0x03001FF0), LAYOUT.iwram.at + 0x1FF0);
  assert.strictEqual(st.readBus(0x02035000), 0x11);
  assert.strictEqual(st.readBus(0x02075000), 0x11, 'EWRAM mirror alias +0x40000');
  assert.strictEqual(st.readBus(0x03009FF0), 0x22, 'IWRAM mirror alias +0x8000');
  assert.strictEqual(st.readBus(0x04000000), null, 'I/O not in a scan window');
  assert.strictEqual(st.readBus(0x03008000), 0x22, '0x03008000 wraps to IWRAM start under the mirror');
  assert.strictEqual(st.readBus(0x03008000 + 0x100), 0x22, 'inside the mirror: wraps to IWRAM+0x100');
  assert.strictEqual(st.readBus(0x09035000), null, 'ROM mirror territory is not RAM');
});

test('writeBus writes through mirrors; MgbaState.scannable gates addresses', async () => {
  const st = new MgbaState(new Uint8Array(LAYOUT.total));
  st.writeBus(0x02000010, 0xAB);
  assert.strictEqual(st.ewram[0x10], 0xAB);
  assert.strictEqual(st.readBus(0x02040010), 0xAB, 'EWRAM mirror alias sees the write');
  st.writeBus(0x04000208, 0x1); // I/O: silently ignored (no scan window)
  assert.strictEqual(st.readBus(0x04000208), null);
  assert.strictEqual(MgbaState.scannable(0x02000000), true);
  assert.strictEqual(MgbaState.scannable(0x03007FFF), true);
  assert.strictEqual(MgbaState.scannable(0x05000000), false);
});

test('patchState round-trips: decode → mutate → rebuild → decode', async () => {
  const png = await makeStatePng(0, 0);
  const out = await patchState(png, (st) => {
    st.ewram[0x1234] = 0x5A;
    st.writeBus(0x03000100, 0x3C);
  });
  assert.ok(out.length > 8, 'rebuilt PNG bytes');
  const st2 = await decodeState(out);
  assert.strictEqual(st2.ewram[0x1234], 0x5A, 'EWRAM patch persisted through rebuild');
  assert.strictEqual(st2.readBus(0x03000100), 0x3C, 'IWRAM bus patch persisted');
  // original png untouched (patchState is not in-place)
  const st0 = await decodeState(png);
  assert.strictEqual(st0.ewram[0x1234], 0);
  // rebuild around an explicitly decoded state
  const st3 = await decodeState(out);
  st3.ewram[0x1235] = 0xEE;
  const out2 = await rebuildStatePng(out, st3);
  assert.strictEqual((await decodeState(out2)).ewram[0x1235], 0xEE);
});

test('describeLayout validates the fixed layout; decode rejects wrong sizes', async () => {
  const ok = describeLayout(LAYOUT.total);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(describeLayout(1234).ok, false);
  await assert.rejects(() => decodeState(new Uint8Array(64)), /gbAs/);
  await assert.rejects(async () => { new MgbaState(new Uint8Array(1000)); }, /unexpected state size/);
});
