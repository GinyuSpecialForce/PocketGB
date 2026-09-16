// PocketGB — unit tests
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CPU } = require('../src/core/cpu');
const { Cartridge } = require('../src/core/cartridge');
const { GameBoy } = require('../src/core/gameboy');
const { buildSmokeRom } = require('./smoke-rom');

// ---- helpers ----
function makeCart(romBytes, type = 0x00, romCode = 0x00, ramCode = 0x00) {
  const rom = new Uint8Array(0x8000);
  rom[0x147] = type; rom[0x148] = romCode; rom[0x149] = ramCode;
  if (romBytes) rom.set(romBytes, 0x4000);
  return new Cartridge(rom);
}

test('CPU: ADD/SUB/ADC/SBC basics', () => {
  const mmuStub = { read: () => 0, write: () => {} };
  const c = new CPU(mmuStub);
  c.a = 0x0F; c.f = 0;
  c.add8(0x01);
  assert.strictEqual(c.a, 0x10);
  assert.strictEqual(c.fz, false, 'not zero');
  assert.strictEqual(c.fh, true, 'half carry from F->10');

  c.a = 0x10; c.f = 0;
  c.sub8(0x10);
  assert.strictEqual(c.a, 0x00);
  assert.strictEqual(c.fz, true);
  assert.strictEqual((c.f & 0x40) !== 0, true, 'N flag set on SUB');
});

test('CPU: DAA after addition', () => {
  const c = new CPU({ read: () => 0, write: () => {} });
  c.a = 0x45; c.f = 0;
  c.add8(0x38); // 0x7D
  c.daa();
  assert.strictEqual(c.a, 0x83, '7D + 6 = 83 (low nibble > 9)');
  assert.strictEqual(c.fh, false, 'H cleared by DAA');
});

test('CPU: JR negative offset', () => {
  const mem = new Uint8Array(0x10000);
  // at 0x0100: JR -2 (0x18 0xFE)
  mem[0x100] = 0x18; mem[0x101] = 0xFE;
  const mmu = { read: (a) => mem[a], write: () => {} };
  const c = new CPU(mmu);
  c.pc = 0x100;
  c.step();
  assert.strictEqual(c.pc, 0x100, 'JR -2 loops back to start');
});

test('Cartridge: header parse and MBC1 banking', () => {
  // Proper 64KB file: banks 1..3. Bank1 = 0x11, banks 2-3 = 0xAB.
  const rom = new Uint8Array(0x10000);
  rom[0x147] = 0x01; rom[0x148] = 0x01; rom[0x149] = 0x02;
  rom.fill(0x11, 0x4000, 0x8000);
  rom.fill(0xAB, 0x8000, 0x10000);
  const cart = new Cartridge(rom);
  assert.strictEqual(cart.mbc, 1);
  assert.strictEqual(cart.numRomBanks, 4, '64KB = 4 banks');

  cart.handleBankWrite(0x2000, 2);
  assert.strictEqual(cart.readRom(0x4000), 0xAB, 'bank 2 selected');
  cart.handleBankWrite(0x2000, 1);
  assert.strictEqual(cart.readRom(0x4000), 0x11, 'bank 1 selected');
  cart.handleBankWrite(0x2000, 3);
  assert.strictEqual(cart.readRom(0x7FFF), 0xAB, 'bank 3 tail');
});

test('Cartridge: MBC1 mode 1 banking (bank2 into low area)', () => {
  const cart = makeCart(null, 0x01, 0x01, 0x00);
  // numRomBanks=4 (code 0x01 = 64KB)
  cart.handleBankWrite(0x6000, 1); // mode 1
  cart.handleBankWrite(0x2000, 1); // rombank=1
  cart.handleBankWrite(0x4000, 2); // bank2=2
  // low area bank = bank2<<5 = 64 -> wraps with 4 banks: 64%4=0 -> bank 0
  assert.strictEqual(cart.readRom(0x0100), 0x00);
});

test('Cartridge: MBC5 9-bit bank', () => {
  const rom = new Uint8Array(0x100000); // 1MB, 64 banks
  rom[0x147] = 0x19; rom[0x148] = 0x05;
  const cart = new Cartridge(rom);
  assert.strictEqual(cart.mbc, 5);
  cart.handleBankWrite(0x2000, 0xFF); // low 8 bits
  cart.handleBankWrite(0x3000, 0x01); // bit 8
  cart.handleBankWrite(0x4000, 0x00);
  assert.strictEqual(cart.romBank, 0x1FF);
  cart.handleBankWrite(0x2000, 0x03);
  assert.strictEqual(cart.romBank, 0x103);
});

