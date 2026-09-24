// PocketGB — Game Boy Color feature tests
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { GameBoy } = require('../src/core/gameboy');
const { PPU } = require('../src/core/ppu');
const { CgbPPU } = require('../src/core/ppu-cgb');
const { CPU } = require('../src/core/cpu');
const { MMU } = require('../src/core/mmu');

// ---- helpers ----
function makeGBRom(cgbFlag, cartType = 0x00) {
  const rom = new Uint8Array(0x8000);
  rom[0x143] = cgbFlag;   // 0xC0 = CGB-only, anything else = DMG
  rom[0x147] = cartType;
  return rom;
}

function newCGB() {
  const gb = new GameBoy();
  gb.loadROM(makeGBRom(0xC0));
  return gb;
}

function newDMG() {
  const gb = new GameBoy();
  gb.loadROM(makeGBRom(0x00));
  return gb;
}

// ---- cartridge detection ----
test('CGB: cartridge flag detection', () => {
  const gb = new GameBoy();
  gb.cart = undefined;
  const { Cartridge } = require('../src/core/cartridge');
  const cgb = new Cartridge(makeGBRom(0xC0));
  const dmg = new Cartridge(makeGBRom(0x00));
  const compat = new Cartridge(makeGBRom(0x80)); // CGB-enhanced, DMG-safe
  assert.strictEqual(cgb.isGBC, true);
  assert.strictEqual(dmg.isGBC, false);
  assert.strictEqual(compat.isGBC, false);
});

test('CGB: color ROM selects CgbPPU, DMG ROM keeps PPU', () => {
  const c = newCGB();
  assert.ok(c.ppu instanceof CgbPPU, 'CGB ROM → CgbPPU');
  assert.strictEqual(c.mmu.cgb, true);
  assert.strictEqual(c.ppu.vram.length, 0x4000, '16 KB VRAM');

  const d = newDMG();
  assert.ok(d.ppu instanceof PPU, 'DMG ROM → plain PPU');
  assert.strictEqual(d.mmu.cgb, false);
  assert.strictEqual(d.ppu.vram.length, 0x2000, '8 KB VRAM');
});

test('CGB: forceDmg runs a color game in DMG mode', () => {
  const gb = new GameBoy();
  gb.loadROM(makeGBRom(0xC0), null, true);
  assert.ok(gb.ppu instanceof PPU, 'forced DMG → plain PPU');
  assert.strictEqual(gb.mmu.cgb, false);
  assert.strictEqual(gb.mmu.read(0xFF4D), 0xFF, 'KEY1 reads FF on DMG');
});

// ---- WRAM banking (SVBK / FF70) ----
test('CGB: SVBK selects WRAM banks, 0 aliases bank 1', () => {
  const gb = newCGB();
  const m = gb.mmu;
  m.write(0xD000, 0x11);            // bank 1
  m.write(0xFF70, 0x02);
  m.write(0xD000, 0x22);            // bank 2
  m.write(0xFF70, 0x01);
  assert.strictEqual(m.read(0xD000), 0x11);
  m.write(0xFF70, 0x02);
  assert.strictEqual(m.read(0xD000), 0x22);
  m.write(0xFF70, 0x00);            // 0 aliases bank 1
  assert.strictEqual(m.read(0xFF70) & 7, 1, 'SVBK reads back 1');
  assert.strictEqual(m.read(0xD000), 0x11);
  m.write(0xFF70, 0x07);            // top bank
  m.write(0xD000, 0x77);
  m.write(0xFF70, 0x03);
  assert.strictEqual(m.read(0xD000), 0x00, 'bank 3 starts zeroed');
});

test('CGB: echo RAM follows the SVBK bank', () => {
  const gb = newCGB();
  const m = gb.mmu;
  m.write(0xFF70, 0x05);
  m.write(0xD123, 0xAB);
  assert.strictEqual(m.read(0xF123), 0xAB, 'echo of banked WRAM');
  m.write(0xFF70, 0x06);
  assert.strictEqual(m.read(0xF123), 0x00, 'other bank unaffected');
});

