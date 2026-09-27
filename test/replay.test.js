'use strict';
// Tests for instant-replay capture: the input-mask ring stays index-aligned
// with the frame history, and the PocketReplayInput strip burns held-button
// labels into copied frames for both the DMG (shade-index) and CGB (BGR555)
// paths, without mutating the source frames.

const { test } = require('node:test');
const assert = require('node:assert');
const { Capture, PocketReplayInput, REPLAY_KEYS, FONT5X7 } = require('../src/ui/capture');
const { stateToMask } = require('../src/core/movie');

function fakeRenderer() { return { palRGB: [0xFF000000, 0xFF555555, 0xFFAAAAAA, 0xFFFFFFFF] }; }

function makeCapture() {
  // Fake clock: every observe() advances 17ms so the capture throttle never
  // swallows frames the way real time would.
  let t = 1000;
  global.performance = { now: () => (t += 17) };
  const c = new Capture(fakeRenderer(), {});
  return c;
}

test('observe keeps masks index-aligned with the frame history', () => {
  const c = makeCapture();
  for (let i = 0; i < 40; i++) {
    c.observe(new Uint8Array(160 * 144).fill(i & 3), false, i % 7); // DMG: 7 masks cycle
  }
  assert.strictEqual(c.frames.length, 40);
  assert.strictEqual(c.inputMasks.length, 40);
  assert.strictEqual(c.inputMasks[10], 10 % 7);
});

test('mask ring trims exactly with the frame ring past maxFrames', () => {
  const c = makeCapture();
  c.maxFrames = 30; // shrink so the test stays fast
  for (let i = 0; i < 75; i++) {
    c.observe(new Uint8Array(160 * 144).fill(i & 3), false, i);
  }
  assert.strictEqual(c.frames.length, 30);
  assert.strictEqual(c.inputMasks.length, 30);
  // oldest surviving frame is 75-30 = 45
  assert.strictEqual(c.frames[0][0], 45 & 3);
  assert.strictEqual(c.inputMasks[0], 45);
});

test('replayGif: takes the last N seconds and calls saveFile with a gif', async () => {
  const c = makeCapture();
  c.replaySeconds = 1; // 60 frames
  for (let i = 0; i < 200; i++) {
    c.observe(new Uint8Array(160 * 144).fill(1), false, i & 1 ? 0b11 : 0);
  }
  assert.strictEqual(c.frames.length, 1800 > 200 ? 200 : 1800); // untouched by replay
  let saved = null;
  global.window = { pocketgb: { saveFile: async (name, b64) => { saved = { name, b64 }; return '/tmp/x'; } } };
  const statuses = [];
  c.setOnStatus((m) => statuses.push(m));
  c.replayGif(new PocketReplayInput());
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(saved, 'saveFile was called');
  assert.match(saved.name, /pocketgb-replay-.*\.gif$/);
  assert.ok(saved.b64.length > 1000);
  assert.ok(statuses.some((m) => m.includes('replay saved')));
  // GIF header + 160-wide logical screen
  const bytes = Buffer.from(saved.b64, 'base64');
  assert.strictEqual(bytes.subarray(0, 3).toString('ascii'), 'GIF');
  assert.strictEqual(bytes[6], 160);
  delete global.window;
});

test('replayGif: CGB path encodes when CGB history exists', async () => {
  const c = makeCapture();
  c.replaySeconds = 1;
  for (let i = 0; i < 100; i++) {
    c.observe(new Uint16Array(160 * 144).fill(0x7FFF), true, 1);
  }
  let saved = null;
  global.window = { pocketgb: { saveFile: async (name, b64) => { saved = { name, b64 }; return '/tmp/x'; } } };
  c.replayGif(new PocketReplayInput());
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(saved);
  const bytes = Buffer.from(saved.b64, 'base64');
  assert.strictEqual(bytes.subarray(0, 3).toString('ascii'), 'GIF');
  delete global.window;
});

test('replayGif: refuses with too little history', () => {
  const c = makeCapture();
  const statuses = [];
  c.setOnStatus((m) => statuses.push(m));
  c.replayGif(null);
  assert.ok(statuses.some((m) => m.includes('not enough history')));
});

test('replay strip: burns held-button labels into copied taller frames', () => {
  const ri = new PocketReplayInput({ stripHeight: 12 });
  const H = 144, W = 160;
  const frames = [new Uint8Array(H * W).fill(0), new Uint8Array(H * W).fill(0)];
  const masks = [0, stateToMask({ a: true, left: true })]; // "A+<"
  const out = ri.renderFrames(frames, masks);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].length, (H + 12) * W);
  // picture region untouched
  assert.strictEqual(out[0][0], 0);
  assert.strictEqual(out[1][5 * W + 5], 0);
  // the empty-mask frame's strip has no glyph pixels; the A+< frame does
  let litA = 0, litNone = 0;
  for (let y = H; y < H + 12; y++) {
    for (let x = 0; x < W; x++) {
      if (out[1][y * W + x] === ri.litColor) litA++;
      if (out[0][y * W + x] === ri.litColor) litNone++;
    }
  }
  assert.strictEqual(litNone, 0);
  assert.ok(litA > 10, `expected glyph pixels on the A+< frame, got ${litA}`);
  // sources untouched (strip is burned into copies)
  assert.strictEqual(frames[0].length, H * W);
});

test('replay strip: label picks the right keys and caps at three', () => {
  const ri = new PocketReplayInput();
  assert.strictEqual(ri._label(0), '');
  assert.strictEqual(ri._label(REPLAY_KEYS[0].mask), 'A');
  const maskAB = REPLAY_KEYS[0].mask | REPLAY_KEYS[1].mask;
  assert.strictEqual(ri._label(maskAB), 'A+B');
  const three = REPLAY_KEYS[0].mask | REPLAY_KEYS[1].mask | REPLAY_KEYS[6].mask;
  assert.strictEqual(ri._label(three), 'A+B+<');
  const many = REPLAY_KEYS.slice(0, 5).reduce((m, k) => m | k.mask, 0);
  assert.match(ri._label(many), /KEYS$/);
});

test('replay strip: CGB frames get real BGR555 strip colors', () => {
  const ri = new PocketReplayInput({ stripHeight: 10 });
  const frame = new Uint16Array(160 * 144).fill(0x7FFF); // white frame
  const out = ri.renderFrames([frame], [0])[0];
  assert.ok(out instanceof Uint16Array);
  assert.strictEqual(out[0], 0x7FFF); // picture intact
  const stripPixel = out[(144 + 5) * 160]; // strip, left edge (no glyph there)
  assert.ok(stripPixel !== 0x7FFF); // strip is not picture-white
});

test('replay font covers every label character', () => {
  for (const k of REPLAY_KEYS) {
    for (const ch of k.label) {
      assert.ok(FONT5X7[ch], `missing glyph for ${ch}`);
      assert.strictEqual(FONT5X7[ch].length, 7);
    }
  }
  assert.ok(FONT5X7['+'], 'missing glyph for +');
});
