'use strict';
// GB Printer protocol tests: build packets byte-by-byte, feed them through a
// fake serial exchange, and verify CRC handling, RLE decode, tile decode,
// print lifecycle, and PNG structure.

const { test } = require('node:test');
const assert = require('node:assert');
const { GBPrinter, encodePNG } = require('../src/core/printer');

function packet(cmd, payload, { compress = false, corruptCRC = false } = {}) {
  let data = [...payload];
  const body = [cmd, compress ? 1 : 0, payload.length & 0xFF, payload.length >> 8, ...data];
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xFFFF;
  if (corruptCRC) body[6] ^= 0x55; // flip a payload byte, keep the honest checksum
  return [0x88, 0x33, ...body, sum & 0xFF, sum >> 8];
}

function feed(printer, bytes) {
  let reply = null;
  for (const b of bytes) reply = printer.receiveByte(b);
  return reply;
}

test('inquiry packet returns status and sets the magic bit', () => {
  const p = new GBPrinter();
  const reply = feed(p, packet(0x0F, []));
  assert.strictEqual(reply & 0x80, 0x80);
  assert.strictEqual(reply & 0x02, 0x00); // battery ok
});

test('corrupt checksum sets the CRC error bit', () => {
  const p = new GBPrinter();
  feed(p, packet(0x0F, []));
  const reply = feed(p, packet(0x04, new Uint8Array(640).fill(0), { corruptCRC: true }));
  assert.strictEqual(reply & 0x01, 0x01);
});

test('data packet decodes plain 2bpp tiles into 160px rows', () => {
  const p = new GBPrinter();
  // one line: 40 tiles; tile 0 row 0 lo-plane only → color 1
  const payload = new Uint8Array(640);
  payload[0] = 0xFF; payload[1] = 0x00;
  payload[2] = 0x00; payload[3] = 0xFF; // row 1: hi-plane only → color 2
  feed(p, packet(0x04, payload));
  assert.strictEqual(p.image.length, 160 * 16);
  assert.strictEqual(p.image[0], 1);
  assert.strictEqual(p.image[7], 1);
  assert.strictEqual(p.image[8], 2);
  assert.strictEqual(p.image[160], 0); // tile 1 row 0 untouched
});

test('compressed data packet RLE-decodes', () => {
  const p = new GBPrinter();
  // Spec: control 0x00 = literal run of (next byte)+1; control ≥1 = run of
  // (control & 0x7F)+2 copies of the next byte.
  const out = p.decompress(Uint8Array.from([0x00, 0x00, 0xAB, 0x03, 0xCD]));
  assert.deepStrictEqual([...out], [0xAB, 0xCD, 0xCD, 0xCD, 0xCD, 0xCD]);
  // 5 runs of 127 + a 5-byte literal = 640 exactly (a real print line)
  const payload = [];
  for (let k = 0; k < 5; k++) payload.push(0x7D, 0x11 + k);
  payload.push(0x00, 0x04, 1, 2, 3, 4, 5);
  const dec = p.decompress(Uint8Array.from(payload));
  assert.strictEqual(dec.length, 640);
  assert.strictEqual(dec[126], 0x11);
  assert.strictEqual(dec[127], 0x12);
  assert.strictEqual(dec[635], 1);
  assert.strictEqual(dec[639], 5);
});

test('print lifecycle: busy bit during, image cleared after onPrint', () => {
  const p = new GBPrinter();
  const payload = new Uint8Array(640);
  payload[0] = 0xFF;
  feed(p, packet(0x04, payload));
  feed(p, packet(0x02, [0, 0, 0, 0])); // print: margins
  assert.strictEqual(p.printing, true);
  let printed = null;
  p.onPrint = (png) => { printed = png; };
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.strictEqual(p.printing, false);
      assert.ok(printed && printed.length > 8);
      assert.strictEqual(printed[0], 137); // PNG signature
      assert.strictEqual(printed[1], 80);
      resolve();
    }, 2300);
  });
});

test('encodePNG produces a valid 1-byte-grayscale file', () => {
  const w = 4, h = 3;
  const raw = new Uint8Array(h * (1 + w));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (1 + w) + 1 + x] = (x + y) * 30;
  const png = encodePNG(raw, w, h, 8);
  assert.deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.strictEqual(dv.getUint32(8), 13); // IHDR length
  assert.strictEqual(png[16], 0); // width hi byte (4 → 0,0,0,4 at offset 16)
  assert.strictEqual(png[19], w);
  assert.strictEqual(png[23], h);
});