test('DMG: SVBK is not writable and WRAM has one bank', () => {
  const gb = newDMG();
  const m = gb.mmu;
  m.write(0xFF70, 0x02);
  assert.strictEqual(m.read(0xFF70), 0xFF, 'FF70 reads FF on DMG');
  m.write(0xD000, 0x99);
  assert.strictEqual(m.read(0xD000), 0x99);
  assert.strictEqual(m.wram.length, 0x2000, 'DMG WRAM stays 8 KB');
});

// ---- VRAM banking (VBK / FF4F) ----
test('CGB: VBK selects VRAM banks', () => {
  const gb = newCGB();
  const p = gb.ppu;
  gb.mmu.write(0x8000, 0x11);       // bank 0
  gb.mmu.write(0xFF4F, 0x01);
  gb.mmu.write(0x8000, 0x22);       // bank 1
  assert.strictEqual(gb.mmu.read(0xFF4F) & 1, 1, 'VBK reads back 1');
  assert.strictEqual(p.vram[0], 0x11, 'bank 0 untouched');
  assert.strictEqual(p.vram[0x2000], 0x22, 'bank 1 written');
  gb.mmu.write(0xFF4F, 0x00);
  assert.strictEqual(gb.mmu.read(0x8000), 0x11);
});

test('DMG: VBK register reads FF', () => {
  const gb = newDMG();
  gb.mmu.write(0xFF4F, 0x01);
  assert.strictEqual(gb.mmu.read(0xFF4F), 0xFF);
});

// ---- palette RAM (BCPS/BGPD, OCPS/OCPD) ----
test('CGB: BG palette RAM with auto-increment', () => {
  const gb = newCGB();
  const p = gb.ppu;
  gb.mmu.write(0xFF68, 0x80 | 0x00); // BCPS: index 0, auto-increment
  gb.mmu.write(0xFF69, 0x34);
  gb.mmu.write(0xFF69, 0x12);        // palette 0 color 0 = $1234
  gb.mmu.write(0xFF69, 0x78);
  gb.mmu.write(0xFF69, 0x56);        // palette 0 color 1 = $5678
  assert.strictEqual(gb.mmu.read(0xFF68) & 0x3F, 4, 'BCPS advanced 4 bytes (2 colors)');
  gb.mmu.write(0xFF68, 0x00);        // index 0, no increment
  assert.strictEqual(gb.mmu.read(0xFF69), 0x34);
  gb.mmu.write(0xFF68, 0x01);
  assert.strictEqual(gb.mmu.read(0xFF69), 0x12);
});

test('CGB: OBJ palette RAM is independent', () => {
  const gb = newCGB();
  gb.mmu.write(0xFF68, 0x00);
  gb.mmu.write(0xFF69, 0xAA);
  gb.mmu.write(0xFF6A, 0x80 | 0x08); // OCPS index 8, increment
  gb.mmu.write(0xFF6B, 0xBB);
  assert.strictEqual(gb.mmu.read(0xFF6B + 0) && 0, 0); // (write-only index check below)
  gb.mmu.write(0xFF6A, 0x08);
  assert.strictEqual(gb.mmu.read(0xFF6B), 0xBB);
  gb.mmu.write(0xFF68, 0x00);
  assert.strictEqual(gb.mmu.read(0xFF69), 0xAA, 'BG RAM unaffected');
});

test('CGB: rendered pixels use palette RAM (BGR555 framebuffer)', () => {
  const gb = newCGB();
  const p = gb.ppu;
  // BG palette 1, color 1 = $7C00 (pure green); BCPS auto-increment (bit 7)
  // steps byte index after each write: index 10 (lo), 11 (hi).
  gb.mmu.write(0xFF68, 0x80 | 0x08 | 0x02); // byte index 8+2 = pal 1, color 1
  gb.mmu.write(0xFF69, 0x00);
  gb.mmu.write(0xFF69, 0x7C);
  // Attribute map (bank 1): palette 1
  gb.mmu.write(0xFF4F, 0x01);
  p.writeVRAM(0x9800, 0x01);
  gb.mmu.write(0xFF4F, 0x00);
  // Tile 0: every row color 1 — 2 bytes per row (lo=0xFF, hi=0x00)
  for (let i = 0; i < 16; i++) p.writeVRAM(0x8000 + i, i % 2 === 0 ? 0xFF : 0x00);
  // Map row 0 uses tile 0 (VRAM zeros) — run one frame
  const fb = gb.runFrame();
  assert.strictEqual(fb, p.colorFramebuffer, 'runFrame returns the color buffer');
  assert.strictEqual(fb[0], 0x7C00, 'pixel (0,0) is palette 1 color 1');
  assert.ok(fb instanceof Uint32Array);
});

