'use strict';
// Movie round-trip: record frames against a real GameBoy, serialize, reload,
// and verify byte-identical frame masks plus ROM-identity gating.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MovieRecorder, MoviePlayer, movieRomId, maskToState, stateToMask } = require('../src/core/movie');
const { GameBoy } = require('../src/core/gameboy');

function newGB() {
  const rom = new Uint8Array(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'dmg-acid2.gb')));
  const gb = new GameBoy();
  gb.loadROM(rom);
  return gb;
}

test('movie record → serialize → load round-trips the masks', () => {
  const gb = newGB();
  const rec = new MovieRecorder();
  rec.start(gb);
  rec.observe(0b00000001); // A
  rec.observe(0b00000010); // B
  rec.observe(0b10000001); // A+Down
  const bytes = rec.stop();
  assert.strictEqual(bytes[0], 0x50); // PGBM

  const player = new MoviePlayer();
  assert.strictEqual(player.load(bytes, gb), null);
  assert.strictEqual(player.start(gb), null);
  const seen = [];
  let m;
  while ((m = player.next()) !== null) seen.push(m);
  assert.deepStrictEqual(seen, [0b00000001, 0b00000010, 0b10000001]);
  assert.strictEqual(player.playing, false);
});

test('movie rejects a different ROM', () => {
  const gb = newGB();
  const rec = new MovieRecorder();
  rec.start(gb);
  rec.observe(0);
  const bytes = rec.stop();

  // a different ROM: same cartridge shape, one header byte flipped
  const rom = new Uint8Array(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'dmg-acid2.gb')));
  rom[0x150] ^= 0xFF;
  const gb2 = new GameBoy();
  gb2.loadROM(rom);
  const player = new MoviePlayer();
  const err = player.load(bytes, gb2);
  assert.ok(err && err.includes('movie is for'), 'must refuse: ' + err);
});

test('mask conversion matches joypad bit order', () => {
  // 0b10010111: bits 0,1,2 = a,b,select; bit 4 = right; bit 7 = down
  const s = maskToState(0b10010111);
  assert.deepStrictEqual(s, { a: true, b: true, select: true, start: false, right: true, left: false, up: false, down: true, l: false, r: false });
  assert.strictEqual(stateToMask(s), 0b10010111);
});

test('GBA shoulder buttons round-trip through the mask (bits 8/9)', () => {
  const m = stateToMask({ l: true, r: true, a: true });
  assert.strictEqual(m, (1 << 0) | (1 << 8) | (1 << 9));
  const s = maskToState(m);
  assert.strictEqual(s.l, true); assert.strictEqual(s.r, true); assert.strictEqual(s.a, true);
  // GB movies never set the shoulder bits, so their masks replay unchanged
  assert.strictEqual(stateToMask(maskToState(0xFF)), 0xFF);
});

test('GBA L/R survive record → serialize → load → replay (shoulder bits not dropped)', () => {
  // Regression: observe() used to mask & 0xFF, silently discarding bits 8/9
  // (GBA L/R) even though the v2 format stores a 2-byte, 10-bit mask.
  const gb = newGB();
  const rec = new MovieRecorder();
  rec.start(gb);
  const shoulderMask = (1 << 0) | (1 << 8) | (1 << 9); // A + L + R
  rec.observe(shoulderMask);
  rec.observe(1 << 8); // L only
  rec.observe(1 << 9); // R only
  const bytes = rec.stop();

  const player = new MoviePlayer();
  assert.strictEqual(player.load(bytes, gb), null);
  assert.strictEqual(player.start(gb), null);
  const seen = [];
  let m;
  while ((m = player.next()) !== null) seen.push(m);
  assert.deepStrictEqual(seen, [shoulderMask, 1 << 8, 1 << 9], 'shoulder bits must survive the round-trip');
  // And they map back to real joypad state on replay
  assert.deepStrictEqual(maskToState(seen[0]), { a: true, b: false, select: false, start: false,
    right: false, left: false, up: false, down: false, l: true, r: true });
});

test('progress is a 0..1 fraction over frames, not bytes (caps at 1, not 2)', () => {
  // Regression: pos advances 2 per frame (byte offset) while total is a frame
  // count, so pos/total ran to 2.0 at the end of playback.
  const gb = newGB();
  const rec = new MovieRecorder();
  rec.start(gb);
  const N = 4;
  for (let i = 0; i < N; i++) rec.observe(0);
  const bytes = rec.stop();

  const player = new MoviePlayer();
  assert.strictEqual(player.load(bytes, gb), null);
  assert.strictEqual(player.start(gb), null);
  assert.strictEqual(player.progress, 0, 'starts at 0');
  for (let i = 1; i <= N; i++) {
    assert.notStrictEqual(player.next(), null);
    assert.ok(Math.abs(player.progress - i / N) < 1e-9, `progress after ${i}/${N} frames = ${player.progress}`);
  }
  assert.strictEqual(player.progress, 1, 'caps at 1.0 after the last frame');
});

test('movieRomId is stable and content-sensitive', () => {
  const gb = newGB();
  const id1 = movieRomId(gb);
  const id2 = movieRomId(gb);
  assert.strictEqual(id1, id2);
  const rom = new Uint8Array(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'dmg-acid2.gb')));
  rom[0x150] ^= 0xFF;
  const gb2 = new GameBoy();
  gb2.loadROM(rom);
  assert.notStrictEqual(movieRomId(gb2), id1);
});
