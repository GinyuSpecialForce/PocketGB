'use strict';
// Tests for the IPS/UPS/BPS patch engine in src/core/patch.js.
// Patches are constructed byte-by-byte here so the tests pin the exact
// format semantics (offsets, RLE, truncate, varints, CRC trailers).
// CRC32 correctness is anchored independently via the known vector for
// "123456789" → 0xCBF43926 (IEEE CRC-32 test vector).

const { test } = require('node:test');
const assert = require('node:assert');
const { applyPatch, isPatchPath, crc32 } = require('../src/core/patch');

test('crc32 matches the IEEE test vector', () => {
  const v = Uint8Array.from('123456789', (c) => c.charCodeAt(0));
  assert.strictEqual(crc32(v), 0xCBF43926);
});

// ---- IPS ----
test('IPS: literal chunk patches bytes in place', () => {
  const rom = Uint8Array.from({ length: 0x150 }, (_, i) => (i * 7) & 0xFF);
  const patch = new Uint8Array([
    0x50, 0x41, 0x54, 0x43, 0x48, // PATCH
    0x01, 0x00, 0x00, 0x04, 0xDE, 0xAD, 0xBE, 0xEF, // at 0x100 write 4 bytes
    0x45, 0x4F, 0x46, // EOF
  ]);
  const r = applyPatch(rom, patch);
  assert.ok(r.ok);
  assert.strictEqual(r.format, 'IPS');
  assert.deepStrictEqual([...r.bytes.slice(0x100, 0x104)], [0xDE, 0xAD, 0xBE, 0xEF]);
  assert.strictEqual(r.bytes[0x150 - 1], rom[0x150 - 1]); // untouched elsewhere
});

test('IPS: RLE chunk fills a run', () => {
  const rom = new Uint8Array(0x20);
  const patch = new Uint8Array([
    0x50, 0x41, 0x54, 0x43, 0x48,
    0x00, 0x08, 0x00, 0x00, // RLE marker (length 0)
    0x00, 0x0A, 0xAB, // run of 10 × 0xAB at offset 8
    0x45, 0x4F, 0x46,
  ]);
  const r = applyPatch(rom, patch);
  assert.ok(r.ok);
  for (let i = 8; i < 18; i++) assert.strictEqual(r.bytes[i], 0xAB);
  assert.strictEqual(r.bytes[7], 0);
  assert.strictEqual(r.bytes[18], 0);
});

test('IPS: chunk past ROM end grows the image with zeros', () => {
  const rom = new Uint8Array(0x10);
  const patch = new Uint8Array([
    0x50, 0x41, 0x54, 0x43, 0x48,
    0x00, 0x0F, 0x00, 0x06, 1, 2, 3, 4, 5, 6, // 6 bytes at offset 0x000F
    0x45, 0x4F, 0x46,
  ]);
  const r = applyPatch(rom, patch);
  assert.ok(r.ok);
  assert.strictEqual(r.bytes.length, 21);
  assert.deepStrictEqual([...r.bytes.slice(15)], [1, 2, 3, 4, 5, 6]);
});

// ---- UPS ----
function uVarint(value) {
  const out = [];
  do { let b = value & 0x7F; value >>>= 7; if (value) b |= 0x80; out.push(b); } while (value);
  return out;
}
function buildUps(src, blocks) {
  // blocks: [{ skip, xor: [bytes] }] — the XOR data is pre-XORed patch bytes
  const body = [];
  for (const { skip, xor } of blocks) {
    body.push(...uVarint(skip));
    body.push(...uVarint(xor.length));
    body.push(...xor);
  }
  // expected output, decoded per spec (for the output CRC)
  let outArr = [], inPtr = 0;
  for (const { skip, xor } of blocks) {
    for (let k = 0; k < skip; k++) { outArr.push(inPtr < src.length ? src[inPtr] : 0); inPtr++; }
    for (let k = 0; k < xor.length; k++) { outArr.push((inPtr < src.length ? src[inPtr] : 0) ^ xor[k]); inPtr++; }
  }
  const want = Uint8Array.from(outArr);
  const patchLen = 4 + body.length;
  const patch = new Uint8Array(patchLen + 12);
  patch.set([0x55, 0x50, 0x53, 0x31], 0);
  patch.set(body, 4);
  const dv = new DataView(patch.buffer);
  dv.setUint32(patchLen, crc32(src), true);                       // source CRC
  dv.setUint32(patchLen + 4, crc32(want), true);                  // target CRC
  dv.setUint32(patchLen + 8, crc32(patch.subarray(0, patchLen + 8)), true); // patch CRC
  return { patch, want };
}