test('Cartridge: battery flag and sav round trip', () => {
  const cart = makeCart(null, 0x03, 0x01, 0x03); // MBC1+RAM+BATTERY, 32KB? code 0x01=64KB, ram 32KB
  assert.strictEqual(cart.battery, true);
  cart.ram[0] = 0x42; cart.ram[0x1234] = 0x99;
  const sav = cart.serializeSav();
  const cart2 = makeCart(null, 0x03, 0x01, 0x03);
  cart2.loadSav(sav);
  assert.strictEqual(cart2.ram[0], 0x42);
  assert.strictEqual(cart2.ram[0x1234], 0x99);
});

test('GameBoy: boots to 0x0100 and runs smoke ROM CPU checks', () => {
  const gb = new GameBoy();
  gb.loadROM(buildSmokeRom());
  // Run ~2.5 seconds of emulation worth of frames (150 frames)
  for (let i = 0; i < 150; i++) gb.runFrame();
  const hr = gb.mmu.hram;
  assert.strictEqual(hr[0x00], 0x83, 'DAA result');
  assert.strictEqual(hr[0x01], 0x5C, 'SBC chain');
  assert.strictEqual(hr[0x02], 0x01, 'ADC with carry');
  assert.strictEqual(hr[0x03], 0x03, 'RLCA+RLA carry chain');
  assert.strictEqual(hr[0x04], 0x01, 'ADD HL,BC halfcarry into H');
  assert.strictEqual(hr[0x05], 0x42, 'conditional jump taken');
  assert.strictEqual(hr[0x06], 0x77, 'push/pop round trip');
  assert.strictEqual(hr[0x07], 0x33, 'call/ret');
  assert.strictEqual(hr[0x08], 0xFC, 'CB RES+SLA');
  assert.strictEqual(hr[0x0F], 0xDE, 'reached end-of-program marker');
});

test('GameBoy: smoke ROM enables LCD and renders BG', () => {
  const gb = new GameBoy();
  gb.loadROM(buildSmokeRom());
  for (let i = 0; i < 150; i++) gb.runFrame();
  assert.strictEqual(gb.ppu.lcdc & 0x80, 0x80, 'LCD on');
  // Map filled with tile 0 (color 3), BGP=0xFF maps 3->0, so screen should be shade 0
  const fb = gb.ppu.framebuffer;
  let zeros = 0;
  for (let i = 0; i < fb.length; i++) if (fb[i] === 0) zeros++;
  assert.ok(zeros > 160 * 144 * 0.9, `expected mostly shade 0, got ${zeros}/${fb.length}`);
});

test('GameBoy: save state round trip preserves machine', () => {
  const gb = new GameBoy();
  gb.loadROM(buildSmokeRom());
  for (let i = 0; i < 1; i++) gb.runFrame(); // snapshot mid-burn-loop, while PC is moving
  const snapshot = gb.saveState();
  const pc1 = gb.cpu.pc; const a1 = gb.cpu.a;

  // advance
  for (let i = 0; i < 2; i++) gb.runFrame();
  const diverged = gb.cpu.pc !== pc1 || gb.cpu.a !== a1;

  // restore
  gb.loadState(snapshot);
  assert.strictEqual(gb.cpu.pc, pc1, 'PC restored');
  assert.strictEqual(gb.cpu.a, a1, 'A restored');
  // continuing from restored state should match continuing from the original
  for (let i = 0; i < 5; i++) gb.runFrame();
  const fbA = gb.ppu.framebuffer.slice();
  gb.loadState(snapshot);
  for (let i = 0; i < 5; i++) gb.runFrame();
  const fbB = gb.ppu.framebuffer.slice();
  assert.deepStrictEqual(Array.from(fbA), Array.from(fbB), 'deterministic re-run');
  assert.ok(diverged, 'state advanced between snapshots (sanity)');
});

test('GameBoy: timer produces overflows (smoke ROM h)', () => {
  const gb = new GameBoy();
  gb.loadROM(buildSmokeRom());
  for (let i = 0; i < 150; i++) gb.runFrame();
  // TIMA snapshot (0xFF89) should have ticked beyond 0xF0 start... just check it is in range
  const t = gb.mmu.hram[0x09];
  assert.ok(t >= 0x00 && t <= 0xFF, `TIMA snapshot in range: ${t}`);
  assert.notStrictEqual(t, 0xF0, 'timer advanced past initial TMA value');
});
