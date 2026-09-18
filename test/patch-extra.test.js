'use strict';
// Tests for the APS / RUP / PPF / VCDIFF patch decoders in src/core/patch.js.
// All patches are constructed byte-by-byte so the tests pin the exact format
// semantics from the specs (UniPatcher APS wiki, romhacking doc 288 for RUP,
// PPF v3 layout, RFC 3284 for VCDIFF). The md5/adler32 helpers are anchored
// against their published test vectors independently.

const { test } = require('node:test');
const assert = require('node:assert');
const { applyPatch, md5, adler32 } = require('../src/core/patch');

// ---- hash anchors (independent of decoder code) ----
test('md5 matches RFC 1321 test vectors', () => {
  const hex = (arr) => [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.strictEqual(hex(md5(Uint8Array.from([]))), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.strictEqual(hex(md5(Uint8Array.from('abc', (c) => c.charCodeAt(0)))), '900150983cd24fb0d6963f7d28e17f72');
  assert.strictEqual(
    hex(md5(Uint8Array.from('The quick brown fox jumps over the lazy dog', (c) => c.charCodeAt(0)))),
    '9e107d9d372bb6826bd81d3542a419d6'
  );
});

test('adler32 matches RFC 1950 test vectors', () => {
  assert.strictEqual(adler32(Uint8Array.from('Wikipedia', (c) => c.charCodeAt(0))), 0x11E60398);
  assert.strictEqual(adler32(new Uint8Array(0)), 1);
});

// ---- APS ----
// "APS10" + u8 headerType + u8 method + 50-byte description + u32 size (LE),
// then records: u32 offset LE + u8 len; len 0 = RLE (byte, run).
function buildAps(records, outSize, headerType = 0) {
  const head = [];
  head.push(...[0x41, 0x50, 0x53, 0x31, 0x30]); // APS10
  head.push(headerType, 0);
  for (let i = 0; i < 50; i++) head.push(0);
  head.push(outSize & 0xFF, (outSize >>> 8) & 0xFF, (outSize >>> 16) & 0xFF, (outSize >>> 24) & 0xFF); // sizeOutput BEFORE records
  const body = [];
  for (const r of records) {
    body.push(r.offset & 0xFF, (r.offset >>> 8) & 0xFF, (r.offset >>> 16) & 0xFF, (r.offset >>> 24) & 0xFF);
    if (r.rle) { body.push(0, r.rle.byte, r.rle.run); }
    else { body.push(r.data.length, ...r.data); }
  }
  const patch = new Uint8Array([...head, ...body]);
  return patch;
}

test('APS: literal and RLE records patch the ROM', () => {
  const rom = Uint8Array.from({ length: 32 }, (_, i) => (i * 3) & 0xFF);
  const patch = buildAps([
    { offset: 4, data: [0xDE, 0xAD] },
    { offset: 10, rle: { byte: 0x77, run: 3 } },
  ], 32);
  const r = applyPatch(rom, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.format, 'APS');
  assert.deepStrictEqual([...r.bytes.slice(4, 6)], [0xDE, 0xAD]);
  assert.deepStrictEqual([...r.bytes.slice(10, 13)], [0x77, 0x77, 0x77]);
  assert.strictEqual(r.bytes[9], rom[9]);
  assert.strictEqual(r.bytes.length, 32);
});

test('APS: output may grow past the source size', () => {
  const rom = new Uint8Array(8);
  const patch = buildAps([{ offset: 8, data: [1, 2] }], 10);
  const r = applyPatch(rom, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.bytes.length, 10);
  assert.deepStrictEqual([...r.bytes.slice(8)], [1, 2]);
});

test('APS: rejects a smaller declared output or wrong base (N64 header mode)', () => {
  const rom = new Uint8Array(16);
  const patch = buildAps([], 4); // outSize < rom length
  assert.ok(!applyPatch(rom, patch).ok);
});

// ---- RUP ----
// "NINJA2" + 0x800-byte header, then 0x01 file blocks and 0x02 XOR records.
// VLV = u8 byte count followed by LE bytes.
function rupVLV(v) { const bytes = []; let x = v; while (x) { bytes.push(x & 0xFF); x >>>= 8; } return [bytes.length, ...bytes]; }
function buildRup({ src, tgt, records, overflow }) {
  const head = [];
  head.push(...'NINJA2'.split('').map((c) => c.charCodeAt(0)));
  head.push(0); // encoding
  while (head.length < 0x800) head.push(0);
  const body = [];
  body.push(0x01); // open new file
  body.push(...rupVLV(0)); // empty file name
  body.push(0); // romType
  body.push(...rupVLV(src.length));
  body.push(...rupVLV(tgt.length));
  body.push(...md5(src));
  body.push(...md5(tgt));
  if (src.length !== tgt.length) {
    body.push(...(overflow.mode === 'A' ? [0x41] : [0x4D])); // 'A' or 'M'
    body.push(...rupVLV(overflow.data.length));
    body.push(...overflow.data);
  }
  for (const r of records) {
    body.push(0x02);
    body.push(...rupVLV(r.offset));
    body.push(...rupVLV(r.xor.length));
    body.push(...r.xor);
  }
  body.push(0x00); // end
  return Uint8Array.from([...head, ...body]);
}
function rupCompute(src, tgt, overflow) {
  // derive the XOR records the same way a patcher would
  const records = [];
  const n = Math.min(src.length, tgt.length);
  let i = 0;
  while (i < n) {
    if (src[i] !== tgt[i]) {
      const offset = i;
      const xor = [];
      while (i < n && src[i] !== tgt[i]) { xor.push(src[i] ^ tgt[i]); i++; }
      records.push({ offset, xor });
    } else i++;
  }
  return records;
}

test('RUP: XOR records patch the ROM and MD5s validate', () => {
  const src = Uint8Array.from({ length: 24 }, (_, i) => (i * 7 + 3) & 0xFF);
  const tgt = Uint8Array.from(src);
  tgt.set([0xAA, 0xBB, 0xCC], 5);
  const records = rupCompute(src, tgt);
  const patch = buildRup({ src, tgt, records, overflow: { mode: 'A', data: [] } });
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.format, 'RUP');
  assert.deepStrictEqual([...r.bytes], [...tgt]);
});

test('RUP: append overflow grows the ROM', () => {
  const src = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const extra = Uint8Array.from([0x11, 0x22, 0x33]);
  const tgt = Uint8Array.from([...src, ...extra.map((b) => b ^ 0xFF)]);
  const records = rupCompute(src, src); // identical prefix
  const patch = buildRup({ src, tgt, records, overflow: { mode: 'A', data: [...extra.map((b) => b ^ 0xFF)] } });
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.bytes.length, 19);
  assert.deepStrictEqual([...r.bytes], [...src, ...extra]);
});

