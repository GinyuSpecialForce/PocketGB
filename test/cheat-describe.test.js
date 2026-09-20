'use strict';
// Tests for describeCheat (src/core/cheats.js): every cheat shown in the UI
// gets a plain-language explanation of what it does to the machine.

const { test } = require('node:test');
const assert = require('node:assert');
const { CheatEngine, describeCheat } = require('../src/core/cheats');

function add(engine, code) {
  const res = engine.add(code);
  assert.ok(!res.error, `code ${code} parses: ${res.error || 'ok'}`);
  return res;
}

test('GameShark descriptions: region, value, intent', () => {
  const e = new CheatEngine();
  // 010238CD → write 0x02 to 0xCD38 (work RAM)
  const gs = add(e, '010238CD');
  const d = describeCheat(gs);
  assert.match(d, /writes 02 \(2\) to work RAM at \$CD38/);
  assert.match(d, /every frame/);
  // value-intent hints
  assert.match(describeCheat(add(e, '010038CD')), /pins the value to zero/);
  assert.match(describeCheat(add(e, '016338CD')), /forces 99/);
  assert.match(describeCheat(add(e, '01FF38CD')), /pins the value to 255/);
  // ASCII digit hint
  assert.match(describeCheat(add(e, '013538CD')), /ASCII digit/);
  // I/O register warning
  assert.match(describeCheat(add(e, '01FF00FF')), /I\/O register/);
  // cartridge RAM region naming
  assert.match(describeCheat(add(e, '01FF00A0')), /cartridge RAM/);
  // high RAM naming ($FF80, HRAM start)
  assert.match(describeCheat(add(e, '01FF80FF')), /high RAM/);
});

test('Game Genie descriptions: patch semantics and compare', () => {
  const e = new CheatEngine();
  // Documented example: 068-5FF-E66 → addr 0x085F, value 0x06, compare 0x03
  const gg = add(e, '068-5FF-E66');
  const d = describeCheat(gg);
  assert.match(d, /replaces the ROM byte at \$085F with 06/);
  assert.match(d, /only when the original byte is 03/);
  // no-compare variant states unconditional behavior
  const gg9 = add(e, '0685FF');
  const d9 = describeCheat(gg9);
  assert.match(d9, /unconditionally/);
  // boot-region warning: 12048F decodes to addr $0048 (interrupt vector area)
  assert.match(describeCheat(add(e, '12048F')), /interrupt vector region/);
});

test('descriptions do not throw on edge codes and always return text', () => {
  const e = new CheatEngine();
  for (const code of ['01FF0000', '01FFFF7F', '9120D2D2', '0FFFFFF', '3FFFFFF', 'FFFFFF', '010238CD']) {
    const res = e.add(code);
    if (res.error) continue; // invalid codes simply never reach the UI
    const d = describeCheat(res);
    assert.equal(typeof d, 'string');
    assert.ok(d.length > 10);
  }
});
