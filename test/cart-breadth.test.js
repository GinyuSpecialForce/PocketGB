'use strict';
// Cart-breadth tests: MBC30 bank range, HuC1/HuC3 selection, MBC1M multicart
// banking, and the rumble hook. Carts are synthesized with valid headers.

const { test } = require('node:test');
const assert = require('node:assert');
const { Cartridge } = require('../src/core/cartridge');

function makeCart({ romBanks, cartType, ramSizeCode = 0, title = 'TEST' }) {
  const size = romBanks * 0x4000;
  const rom = new Uint8Array(size);
  // header
  for (let i = 0; i < title.length && i < 15; i++) rom[0x134 + i] = title.charCodeAt(i);
  rom[0x147] = cartType;
  rom[0x148] = { 2: 0, 4: 1, 8: 2, 16: 3, 32: 4, 64: 5, 128: 6, 256: 7, 512: 8 }[romBanks] ?? 8;
  rom[0x149] = ramSizeCode;
  // stamp each bank with its number so banking is verifiable
  for (let b = 0; b < romBanks; b++) {
    rom[b * 0x4000] = b & 0xFF;
    rom[b * 0x4000 + 1] = (b >> 8) & 0xFF;
  }
  return new Cartridge(rom);
}

test('MBC30 (type 0x1F) supports 9-bit ROM banks', () => {
  const c = makeCart({ romBanks: 512, cartType: 0x1F, ramSizeCode: 3 });
  assert.strictEqual(c.mbc, 30);
  // 9-bit bank: low byte at 2000-3FFF, bit 8 from bit0 of the 4000-5FFF write
  c.handleBankWrite(0x4000, 0x01); // bank bit 8 set first
  c.handleBankWrite(0x2000, 0xFF); // low byte
  assert.strictEqual(c.romBank & 0x1FF, 0x1FF);
  assert.strictEqual(c.readRom(0x4000), 0xFF); // bank 511 stamped 0xFF,0x01
});

test('HuC3 (type 0xFE) is selected and banks like MBC3', () => {
  const c = makeCart({ romBanks: 64, cartType: 0xFE, ramSizeCode: 3 });
  assert.strictEqual(c.mbc, 'HUC3');
  c.handleBankWrite(0x2000, 5);
  assert.strictEqual(c.readRom(0x4000), 5);
});

test('HuC1 (type 0xFD) is selected and banks like MBC1', () => {
  const c = makeCart({ romBanks: 64, cartType: 0xFD, ramSizeCode: 0 });
  assert.strictEqual(c.mbc, 'HUC1');
  c.handleBankWrite(0x2000, 7);
  assert.strictEqual(c.readRom(0x4000), 7);
});

test('MBC1M multicart: bank2 selects the 512 KB group in the low area', () => {
  const c = makeCart({ romBanks: 256, cartType: 0x01 });
  assert.strictEqual(c.mbc1m, true);
  c.handleBankWrite(0x6000, 1);   // mode 1 (already implied for mbc1m)
  c.handleBankWrite(0x4000, 3);   // group 3
  c.handleBankWrite(0x2000, 1);   // inner bank 1
  assert.strictEqual(c.readRom(0x0000), (3 << 5) & 0xFF);        // low area = group base
  assert.strictEqual(c.readRom(0x4000), ((3 << 5) | 1) & 0xFF);  // high = group bank 1
});

test('MBC5 rumble write triggers the hook', () => {
  const c = makeCart({ romBanks: 32, cartType: 0x1C, ramSizeCode: 0 });
  assert.strictEqual(c.hasRumble, true);
  let rumble = null;
  c.onRumble = (on) => { rumble = on; };
  c.handleBankWrite(0x4000, 0x08);
  assert.strictEqual(rumble, true);
  c.handleBankWrite(0x4000, 0x00);
  assert.strictEqual(rumble, false);
});

test('regular MBC1 (≤32 banks) does not get MBC1M treatment', () => {
  const c = makeCart({ romBanks: 32, cartType: 0x01 });
  assert.strictEqual(c.mbc1m, false);
});