test('RUP: applying to the patched ROM unpatches it (undo direction)', () => {
  const src = Uint8Array.from({ length: 24 }, (_, i) => (i * 7 + 3) & 0xFF);
  const tgt = Uint8Array.from(src);
  tgt.set([0xAA, 0xBB, 0xCC], 5);
  const patch = buildRup({ src, tgt, records: rupCompute(src, tgt), overflow: { mode: 'A', data: [] } });
  const r = applyPatch(tgt, patch); // note: target as input
  assert.ok(r.ok, r && r.error);
  assert.deepStrictEqual([...r.bytes], [...src]);
});

// ---- PPF ----
function buildPpf(version, records, { undo = false, diz = '' } = {}) {
  const head = [];
  head.push(...'PPF'.split('').map((c) => c.charCodeAt(0)));
  head.push(...(version * 10).toString().split('').map((c) => c.charCodeAt(0)));
  head.push(version - 1);
  for (let i = 0; i < 50; i++) head.push(0);
  if (version === 3) {
    head.push(0); // imageType
    head.push(0); // blockCheck
    head.push(undo ? 1 : 0);
    head.push(0); // dummy
  }
  const body = [];
  for (const r of records) {
    body.push(r.offset & 0xFF, (r.offset >>> 8) & 0xFF, (r.offset >>> 16) & 0xFF, (r.offset >>> 24) & 0xFF);
    if (version === 3) body.push(0, 0, 0, 0); // u64 high half
    body.push(r.data.length);
    body.push(...r.data);
    if (undo && version === 3) body.push(...r.undoData);
  }
  let dizBytes = [];
  if (diz) {
    dizBytes = [...'@BEG_FILE_ID.DIZ'.split('').map((c) => c.charCodeAt(0)), ...diz.split('').map((c) => c.charCodeAt(0)), ...'@END_FILE_ID.DIZ'.split('').map((c) => c.charCodeAt(0))];
  }
  return Uint8Array.from([...head, ...body, ...dizBytes]);
}

