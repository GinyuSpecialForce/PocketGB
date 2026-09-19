'use strict';
// Tests for the cheat finder (CheatFinder in src/core/cheats.js).
// Uses a stub MMU whose read() is backed by a plain byte array — the finder
// only requires mmu.read(addr) → 0-255.
const { test } = require('node:test');
const assert = require('node:assert');
const { CheatFinder, CheatEngine, gsFreezeCode } = require('../src/core/cheats');

const WRAM = new Uint8Array(0x2000);
const HRAM = new Uint8Array(0x7F);
function stubMmu() {
  return { read(a) {
    a &= 0xFFFF;
    if (a >= 0xC000 && a < 0xE000) return WRAM[a - 0xC000];
    if (a >= 0xFF80 && a < 0xFFFF) return HRAM[a - 0xFF80];
    return 0xFF;
  }, write(a, v) {
    a &= 0xFFFF; v &= 0xFF;
    if (a >= 0xC000 && a < 0xE000) WRAM[a - 0xC000] = v;
    if (a >= 0xFF80 && a < 0xFFFF) HRAM[a - 0xFF80] = v;
  } };
}
function w(addr, v) { WRAM[addr - 0xC000] = v & 0xFF; }
function h(addr, v) { HRAM[addr - 0xFF80] = v & 0xFF; }

test('search finds all matching bytes in WRAM and HRAM', () => {
  WRAM.fill(0); HRAM.fill(0);
  w(0xC123, 42); w(0xD456, 42); h(0xFF90, 42);
  w(0xC124, 7);
  const f = new CheatFinder(stubMmu);
  const n = f.search(42);
  assert.strictEqual(n, 3);
  assert.ok(f.candidates.has(0xC123) && f.candidates.has(0xD456) && f.candidates.has(0xFF90));
  assert.ok(!f.candidates.has(0xC124));
});

test('narrow eq / changed / unchanged / plus / minus', () => {
  WRAM.fill(0); HRAM.fill(0);
  // lives=5 at C001, score-looper at C002, static at C003
  w(0xC001, 5); w(0xC002, 10); w(0xC003, 99);
  const f = new CheatFinder(stubMmu);
  f.search(5);                    // only C001 starts at 5
  // mutate: lives→8, looper→11, static stays
  w(0xC001, 8); w(0xC002, 11);
  assert.strictEqual(f.narrow({ op: 'unchanged' }), 0, 'C001 changed, so unchanged keeps nothing here');

  // fresh: track all three by unknown init, then changed → 2
  w(0xC001, 5); w(0xC002, 10); w(0xC003, 99); // reset (shared WRAM)
  const f2 = new CheatFinder(stubMmu);
  f2.search(null);
  w(0xC001, 8); w(0xC002, 13); // C003 stays 99
  assert.strictEqual(f2.narrow({ op: 'changed' }), 2);
  // play: both move +3 since the last scan (8→11, 13→16)
  w(0xC001, 11); w(0xC002, 16);
  assert.strictEqual(f2.narrow({ op: 'plus', value: 3 }), 2);
  // play: only C001 moves (+1 → 12); C002 stays 16
  w(0xC001, 12);
  assert.strictEqual(f2.narrow({ op: 'plus', value: 1 }), 1);
  assert.ok(f2.candidates.has(0xC001));
  // eq to current value (no play in between: value is still 12)
  assert.strictEqual(f2.narrow({ op: 'eq', value: 12 }), 1);
  // gt
  assert.strictEqual(f2.narrow({ op: 'gt', value: 8 }), 1);
  // ne
  assert.strictEqual(f2.narrow({ op: 'ne', value: 4 }), 1);
  // last: a deliberately-emptying filter (narrow consumes the candidate set)
  assert.strictEqual(f2.narrow({ op: 'lt', value: 5 }), 0);
});

test('freeze promotes a candidate to a working GameShark code', () => {
  WRAM.fill(0); HRAM.fill(0);
  w(0xC0F0, 99);
  const f = new CheatFinder(stubMmu);
  f.search(99);
  assert.ok(f.candidates.has(0xC0F0));
  const engine = new CheatEngine();
  const r = f.freeze(0xC0F0, engine); // freeze at current value
  assert.ok(!r.error, 'freeze produced a code');
  assert.strictEqual(engine.gsCodes.length, 1);
  assert.strictEqual(engine.gsCodes[0].addr, 0xC0F0);
  assert.strictEqual(engine.gsCodes[0].value, 99);
  // the generated code string is the canonical 01 VV LL HH form
  assert.strictEqual(engine.gsCodes[0].code, gsFreezeCode(0xC0F0, 99));
  assert.strictEqual(gsFreezeCode(0xC0F0, 99), '0163F0C0');
  // and the engine applies it to the mmu
  w(0xC0F0, 0);
  engine.applyRAM(stubMmu());
  assert.strictEqual(WRAM[0xC0F0 - 0xC000], 99, 'frozen code forces the value');
});
