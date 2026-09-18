'use strict';
// Tests for the cheat engine (src/core/cheats.js).
//
// GameShark field order is pinned against Pan Docs' documented example
// (010238CD → write 0x02 at 0xCD38) and against real published codes from
// the Super Mario Bros. Deluxe GameShark list, whose leading tag byte is
// not always 01 (e.g. 9120D2D2 "Disable All Enemies"). The first byte is
// the device's bank tag and is ignored, matching mGBA's decoder.
// (An earlier version also read the middle pair as the address, which sent
// every code to a garbage RAM address and made all GameShark cheats do
// nothing.)

const { test } = require('node:test');
const assert = require('node:assert');
const { CheatEngine, parseGameShark, parseGameGenie } = require('../src/core/cheats');

// ---- parsers ----

test('GameShark: Pan Docs example 010238CD = value 02 at address CD38', () => {
  assert.deepStrictEqual(parseGameShark('010238CD'), { addr: 0xCD38, value: 0x02, bank: 1 });
});

test('GameShark: lowercase, dashes and spaces are accepted', () => {
  assert.deepStrictEqual(parseGameShark('0102-38cd'), { addr: 0xCD38, value: 0x02, bank: 1 });
  assert.deepStrictEqual(parseGameShark('01 02 38 CD'), { addr: 0xCD38, value: 0x02, bank: 1 });
});

test('GameShark: leading bank tag is ignored — SMB Deluxe codes with 90/91 tags parse', () => {
  // From the published Super Mario Bros. Deluxe GameShark list:
  assert.deepStrictEqual(parseGameShark('9120D2D2'), { addr: 0xD2D2, value: 0x20, bank: 0x91 }); // Disable All Enemies
  assert.deepStrictEqual(parseGameShark('9063F2C1'), { addr: 0xC1F2, value: 0x63, bank: 0x90 }); // Inf. Coins (0x63 = 99)
  assert.deepStrictEqual(parseGameShark('90097FC1'), { addr: 0xC17F, value: 0x09, bank: 0x90 }); // Inf. Lives
});

test('GameShark: rejects wrong shapes, non-hex, and ROM addresses', () => {
  assert.strictEqual(parseGameShark('010238C'), null);      // 7 digits
  assert.strictEqual(parseGameShark('010238CDD'), null);    // 9 digits
  assert.strictEqual(parseGameShark('010238GH'), null);     // not hex
  assert.strictEqual(parseGameShark('01028000'), null);    // 0x0080 < 0x8000
  assert.strictEqual(parseGameShark('hello'), null);
  assert.strictEqual(parseGameShark(''), null);
});

test('Game Genie: documented example 068-5FF-E66 decodes exactly', () => {
  const c = parseGameGenie('068-5FF-E66');
  assert.ok(c);
  assert.strictEqual(c.addr, 0x085F);
  assert.strictEqual(c.value, 0x06);
  assert.strictEqual(c.compare, 0x03);
});

test('Game Genie: 6-digit form has no compare', () => {
  const c = parseGameGenie('0685FF');
  assert.ok(c);
  assert.strictEqual(c.addr, 0x085F);
  assert.strictEqual(c.value, 0x06);
  assert.strictEqual(c.compare, null);
});

test('Game Genie: rejects wrong lengths', () => {
  assert.strictEqual(parseGameGenie('0685F'), null);
  assert.strictEqual(parseGameGenie('0685FFE6'), null);
  assert.strictEqual(parseGameGenie('0685FFE666'), null);
});

// ---- engine ----

test('add: classifies GameShark vs Game Genie and rejects junk', () => {
  const ce = new CheatEngine();
  const gs = ce.add('010238CD');
  assert.strictEqual(gs.kind, 'gs');
  const gg = ce.add('068-5FF-E66');
  assert.strictEqual(gg.kind, 'gg');
  assert.ok(ce.add('not-a-code').error);
  assert.strictEqual(ce.all().length, 2);
});

