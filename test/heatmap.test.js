'use strict';
// Tests for the cartridge heatmap (src/core/heatmap.js): bucket mapping,
// bank translation through cart.bankFor, saturation, snapshot, serialize.
const { test } = require('node:test');
const assert = require('node:assert');
const { CartridgeHeatmap, HEAT_BUCKET } = require('../src/core/heatmap');

// Cart stub: 4 physical banks; bankFor = high nibble of addr region 0-7fff
function stubCart() {
  return { bankFor(addr) {
    if (addr < 0x4000) return 0;
    return 1 + ((addr >> 12) & 0x03); // 4000-7FFF maps to banks 1..4
  } };
}

test('bucket constant divides a 16K bank into 256 buckets', () => {
  assert.strictEqual(HEAT_BUCKET, 64);
  assert.strictEqual(0x4000 / HEAT_BUCKET, 256);
});

test('samples land in the right bank/bucket', () => {
  const h = new CartridgeHeatmap(stubCart());
  h.sample(0x0100); // bank 0, bucket (0x0100/64)=4
  h.sample(0x0105); // same bucket
  h.sample(0x4500); // bank 1, bucket (0x0500/64)=20
  assert.strictEqual(h.banks.get(0)[4], 2);
  assert.strictEqual(h.banks.get(1)[20], 1);
  assert.strictEqual(h.frames, 3);
  assert.strictEqual(h.lastBank, 1);
});

test('buckets saturate at 255', () => {
  const h = new CartridgeHeatmap(stubCart());
  for (let i = 0; i < 1000; i++) h.sample(0x4000);
  assert.strictEqual(h.banks.get(1)[0], 255);
});

test('snapshot reports coverage and sorts by heat', () => {
  const h = new CartridgeHeatmap(stubCart());
  for (let i = 0; i < 50; i++) h.sample(0x0100); // bank 0
  for (let i = 0; i < 200; i++) h.sample(0x4500); // bank 1 (hotter)
  const snaps = h.snapshot();
  assert.strictEqual(snaps[0].bank, 1, 'hotter bank first');
  assert.strictEqual(snaps[0].hot, 200);
  assert.strictEqual(snaps[0].touched, 1);
  assert.strictEqual(snaps[0].coverage, 1 / 256);
});

test('serialize round-trips bank data', () => {
  const h = new CartridgeHeatmap(stubCart());
  h.sample(0x0100);
  const s = h.serialize();
  assert.strictEqual(s.v, 1);
  assert.strictEqual(s.frames, 1);
  assert.ok(s.banks[0] && s.banks[0].length > 0, 'bank 0 data present');
  const buf = Buffer.from(s.banks[0], 'base64');
  assert.strictEqual(buf[4], 1);
});

test('reset clears everything', () => {
  const h = new CartridgeHeatmap(stubCart());
  h.sample(0x0100);
  h.reset();
  assert.strictEqual(h.banks.size, 0);
  assert.strictEqual(h.frames, 0);
});
