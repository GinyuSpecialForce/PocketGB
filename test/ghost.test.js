'use strict';
// Tests for the ghost racer (src/core/ghost.js): loading movies, ROM-identity
// validation, deterministic parallel stepping, lifecycle, and progress.
const { test } = require('node:test');
const assert = require('node:assert');

// Browser-global shims ghost.js expects (it is a classic script in the app).
global.window = global;
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

const { GhostRacer } = require('../src/core/ghost');
const { MovieRecorder } = require('../src/core/movie');

function makeRom(seed) {
  // Minimal-but-plausible ROM: logo-ish header, MBC0, checksummed content.
  const rom = new Uint8Array(0x8000);
  rom[0x100] = 0x00; // NOP entry
  rom[0x104] = 0xCE; rom[0x105] = 0xED; // logo magic start (not validated here)
  rom.set(Buffer.from('TESTGHOST', 'latin1'), 0x134);
  rom[0x147] = 0; rom[0x148] = 0; rom[0x149] = 0;
  for (let i = 0x150; i < rom.length; i++) rom[i] = (i * 7 + seed) & 0xFF;
  return rom;
}

// GameBoy double used so these tests stay machine-independent: the racer only
// needs loadROM, loadState, saveState, joypad.setState, runFrame.
class FakeGB {
  constructor(tag) { this.tag = tag; this.cart = { rom: makeRom(tag) }; this.joypad = { setState() {} }; this.frames = 0; }
  loadROM(rom) { this.cart = { rom }; }
  runFrame() { this.frames++; return { tag: this.tag, frame: this.frames }; }
  saveState() { return new Uint8Array([1, 2, 3, this.tag]); }
  loadState(u8) { this.loaded = Uint8Array.from(u8); }
}
// movieRomId reads gb.cart.rom only, so FakeGB works for record + identity.
FakeGB.prototype.cheats = null;

test('ghost loads a recorded movie and validates ROM identity', () => {
  const me = new FakeGB(7);
  const rec = new MovieRecorder();
  rec.start(me);
  for (let i = 0; i < 10; i++) rec.observe(i & 0xFF);
  const bytes = rec.serialize();

  const racer = new GhostRacer(me);
  assert.strictEqual(racer.load(bytes), null);
  assert.strictEqual(racer.frames.length, 10);
  // A different ROM must be rejected with a helpful message.
  const other = new GhostRacer(new FakeGB(9));
  const err = other.load(bytes);
  assert.ok(typeof err === 'string' && /another game|movie is for/.test(err), 'rejects foreign ROM: ' + err);
});

test('ghost load ARMS only; startNow builds a second machine anchored to the movie state', () => {
  const me = new FakeGB(7);
  const rec = new MovieRecorder();
  rec.start(me);
  for (let i = 0; i < 4; i++) rec.observe(0);
  const bytes = rec.serialize();

  const racer = new GhostRacer(me, FakeGB);
  assert.strictEqual(racer.load(bytes), null);
  assert.strictEqual(racer.active, false, 'load must NOT start the ghost');
  assert.strictEqual(racer.armed, true, 'load arms the ghost');
  assert.strictEqual(racer.waitingForReset, true, 'armed ghost waits for the reset gun');
  assert.strictEqual(racer.step(0), null, 'an armed ghost does not move');
  assert.strictEqual(racer.startNow(), null);
  assert.ok(racer.active);
  assert.strictEqual(racer.waitingForReset, false, 'racing ghost no longer waits');
  assert.ok(racer.gb && racer.gb !== me, 'ghost machine is distinct');
  assert.deepStrictEqual(racer.gb.loaded, new Uint8Array([1, 2, 3, 7]), 'ghost booted from the anchor state');
});

test('ghost steps deterministically and finishes at recording end', () => {
  const me = new FakeGB(7);
  const rec = new MovieRecorder();
  rec.start(me);
  for (let i = 0; i < 3; i++) rec.observe(0x0F);
  const bytes = rec.serialize();

  const racer = new GhostRacer(me, FakeGB);
  racer.load(bytes);
  racer.startNow();
  const fb1 = racer.step(0);
  const fb2 = racer.step(0);
  assert.ok(fb1 && fb2, 'steps produce ghost frames');
  assert.strictEqual(fb1.frame, 1, 'ghost machine advances one frame per step');
  assert.strictEqual(fb2.frame, 2);
  assert.strictEqual(racer.progress, 2 / 3);
  assert.strictEqual(racer.step(0).frame, 3, 'third and final recorded step still produces a frame');
  assert.strictEqual(racer.step(0), null, 'the step after the movie ends returns null');
  assert.strictEqual(racer.active, false);
  assert.strictEqual(racer.done, true);
  assert.strictEqual(racer.step(0), null, 'steps after end stay null');
});