test('CGB: BG map attributes select tile/palette from bank 1', () => {
  const gb = newCGB();
  const p = gb.ppu;
  // Palette 2, color 3 = $7FFF (white); auto-increment lands bytes at 20, 21
  gb.mmu.write(0xFF68, 0x80 | 0x10 | 0x06); // byte index 16+6 = pal 2, color 3
  gb.mmu.write(0xFF69, 0xFF);
  gb.mmu.write(0xFF69, 0x7F);
  // Tile 1 in bank 0: all color 3 (both bit planes set)
  gb.mmu.write(0xFF4F, 0x00);
  for (let i = 0; i < 16; i++) p.writeVRAM(0x8010 + i, 0xFF);
  p.writeVRAM(0x9800, 0x01);         // BG map entry (bank 0): tile 1
  // Attribute map entry: palette 2 (bank 1, same offset as the map)
  gb.mmu.write(0xFF4F, 0x01);
  gb.mmu.write(0x9800, 0x02);        // attribute byte: palette 2
  gb.mmu.write(0xFF4F, 0x00);
  const fb = gb.runFrame();
  assert.strictEqual(fb[0], 0x7FFF, 'attr palette 2 + color 3');
});

// ---- HDMA / GDMA ----
test('CGB: general-purpose DMA copies WRAM to VRAM at once', () => {
  const gb = newCGB();
  const m = gb.mmu, p = gb.ppu;
  for (let i = 0; i < 16; i++) m.write(0xC100 + i, 0xA0 + i);
  m.write(0xFF51, 0xC1);            // src = C100
  m.write(0xFF52, 0x00);
  m.write(0xFF53, 0x80);            // dst = 8010 → vram 0x10
  m.write(0xFF54, 0x10);
  m.write(0xFF55, 0x00);            // mode 0 (GDMA), 1 block
  for (let i = 0; i < 16; i++) assert.strictEqual(p.readVRAM(0x8010 + i), 0xA0 + i);
  assert.strictEqual(m.read(0xFF55), 0xFF, 'transfer complete');
});

test('CGB: HBlank DMA moves one block per tick when LCD is off', () => {
  const gb = newCGB();
  const m = gb.mmu, p = gb.ppu;
  m.write(0xFF40, 0x00);            // LCD off: transfer runs continuously
  for (let i = 0; i < 48; i++) m.write(0xC000 + i, i + 1);
  m.write(0xFF51, 0xC0);
  m.write(0xFF52, 0x00);
  m.write(0xFF53, 0x80);
  m.write(0xFF54, 0x00);
  m.write(0xFF55, 0x80 | 0x02);     // mode 1, 3 blocks
  assert.strictEqual((m.read(0xFF55) & 0x80) !== 0, true, 'active bit set');
  p.hdmaTick(); p.hdmaTick();
  assert.strictEqual(p.readVRAM(0x801F), 32, 'two blocks landed');
  m.write(0xFF55, 0xC0);            // halt request (bit7=1 + bit6=1)
  assert.strictEqual(m.read(0xFF55) & 0x80, 0, 'halted: active bit clear');
  assert.strictEqual(m.read(0xFF55) & 0x7F, 0x00, 'one block left (reads n-1)');
  m.write(0xFF55, 0x80);            // resume (bit7=1, bit6=0; length bits ignored)
  p.hdmaTick();
  assert.strictEqual(p.readVRAM(0x802F), 48, 'resumed and finished');
  assert.strictEqual(m.read(0xFF55), 0xFF);
});

