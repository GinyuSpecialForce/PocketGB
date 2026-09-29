'use strict';
// Regression tests for DebugView.disasmInstruction (src/ui/debug.js).
//
// The x===3 half of the decode table was wrong for whole control-flow
// families: CALL (0xCD) decoded as `DB` with size 1 (the listing desynced
// after every CALL), RET showed as "RETI", RETI as "LD SP,HL", JP HL and
// LD SP,HL printed "undefined", and the LDH/ADD SP/LD HL,SP+e8 group
// printed "RET undefined". Sizes drive listing resync, so they are asserted
// alongside the text.
const { test } = require('node:test');
const assert = require('node:assert');

globalThis.document = { getElementById: () => null };
const { DebugView } = require('../src/ui/debug.js');

function viewWith(bytes, startAddr = 0) {
  const rom = new Uint8Array(0x10000);
  rom.set(bytes, startAddr);
  const gb = { mmu: { read: (a) => rom[a & 0xFFFF] }, _breakpoints: null, cpu: { pc: startAddr }, ppu: { vram: rom } };
  return new DebugView(gb, null);
}

test('control-flow opcodes decode with correct text and size', () => {
  const cases = [
    [0xC9, 'RET', 1], [0xD9, 'RETI', 1], [0xE9, 'JP HL', 1], [0xF9, 'LD SP,HL', 1],
    [0xCD, 'CALL $1234', 3], [0xC4, 'CALL NZ,$1234', 3], [0xC3, 'JP $1234', 3],
    [0xC0, 'RET NZ', 1], [0xD8, 'RET C', 1],
    [0xE2, 'LDH (C),A', 1], [0xEA, 'LD (nn),A', 3], [0xF2, 'LDH A,(C)', 1], [0xFA, 'LD A,(nn)', 3],
    [0xE0, 'LDH ($34),A', 2], [0xF0, 'LDH A,($34)', 2], [0xE8, 'ADD SP,+52', 2], [0xF8, 'LD HL,SP+52', 2],
    [0xE4, 'DB $E4', 1], [0xDD, 'DB $DD', 1], // illegal opcodes: 1 byte, like real hardware
  ];
  for (const [op, text, size] of cases) {
    const v = viewWith([op, 0x34, 0x12]);
    const got = v.disasmInstruction(0);
    assert.strictEqual(got.text, text, `text for ${op.toString(16)}`);
    assert.strictEqual(got.size, size, `size for ${op.toString(16)}`);
  }
});

test('disasmLines stays in sync across CALL (size 3) then RET', () => {
  const v = viewWith([0xCD, 0x34, 0x12, 0xC9, 0x00]); // CALL $1234; RET; NOP
  const lines = v.disasmLines(0, 3);
  assert.ok(lines[0].startsWith(' 0000  CALL'), lines[0]);
  assert.ok(lines[1].startsWith(' 0003  RET'), `next line must be at $0003 — got: ${lines[1]}`);
  assert.ok(lines[2].startsWith(' 0004  NOP'), `and at $0004 — got: ${lines[2]}`);
});
