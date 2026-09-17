'use strict';
// Regression tests for the unit-mismatch bug that capped the app at ~16 fps:
// the APU was calibrated in m-cycles but ticked with T-cycles, producing 4x
// too many samples. The audio-latency gate then stalled frame production.
// These tests pin the real frequencies so the units can't drift again.

const { test } = require('node:test');
const assert = require('node:assert');
const { GameBoy } = require('../src/core/gameboy');
const { APU } = require('../src/core/apu');
const fs = require('fs');
const path = require('path');

const MASTER_HZ = 4194304;
const FRAME_T = 70224;

function newGB(romPath) {
  const gb = new GameBoy();
  gb.loadROM(new Uint8Array(fs.readFileSync(path.join(__dirname, romPath))));
  return gb;
}

test('APU produces ~outputRate/59.73 samples per frame at the device rate', () => {
  const gb = newGB('./cgb-acid2/cgb-acid2.gbc');
  let samples = 0;
  const orig = gb.apu.pushSample.bind(gb.apu);
  gb.apu.pushSample = (l, r) => { samples++; orig(l, r); };
  for (let f = 0; f < 10; f++) { samples = 0; gb.runFrame(); }
  const expected = gb.apu.outputRate * (FRAME_T / MASTER_HZ); // ≈738 @ 44100
  assert.ok(Math.abs(samples - expected) < 3, `samples/frame ${samples} vs expected ~${expected}`);
});

test('APU tick is unit-correct: 1 second of T-cycles at 44100 Hz → 44100 samples', () => {
  const apu = new APU();
  apu.setOutputRate(44100);
  let samples = 0;
  const orig = apu.pushSample.bind(apu);
  apu.pushSample = (l, r) => { samples++; orig(l, r); };
  apu.tick(MASTER_HZ);
  assert.ok(Math.abs(samples - 44100) <= 2, `1s of ticks produced ${samples} samples (want 44100)`);
});

test('frame sequencer steps at 512 Hz (8192 T-cycles per step)', () => {
  const apu = new APU();
  let steps = 0;
  const orig = apu.frameSequencer.bind(apu);
  apu.frameSequencer = () => { steps++; orig(); };
  apu.tick(MASTER_HZ / 2); // half a second of T-cycles
  assert.strictEqual(steps, 256, 'half a second must yield 256 sequencer steps');
});

test('Timer: TIMA increments at the configured real frequency', () => {
  const { GameBoy: GB } = require('../src/core/gameboy');
  const gb = newGB('./dmg-acid2/dmg-acid2.gb');
  // TAC = enable + 01 → 262144 Hz = 16 T-cycles per increment
  gb.mmu.write(0xFF07, 0x05);
  const timaStart = gb.mmu.read(0xFF05);
  // run 100 frames of DMA-free idling via runFrame; DIV ticks regardless
  for (let f = 0; f < 100; f++) gb.runFrame();
  const divBefore = gb.mmu.timer.div & 0xFFFF;
  // exact: 70224 T-cycles at 16 T/increment → 4389 increments
  gb.mmu.timer.div = 0; gb.mmu.timer.tima = 100; gb.mmu.timer.tac = 0x05;
  gb.mmu.timer.tick(FRAME_T);
  assert.strictEqual(gb.mmu.timer.tima, (100 + 4389) & 0xFF, 'TIMA must advance 4389 times per frame at 262144 Hz');
  void divBefore; void timaStart;
});

test('APU pullBlock drains exactly the buffered frames', () => {
  const apu = new APU();
  for (let i = 0; i < 300; i++) apu.pushSample(0.1, 0.2);
  const L = new Float32Array(128), R = new Float32Array(128);
  let total = 0, pulls = 0;
  while (true) {
    const n = apu.pullBlock(L, R);
    if (!n) break;
    total += n; pulls++;
  }
  assert.strictEqual(total, 300);
  assert.strictEqual(pulls, Math.ceil(300 / 128));
  assert.strictEqual(apu.available(), 0);
  assert.strictEqual(apu.pullBlock(L, R), 0, 'underrun pull returns 0');
});
