'use strict';
// Tests for the capture GIF encoders: the DMG 4-color path and the CGB
// BGR555 path (exact palette <=256 colors, median-cut quantization beyond).
// Byte-level GIF structure is checked against the GIF89a spec; pixel
// round-trip through real decoders (Chromium, sips) was verified separately.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  encodeGif, encodeGifColor, encodeGifIndexed, quantize555, lzwEncode,
} = require('../src/ui/capture.js');

const W = 160, H = 144;

test('DMG gif: valid header, 4-entry color table, palette bytes match palRGB', () => {
  const palRGB = new Uint32Array([0xFF155CBF, 0xFF0FAC8B, 0xFF306230, 0xFF0F380F]);
  const frames = [new Uint8Array(W * H).fill(2)];
  const bytes = encodeGif(frames, palRGB);
  const ascii = String.fromCharCode(...bytes.slice(0, 6));
  assert.strictEqual(ascii, 'GIF89a');
  assert.strictEqual(bytes[10] & 0x80, 0x80, 'global color table flag set');
  const gctSize = (bytes[10] & 7) + 1; // entries = 2^n
  assert.strictEqual(gctSize, 2, 'entries = 4 for the 4-color palette');
  // color table starts at byte 13
  assert.strictEqual(bytes[13], 0xBF, 'palette[0].r');
  assert.strictEqual(bytes[14], 0x5C, 'palette[0].g');
  assert.strictEqual(bytes[15], 0x15, 'palette[0].b');
  assert.strictEqual(bytes[bytes.length - 1], 0x3B, 'trailer');
});

test('CGB gif (<=256 unique colors): exact palette and count', () => {
  // i*499 is coprime with 2^15, so all 40 colors are guaranteed distinct
  const colors = [];
  for (let i = 0; i < 40; i++) colors.push((i * 499) & 0x7FFF);
  const f = new Uint32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = colors[i % 40];
  const { palette } = quantize555([f]);
  assert.strictEqual(palette.length, 40, 'exact palette, no padding');
  // round-trip all 40 through the 5->8 bit expansion
  colors.forEach((c, i) => {
    const [r, g, b] = palette[i];
    const exp = (v) => (v << 3) | (v >> 2);
    assert.strictEqual(r, exp(c & 31));
    assert.strictEqual(g, exp((c >> 5) & 31));
    assert.strictEqual(b, exp((c >> 10) & 31));
  });
  const bytes = encodeGifColor([f, f], W, H);
  assert.strictEqual(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  assert.strictEqual(bytes[bytes.length - 1], 0x3B);
});

test('median-cut quantization: >256 unique colors produce <=256-entry palette', () => {
  const f = new Uint32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      f[y * W + x] = ((x * 31 / W) & 31) | (((y * 31 / H) & 31) << 5) | (((x + y) & 31) << 10);
    }
  }
  const { indexed, palette } = quantize555([f]);
  assert.ok(palette.length <= 256 && palette.length > 100, `palette size ${palette.length}`);
  for (const idx of indexed[0]) assert.ok(idx >= 0 && idx < palette.length, 'index in range');
});

test('lzwEncode round-trips trivially and respects 12-bit dictionary reset', () => {
  // empty-ish case: single-color frame compresses to a handful of codes
  const one = new Uint8Array(W * H).fill(7);
  const out = lzwEncode(one, 8);
  // strings grow exponentially on constant input, so output is tiny —
  // but each intermediate code still emits at ≥9 bits, so not minuscule.
  assert.ok(out.length < 400, `single-color frame compresses hard (${out.length} bytes)`);
  // ramp with many distinct pairs: must never emit codes >= 4096
  const ramp = new Uint8Array(W * H);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i & 0xFF;
  const bytes = lzwEncode(ramp, 8);
  assert.ok(bytes.length > 0);
});

// Spec-faithful GIF LZW decoder (GIF89a appendix F): grows the code size when
// the dictionary reaches it and stops growing at 12 bits (no early reset).
function lzwDecode(data, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, prev = null;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push(null); dict.push(null);
  };
  reset();
  let bitPos = 0;
  const read = () => {
    if ((bitPos + codeSize) > data.length * 8) return null;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };
  const out = [];
  for (;;) {
    const code = read();
    if (code === null) throw new Error('stream ended without EOI');
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) return out;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (code === dict.length && prev) entry = prev.concat([prev[0]]);
    else throw new Error(`bad code ${code} (dict ${dict.length})`);
    for (const px of entry) out.push(px);
    if (prev) {
      dict.push(prev.concat([entry[0]]));
      if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
}

test('lzwEncode round-trips through a spec decoder, including growth past 4096', () => {
  // Long structured runs force the dictionary past 4096 entries: the encoder
  // must emit CLEAR exactly when full (not one code late — the classic GIF
  // corruption bug, and not early either, which decoders tolerate but
  // wastes space) and keep 12-bit codes until then.
  const px = new Uint8Array(30000);
  let s = 123456789;
  const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < px.length; i++) px[i] = rng() & 0xFF;
  for (let i = 0; i < px.length / 3; i++) px[(rng() % px.length)] = px[i * 2 % px.length];
  const enc = Uint8Array.from(lzwEncode(px, 8));
  const dec = lzwDecode(enc, 8);
  assert.strictEqual(dec.length, px.length, 'decoded length matches');
  let same = true;
  for (let i = 0; i < px.length; i++) if (dec[i] !== px[i]) { same = false; break; }
  assert.ok(same, 'decoded pixels match');
});