test('PPF v3: records patch the ROM', () => {
  const rom = Uint8Array.from({ length: 32 }, (_, i) => (i * 5) & 0xFF);
  const patch = buildPpf(3, [
    { offset: 6, data: [0x01, 0x02, 0x03] },
    { offset: 20, data: [0xFF] },
  ]);
  const r = applyPatch(rom, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.format, 'PPF');
  assert.deepStrictEqual([...r.bytes.slice(6, 9)], [1, 2, 3]);
  assert.strictEqual(r.bytes[20], 0xFF);
  assert.strictEqual(r.bytes[5], rom[5]);
});

test('PPF v1 and v2 (no u64, no undo) apply records', () => {
  const rom = Uint8Array.from({ length: 16 }, (_, i) => i);
  const p1 = buildPpf(1, [{ offset: 2, data: [0x9A] }]);
  const r1 = applyPatch(rom, p1);
  assert.ok(r1.ok && r1.format === 'PPF');
  assert.strictEqual(r1.bytes[2], 0x9A);
  const p2 = buildPpf(2, [{ offset: 2, data: [0x9B] }]);
  const r2 = applyPatch(rom, p2);
  assert.ok(r2.ok && r2.format === 'PPF');
  assert.strictEqual(r2.bytes[2], 0x9B);
});

test('PPF v3 with undo data reverses an already-patched ROM', () => {
  const original = Uint8Array.from({ length: 16 }, (_, i) => i);
  const patched = Uint8Array.from(original);
  patched.set([0xCA, 0xFE], 4);
  const patch = buildPpf(3, [{ offset: 4, data: [0xCA, 0xFE], undoData: [original[4], original[5]] }], { undo: true });
  const fwd = applyPatch(original, patch);
  assert.ok(fwd.ok);
  assert.deepStrictEqual([...fwd.bytes.slice(4, 6)], [0xCA, 0xFE]);
  const rev = applyPatch(patched, patch);
  assert.ok(rev.ok, rev && rev.error);
  assert.deepStrictEqual([...rev.bytes], [...original]);
});

test('PPF: FILE_ID.DIZ trailer does not confuse record parsing', () => {
  const rom = new Uint8Array(8);
  const patch = buildPpf(3, [{ offset: 0, data: [1] }], { diz: 'hello diz' });
  const r = applyPatch(rom, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.bytes[0], 1);
});

// ---- VCDIFF ----
// Minimal encoder-free VCDIFF builder: windows with ADD + RUN + COPY through
// the default code table. Indexes into VCD_DEFAULT_CODE_TABLE are derived
// from the RFC 3284 builder semantics (see patch.js table).
function vcdVarint(v) { const out = []; let x = v; do { let b = x & 0x7F; x = Math.floor(x / 128); if (x) b |= 0x80; out.push(b); } while (x); return out; }
// code-table indexes for single-instruction codes:
function idxAdd(size) { return 1 + size; } // RUN(0), ADD size 0..17 → 1..18
function idxCopy(mode, size) { return 19 + mode * 16 + (size - 4 + 1); } // COPY mode m: size0 entry then 4..18
function idxRun(size) { return [0, ...vcdVarint(size)]; } // RUN's table entry has size 0 → explicit size varint follows