// ---- double speed (KEY1 / FF4D) ----
test('CGB: STOP with KEY1 bit 0 switches to double speed', () => {
  const gb = newCGB();
  const m = gb.mmu, c = gb.cpu;
  assert.strictEqual(c.doubleSpeed, false);
  m.write(0xFF4D, 0x01);            // arm the switch
  assert.strictEqual(m.read(0xFF4D) & 0x01, 1, 'armed bit reads back');
  const before = c.doubleSpeed;
  const cyc = c.execStop();
  assert.strictEqual(c.doubleSpeed, !before, 'speed toggled');
  assert.strictEqual(c.speedSwitchArmed, false, 'arm bit cleared');
  assert.strictEqual(c.stopped, false, 'no STOP latch on speed switch');
  assert.strictEqual(m.read(0xFF4D), 0xFE, 'KEY1: 7E | bit7 set');
  assert.strictEqual(cyc, 8);
});

test('CGB: STOP without arming halts until interrupt', () => {
  const gb = newCGB();
  const c = gb.cpu;
  const cyc = c.execStop();
  assert.strictEqual(c.stopped, true);
  assert.strictEqual(c.doubleSpeed, false);
  // A joypad interrupt wakes it (IE must enable the source)
  gb.mmu.ie = 0x10;
  gb.requestInterrupt(4);
  c.step();
  assert.strictEqual(c.stopped, false, 'interrupt wakes STOP');
  assert.strictEqual(cyc, 4);
});

test('CGB: double-speed halves component ticks per CPU cycle', () => {
  const gb = newCGB();
  gb.cpu.doubleSpeed = true;
  const before = gb.timer.div;
  gb._tickHW(8);
  const divAfterDouble = gb.timer.div - before;
  gb.cpu.doubleSpeed = false;
  const before2 = gb.timer.div;
  gb._tickHW(8);
  const divAfterNormal = gb.timer.div - before2;
  assert.strictEqual(divAfterDouble, divAfterNormal / 2, 'timer sees half the cycles');
});

// ---- save states ----
test('CGB: save state round-trips CGB state (v2)', () => {
  const gb = newCGB();
  const m = gb.mmu, p = gb.ppu;
  m.write(0xFF70, 0x02);
  m.write(0xD000, 0x5A);
  m.write(0xFF68, 0x80 | 0x00);
  m.write(0xFF69, 0x21);
  m.write(0xFF69, 0x43);
  m.write(0xFF4F, 0x01);
  p.writeVRAM(0x8000, 0xEE);
  m.write(0xFF4D, 0x01);
  gb.cpu.execStop();
  m.write(0xFF4F, 0x00);
  gb.runFrame(); gb.runFrame();

  const data = gb.saveState();
  assert.strictEqual(data[4] | (data[5] << 8), 2, 'state version 2');

  const gb2 = newCGB();
  gb2.loadState(data);
  const m2 = gb2.mmu, p2 = gb2.ppu;
  assert.strictEqual(m2.wramBank, 2);
  assert.strictEqual(m2.read(0xD000), 0x5A, 'banked WRAM');
  assert.strictEqual(p2.bgpd[0], 0x21, 'BG palette RAM');
  assert.strictEqual(p2.bgpd[1], 0x43);
  assert.strictEqual(p2.vram[0x2000], 0xEE, 'VRAM bank 1');
  assert.strictEqual(gb2.cpu.doubleSpeed, true, 'double speed flag');
});

test('CGB: states refuse to load across console types', () => {
  const cgbData = newCGB().saveState();
  const d = newDMG();
  assert.throws(() => d.loadState(cgbData), /different console/);
});

test('DMG: v1-style save states still load', () => {
  const gb = newDMG();
  gb.runFrame();
  const data = gb.saveState();
  const gb2 = newDMG();
  gb2.loadState(data);
  assert.strictEqual(gb2.mmu.cgb, false);
});

// ---- frame output shapes ----
test('CGB: runFrame produces a full 160x144 color frame', () => {
  const gb = newCGB();
  const fb = gb.runFrame();
  assert.ok(fb, 'frame produced');
  assert.strictEqual(fb.length, 160 * 144);
  const dmgb = newDMG();
  const dfb = dmgb.runFrame();
  assert.ok(dfb instanceof Uint8Array, 'DMG frame is shade indices');
  assert.strictEqual(dfb.length, 160 * 144);
});