test('remove: deletes the exact combined-list index (mistyped codes can go)', () => {
  const ce = new CheatEngine();
  ce.add('010238CD');           // index 0
  ce.add('01FFFFFF');           // index 1 — the "mistake"
  ce.add('068-5FF-E66');        // index 2
  ce.remove(1);
  assert.deepStrictEqual(ce.all().map((c) => c.code), ['010238CD', '068-5FF-E66']);
  ce.remove(1); // now the GG entry
  assert.deepStrictEqual(ce.all().map((c) => c.code), ['010238CD']);
});

test('toggle: flips only the targeted entry', () => {
  const ce = new CheatEngine();
  ce.add('010238CD');
  ce.add('068-5FF-E66');
  ce.toggle(0);
  assert.strictEqual(ce.all()[0].enabled, false);
  assert.strictEqual(ce.all()[1].enabled, true);
  ce.toggle(0);
  assert.strictEqual(ce.all()[0].enabled, true);
});

test('disabled codes are not applied', () => {
  const ce = new CheatEngine();
  const mmu = { writes: [], write(a, v) { this.writes.push([a, v]); } };
  ce.add('010238CD');
  ce.applyRAM(mmu);
  assert.deepStrictEqual(mmu.writes, [[0xCD38, 0x02]]);
  ce.toggle(0);
  ce.applyRAM(mmu);
  assert.strictEqual(mmu.writes.length, 1); // no new write while disabled
});

test('SMB Deluxe Disable All Enemies (9120D2D2) lands at the right RAM address', () => {
  const ce = new CheatEngine();
  const mmu = { writes: [], write(a, v) { this.writes.push([a, v]); } };
  ce.add('9120D2D2');
  ce.applyRAM(mmu);
  assert.deepStrictEqual(mmu.writes, [[0xD2D2, 0x20]]);
});

test('Game Genie patchROM: compare gates the patch', () => {
  const ce = new CheatEngine();
  ce.add('068-5FF-E66'); // addr 0x085F value 0x06 compare 0x03
  assert.strictEqual(ce.patchROM(0x085F, 0x03), 0x06); // compare matches
  assert.strictEqual(ce.patchROM(0x085F, 0x04), undefined); // compare fails
  assert.strictEqual(ce.patchROM(0x0860, 0x03), undefined); // wrong address
});

test('serialize/restore round-trip preserves codes and enabled flags', () => {
  const ce = new CheatEngine();
  ce.add('010238CD');
  ce.add('068-5FF-E66');
  ce.toggle(1);
  const restored = new CheatEngine();
  restored.restore(ce.serialize());
  assert.deepStrictEqual(restored.serialize(), ce.serialize());
  const mmu = { write() {} };
  ce.applyRAM(mmu); // must not throw
  assert.strictEqual(restored.patchROM(0x085F, 0x03), undefined); // GG was toggled off
});

// ---- end-to-end through the MMU (real write path) ----

test('GameShark write lands in WRAM through the real MMU', () => {
  const { GameBoy } = require('../src/core/gameboy');
  const gb = new GameBoy();
  // Minimal ROM-only cart with a real header so loadROM succeeds.
  const rom = new Uint8Array(0x8000);
  rom[0x100] = 0x00; rom[0x101] = 0xC3; rom[0x102] = 0x50; rom[0x103] = 0x01; // nop; jp $0150
  rom[0x134] = 0x54; rom[0x135] = 0x45; rom[0x136] = 0x53; rom[0x137] = 0x54; // "TEST"
  rom[0x147] = 0x00; // ROM only
  rom[0x148] = 0x00; rom[0x149] = 0x00;
  gb.loadROM(rom, null, true, null);
  gb.cheats.add('01FF40C0'); // write 0xFF to 0xC040 every frame
  gb.cheats.applyRAM(gb.mmu);
  assert.strictEqual(gb.mmu.read(0xC040), 0xFF);
});