test('ghost stop tears down without touching the live machine', () => {
  const me = new FakeGB(7);
  const rec = new MovieRecorder();
  rec.start(me);
  rec.observe(0);
  const bytes = rec.serialize();
  const racer = new GhostRacer(me, FakeGB);
  racer.load(bytes);
  racer.startNow();
  racer.stop();
  assert.strictEqual(racer.active, false);
  assert.strictEqual(racer.pending, false);
  assert.strictEqual(racer.frames, null);
  assert.strictEqual(racer.step(0), null);
  assert.strictEqual(me.frames, 0, 'live machine never stepped by the racer');
});

test('garbage input is rejected cleanly', () => {
  const me = new FakeGB(7);
  const racer = new GhostRacer(me, FakeGB);
  assert.ok(racer.load(new Uint8Array([1, 2, 3])), 'bad magic rejected');
  assert.strictEqual(racer.load(null), 'corrupt movie file');
  assert.strictEqual(racer.startNow(), 'no ghost loaded');
});

test('pause freezes the ghost mid-race; resume continues in lockstep', () => {
  const me = new FakeGB(7);
  const rec = new MovieRecorder();
  rec.start(me);
  for (let i = 0; i < 6; i++) rec.observe(0);
  const bytes = rec.serialize();
  const racer = new GhostRacer(me, FakeGB);
  racer.load(bytes);
  racer.startNow();
  assert.ok(racer.step(0), 'advances before pause');
  racer.pause();
  assert.strictEqual(racer.step(0), null, 'frozen: no frame');
  assert.strictEqual(racer.step(0), null, 'still frozen');
  assert.strictEqual(racer.pos, 1, 'movie position untouched while frozen');
  racer.resume();
  assert.ok(racer.step(0), 'resumes exactly where it froze');
  assert.strictEqual(racer.progress, 2 / 6);
});

test('hold stops the race but keeps the movie armed for the next reset', () => {
  const me = new FakeGB(7);
  const rec = new MovieRecorder();
  rec.start(me);
  rec.observe(0); rec.observe(0);
  const racer = new GhostRacer(me, FakeGB);
  racer.load(rec.serialize());
  racer.startNow();
  racer.step(0);
  racer.hold();
  assert.strictEqual(racer.active, false, 'race over');
  assert.strictEqual(racer.waitingForReset, true, 're-armed for the next attempt');
  assert.strictEqual(racer.pos, 0, 'playhead rewound to the anchor');
  racer.startNow(); // the reset hook just calls startNow again
  assert.ok(racer.active, 'second attempt starts fresh');
  assert.strictEqual(racer.progress, 0);
});

// ---- input echo trainer ----
test('input echo: divergence tracking and echo mask', () => {
  const me = new FakeGB(9);
  const rec = new MovieRecorder();
  rec.start(me);
  rec.observe(0b00000001); // frame 0: A
  rec.observe(0b00000010); // frame 1: B
  rec.observe(0b00000100); // frame 2: select
  const bytes = rec.stop();
  const racer = new GhostRacer(me, FakeGB);
  const err = racer.load(bytes);
  assert.equal(err, null);
  assert.equal(racer.startNow(), null);
  // ghost's next input before any step
  assert.equal(racer.echoMask, 0b00000001);
  assert.equal(racer.divergedFromRecording, false);
  // player matches on frame 0 (A pressed = bit 0)
  let fb = racer.step(0b00000001);
  assert.ok(fb, 'racing');
  assert.equal(racer.divergedFromRecording, false);
  // frame 1: player presses nothing while the ghost pressed B → diverged
  racer.step(0b00000000);
  assert.equal(racer.divergedFromRecording, true);
  assert.equal(racer.divergenceFrame, 1);
  // echo mask keeps following the recording regardless of divergence
  assert.equal(racer.echoMask, 0b00000100);
  // hold (attempt over) clears divergence for the next race
  racer.hold();
  assert.equal(racer.divergedFromRecording, false);
  assert.equal(racer.echoMask, null, 'armed ghost exposes no echo');
  // restart: divergence cleared
  assert.equal(racer.startNow(), null);
  assert.equal(racer.divergedFromRecording, false);
  assert.equal(racer.echoMask, 0b00000001);
});