test('UPS: xor blocks patch correctly and CRCs validate', () => {
  const src = Uint8Array.from({ length: 16 }, (_, i) => i * 3);
  const { patch, want } = buildUps(src, [
    { skip: 2, xor: [0xFF, 0xFF] },
    { skip: 4, xor: [0x01] },
  ]);
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.format, 'UPS');
  assert.strictEqual(r.bytes.length, want.length);
  assert.deepStrictEqual([...r.bytes], [...want]);
});

test('UPS: rejects wrong base ROM', () => {
  const src = new Uint8Array(8);
  const { patch } = buildUps(src, [{ skip: 1, xor: [0x00] }]);
  const other = new Uint8Array(8).fill(9);
  const r = applyPatch(other, patch);
  assert.ok(!r.ok);
});

// ---- BPS ----
// BPS varints (byuu convention) are base-128 with the HIGH BIT SET on the
// final byte (the opposite of UPS/protobuf). Signed offsets use
// (|x| << 1) | sign. Action word = ((len-1) << 2) | kind.
function bV(x) { const out = uVarint(x); out[out.length - 1] |= 0x80; return out; }
function bS(x) { return bV((Math.abs(x) << 1) | (x < 0 ? 1 : 0)); }
function buildBps(src, targetSize, actions) {
  // actions: {kind: 'srcRead'|'tgtRead'|'srcCopy'|'tgtCopy', len, data?, offset?}
  // offsets for copies are RELATIVE (decoded offset from current pointer)
  const kindOf = { srcRead: 0, tgtRead: 1, srcCopy: 2, tgtCopy: 3 };
  const body = [];
  body.push(...bV(src.length));
  body.push(...bV(targetSize));
  body.push(...bV(0)); // metadata
  // simulate to compute the target bytes for the output CRC
  const out = new Uint8Array(targetSize);
  let outPtr = 0, srcPtr = 0, tgtPtr = 0;
  for (const a of actions) {
    const kind = kindOf[a.kind];
    body.push(...bV(((a.len - 1) << 2) | kind));
    if (a.kind === 'tgtRead') body.push(...a.data);
    if (a.kind === 'srcCopy' || a.kind === 'tgtCopy') body.push(...bS(a.offset || 0));
    const len = a.len;
    if (kind === 0) { out.set(src.subarray(srcPtr, srcPtr + len), outPtr); srcPtr += len; outPtr += len; }
    else if (kind === 1) { out.set(a.data, outPtr); outPtr += len; }
    else if (kind === 2) { srcPtr += (a.offset || 0); out.set(src.subarray(srcPtr, srcPtr + len), outPtr); srcPtr += len; outPtr += len; }
    else { tgtPtr += (a.offset || 0); for (let k = 0; k < len; k++) out[outPtr + k] = out[tgtPtr + k]; tgtPtr += len; outPtr += len; }
  }
  const patchLen = 4 + body.length;
  const patch = new Uint8Array(patchLen + 12);
  patch.set([0x42, 0x50, 0x53, 0x31], 0);
  patch.set(body, 4);
  const dv = new DataView(patch.buffer);
  dv.setUint32(patchLen, crc32(src), true);
  dv.setUint32(patchLen + 4, crc32(out), true);
  dv.setUint32(patchLen + 8, crc32(patch.subarray(0, patchLen + 8)), true);
  return { patch, want: out };
}

test('BPS: targetRead + sourceRead + sourceCopy build the target', () => {
  const src = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xFF);
  const { patch, want } = buildBps(src, 20, [
    { kind: 'tgtRead', len: 3, data: [0xAA, 0xBB, 0xCC] },
    { kind: 'srcRead', len: 4 },
    { kind: 'srcCopy', len: 8, offset: 0 },
    { kind: 'tgtRead', len: 5, data: [1, 2, 3, 4, 5] },
  ]);
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.format, 'BPS');
  assert.deepStrictEqual([...r.bytes], [...want]);
  assert.strictEqual(r.bytes.length, 20);
});

test('BPS: rejects a base ROM with the wrong size or CRC', () => {
  const src = Uint8Array.from({ length: 16 }, (_, i) => i);
  const { patch } = buildBps(src, 16, [{ kind: 'srcRead', len: 16 }]);
  const wrong = new Uint8Array(17);
  const r = applyPatch(wrong, patch);
  assert.ok(!r.ok);
});

test('isPatchPath recognizes patch extensions', () => {
  assert.ok(isPatchPath('/x/game.ips'));
  assert.ok(isPatchPath('/x/game.UPS'));
  assert.ok(!isPatchPath('/x/game.gb'));
});

test('IPS with no EOF is rejected', () => {
  const rom = new Uint8Array(16);
  const patch = new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0x00, 0x00, 0x00, 0x02, 9, 9]);
  const r = applyPatch(rom, patch);
  assert.ok(!r.ok);
});
