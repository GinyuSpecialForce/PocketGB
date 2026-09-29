'use strict';
// Tests for the AudioWorklet processor embedded in src/ui/audio.js.
//
// Regression: the underrun counter measured `n - filled` AFTER the hold-fill
// loop had already set filled === n — it always added 0, so underruns were
// never counted and the rate-limited state report fired on every block with a
// zero count. The processor is instantiated from the exported source string
// with a stubbed AudioWorkletProcessor base, exactly as the worklet runtime
// would load it.
const { test } = require('node:test');
const assert = require('node:assert');
const { AUDIO_WORKLET_SRC } = require('../src/ui/audio.js');

function loadWorklet() {
  let captured = null;
  class FakeBase {
    constructor() {
      this.port = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); } };
    }
  }
  const registerProcessor = (name, cls) => { captured = { name, cls }; };
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', AUDIO_WORKLET_SRC)(FakeBase, registerProcessor);
  assert.ok(captured, 'registerProcessor was called');
  assert.strictEqual(captured.name, 'gb-output');
  return new captured.cls();
}

function quantum(n = 128) {
  return [[new Float32Array(n), new Float32Array(n)]];
}

test('underrun frames are counted and the last sample is held', () => {
  const p = loadWorklet();
  // nothing queued: the whole quantum underruns
  let outs = quantum(128);
  p.process([], outs);
  assert.strictEqual(p.underrunFrames, 128, 'a full-quantum underrun counts 128 frames');
  assert.deepStrictEqual([...outs[0][0]], new Array(128).fill(0), 'held sample fills the gap (init 0)');
  // after producing real samples, the held value must be the last sample
  p.port.onmessage({ data: { type: 'block', l: new Float32Array([0.5, 0.25]), r: new Float32Array([-0.5, -0.25]) } });
  outs = quantum(4);
  p.process([], outs);
  assert.deepStrictEqual([...outs[0][0]], [0.5, 0.25, 0.25, 0.25], 'L: block then held');
  assert.deepStrictEqual([...outs[0][1]], [-0.5, -0.25, -0.25, -0.25], 'R: block then held');
  assert.strictEqual(p.underrunFrames, 130, 'the 2 held frames count too');
});

test('state reports are rate-limited to crossings of 16384 underrun frames', () => {
  const p = loadWorklet();
  for (let i = 0; i < 128; i++) p.process([], quantum(128)); // 16384 frames
  assert.strictEqual(p.underrunFrames, 16384);
  const states = p.port.posted.filter((m) => m.type === 'state');
  assert.strictEqual(states.length, 1, 'exactly one state report across 128 underrun blocks');
  assert.strictEqual(states[0].underrunFrames, 16384);
});

test('queued blocks drain sample-exact into the output', () => {
  const p = loadWorklet();
  const l = new Float32Array(128), r = new Float32Array(128);
  for (let i = 0; i < 128; i++) { l[i] = i / 128; r[i] = -i / 128; }
  p.port.onmessage({ data: { type: 'block', l, r } });
  const outs = quantum(128);
  p.process([], outs);
  assert.strictEqual(p.underrunFrames, 0, 'a full block covers the quantum');
  assert.deepStrictEqual([...outs[0][0]], [...l]);
  assert.deepStrictEqual([...outs[0][1]], [...r]);
});