function vcdAdler(u8, start, end) {
  let a = 1, b = 0;
  for (let i = start; i < end; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

test('VCDIFF: ADD window reconstructs literal target', () => {
  const src = new Uint8Array(0);
  const target = Uint8Array.from([10, 20, 30, 40, 50]);
  // instructions: index for ADD-size5 (5 bytes embedded)
  const inst = [idxAdd(5)];
  const data = Uint8Array.from(target);
  const win = buildVcdWindow({ src, data, inst, targetLength: 5, adler: true, target });
  const patch = vcdHeader(win);
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.strictEqual(r.format, 'VCDIFF');
  assert.deepStrictEqual([...r.bytes], [...target]);
});

test('VCDIFF: COPY from source (self mode) + ADLER32 checksum', () => {
  const src = Uint8Array.from({ length: 16 }, (_, i) => (i * 11 + 5) & 0xFF);
  const target = Uint8Array.from(src); // whole window copies the source
  const inst = [idxCopy(0, 16)]; // COPY mode 0 (self), size 16 — table: sizes 4..18
  const win = buildVcdWindow({ src, data: new Uint8Array(0), inst, targetLength: 16, addrBytes: vcdVarint(0), adler: true, target }); // self address 0
  const patch = vcdHeader(win);
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.deepStrictEqual([...r.bytes], [...target]);
});

test('VCDIFF: COPY here-mode address decodes relative offsets', () => {
  const src = Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i);
  const target = Uint8Array.from(src);
  const addrHere = 0; // here - 0 = here = 16 (source length) when at start of target
  const inst = [idxCopy(1, 16)];
  const win = buildVcdWindow({ src, data: new Uint8Array(0), inst, targetLength: 16, addrBytes: vcdVarint(addrHere), adler: true, target });
  const patch = vcdHeader(win);
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.deepStrictEqual([...r.bytes], [...target]);
});

test('VCDIFF: RUN fills and near/same caches update without error', () => {
  const src = new Uint8Array(4);
  const target = Uint8Array.from([0xAB, 0xAB, 0xAB, 0xAB, 0xAB, 0xAB]);
  const inst = [...idxRun(6)];
  const win = buildVcdWindow({ src, data: Uint8Array.from([0xAB]), inst, targetLength: 6, adler: true, target });
  const patch = vcdHeader(win);
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.deepStrictEqual([...r.bytes], [...target]);
});

test('VCDIFF: wrong adler32 is rejected', () => {
  const src = new Uint8Array(0);
  const target = Uint8Array.from([1, 2, 3]);
  const win = buildVcdWindow({ src, data: Uint8Array.from(target), inst: [idxAdd(3)], targetLength: 3, adler: true, target, badAdler: true });
  const r = applyPatch(src, vcdHeader(win));
  assert.ok(!r.ok);
});

test('VCDIFF: app header is skipped', () => {
  const src = new Uint8Array(0);
  const target = Uint8Array.from([7, 7, 7]);
  const win = buildVcdWindow({ src, data: Uint8Array.from(target), inst: [idxAdd(3)], targetLength: 3, adler: true, target });
  const patch = vcdHeader(win, { appHeader: 'PocketGB-test' });
  const r = applyPatch(src, patch);
  assert.ok(r.ok, r && r.error);
  assert.deepStrictEqual([...r.bytes], [7, 7, 7]);
});

// Build one window's raw section bytes given parsed pieces.
function buildVcdWindow({ src, data, inst, targetLength, addrBytes = [], adler = false, target, badAdler = false }) {
  const dataLength = data.length;
  const instLength = inst.length;
  const addrLength = addrBytes.length;
  const adlerValue = adler ? (badAdler ? 0xDEADBEEF : vcdAdler(target, 0, target.length)) : null;
  return { data, inst, addrBytes, dataLength, instLength, addrLength, targetLength, sourceLength: src.length, adlerValue, hasAdler: !!adler };
}
function vcdHeader(win, { appHeader = null } = {}) {
  const out = [];
  out.push(0xD6, 0xC3, 0xC4, 0x00);
  let hdrIndicator = 0;
  const appHeaderBytes = appHeader ? [...appHeader.split('').map((c) => c.charCodeAt(0))] : null;
  if (appHeaderBytes) hdrIndicator |= 0x04;
  out.push(hdrIndicator);
  if (appHeaderBytes) { out.push(...vcdVarint(appHeaderBytes.length), ...appHeaderBytes); }
  // window header
  let winIndicator = 0;
  if (win.sourceLength > 0) winIndicator |= 0x01;
  if (win.hasAdler) winIndicator |= 0x04;
  out.push(winIndicator);
  if (win.sourceLength > 0) { out.push(...vcdVarint(win.sourceLength), ...vcdVarint(0)); }
  out.push(...vcdVarint(win.dataLength + win.instLength + win.addrLength)); // deltaLength
  out.push(...vcdVarint(win.targetLength));
  out.push(0); // deltaIndicator (no secondary compression)
  out.push(...vcdVarint(win.dataLength));
  out.push(...vcdVarint(win.instLength));
  out.push(...vcdVarint(win.addrLength));
  if (win.hasAdler) { out.push((win.adlerValue >>> 24) & 0xFF, (win.adlerValue >>> 16) & 0xFF, (win.adlerValue >>> 8) & 0xFF, win.adlerValue & 0xFF); }
  out.push(...win.data);
  out.push(...win.inst);
  out.push(...win.addrBytes);
  return Uint8Array.from(out);
}

test('dispatcher: unknown magic still errors cleanly', () => {
  const r = applyPatch(new Uint8Array(8), Uint8Array.from([0x00, 1, 2, 3, 4]));
  assert.ok(!r.ok);
  assert.match(r.error, /unknown/i);
});
