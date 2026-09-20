'use strict';
// Tests for the MBC7 accelerometer cartridge (src/core/mbc7.js) via the
// Cartridge integration: enable gates, latch-once semantics, tilt mapping,
// EEPROM read/write through the bit-level 93LC56 protocol.

const { test } = require('node:test');
const assert = require('node:assert');
const { Cartridge } = require('../src/core/cartridge');
const { Mbc7, MBC7_BASE } = require('../src/core/mbc7');

function makeMbc7Cart() {
  const rom = new Uint8Array(0x8000);
  rom[0x147] = 0x20; // MBC7
  rom[0x148] = 0x00; // 32 KB
  rom[0x149] = 0x03; // 32 KB cart RAM (the EEPROM-backed photo/save space)
  const cart = new Cartridge(rom);
  cart.handleBankWrite(0x0000, 0x0A); // enable 1
  cart.handleBankWrite(0x4000, 0x40); // enable 2
  return cart;
}

test('MBC7 auto-attaches for cart type 0x20 only', () => {
  const rom = new Uint8Array(0x8000);
  rom[0x147] = 0x20;
  assert.ok(new Cartridge(rom).mbc7, 'attached on 0x20');
  rom[0x147] = 0x13; // MBC3
  assert.equal(new Cartridge(rom).mbc7, null, 'not attached on other MBCs');
});

test('gates: reads return 0xFF until BOTH enables are written', () => {
  const rom = new Uint8Array(0x8000);
  rom[0x147] = 0x20;
  const cart = new Cartridge(rom);
  assert.equal(cart.readRam(0xA020), 0xFF, 'both gates closed');
  cart.handleBankWrite(0x0000, 0x0A);
  assert.equal(cart.readRam(0xA020), 0xFF, 'second gate still closed');
  cart.handleBankWrite(0x4000, 0x40);
  assert.equal(cart.readRam(0xA020), 0x00, 'pre-latch X low reads 0x00 (0x8000)');
});

test('accelerometer: erase→latch dance and once-per-erase semantics', () => {
  const cart = makeMbc7Cart();
  cart.mbc7.setTilt(-1, 0); // hard left: X below center, Y at center
  cart.writeRam(0xA000, 0x55); // erase
  cart.writeRam(0xA010, 0xAA); // latch
  const x = cart.readRam(0xA020) | (cart.readRam(0xA030) << 8);
  const y = cart.readRam(0xA040) | (cart.readRam(0xA050) << 8);
  assert.ok(x < MBC7_BASE, 'left tilt reads below center');
  assert.ok(Math.abs(y - MBC7_BASE) < 8, 'no Y tilt');
  // re-latch without erase: hardware ignores it
  cart.mbc7.setTilt(1, 0); // hard right
  cart.writeRam(0xA010, 0xAA);
  const x2 = cart.readRam(0xA020) | (cart.readRam(0xA030) << 8);
  assert.equal(x2, x, 'latch without erase is a no-op');
  // erase then latch again: updates
  cart.writeRam(0xA000, 0x55);
  cart.writeRam(0xA010, 0xAA);
  const x3 = cart.readRam(0xA020) | (cart.readRam(0xA030) << 8);
  assert.ok(x3 > MBC7_BASE, 'right tilt reads above center after re-erase');
});

test('EEPROM: EWEN then WRITE then READ round-trips a word', () => {
  const cart = makeMbc7Cart();
  const m = cart.mbc7;
  const writeReg = (v) => cart.writeRam(0xA080, v);
  const clockBit = (bit) => { writeReg(0xC0 | (bit ? 0x02 : 0x00)); writeReg(0x80 | (bit ? 0x02 : 0x00)); };
  const sendBits = (arr) => { for (const b of arr) clockBit(b); };
  const start = () => { writeReg(0x00); writeReg(0x80); }; // CS low then high
  // EWEN: 1 00 11 + 6 filler bits (10-bit frame: start+2op+addr bits 11xxxxx)
  start();
  sendBits([1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
  writeReg(0x00); // CS low ends the command
  // WRITE word 0xBEEF to address 5 (1 01 0000101)
  start();
  sendBits([1, 0, 1, 0, 0, 0, 0, 1, 0, 1]);
  sendBits([1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1]); // 0xBEEF MSB first
  writeReg(0x00); // CS low terminates
  assert.equal(m.cart.dirty, true, 'EEPROM write marks the cart dirty (save)');
  // Programming takes time: poll DO (clock with DI=0) until the ready bit
  // reads 1 — exactly what real games do before the next command.
  let polls = 0;
  while (m._busy > 0 && polls < 64) { writeReg(0xC0); writeReg(0x80); polls++; }
  assert.ok(polls < 64, 'programming finishes in bounded time');
  // READ address 5 (1 10 0000101): 10 bits then clock DO 16 times
  start();
  sendBits([1, 1, 0, 0, 0, 0, 0, 1, 0, 1]);
  // after the 10th bit the module is in read mode; clock 16 dummy bits out
  let word = 0;
  for (let i = 0; i < 16; i++) {
    writeReg(0xC0); // clock high with DI low (dummy); DO latches on rising edge
    const out = cart.readRam(0xA080);
    word = (word << 1) | (out & 1);
    writeReg(0x80); // clock low
  }
  writeReg(0x00);
  assert.equal(word, 0xBEEF, 'read back exactly the written word');
});

test('EEPROM READ without WRITE returns the erased word (0xFFFF)', () => {
  const cart = makeMbc7Cart();
  const writeReg = (v) => cart.writeRam(0xA080, v);
  const clockBit = (bit) => { writeReg(0xC0 | (bit ? 0x02 : 0x00)); writeReg(0x80 | (bit ? 0x02 : 0x00)); };
  const start = () => { writeReg(0x00); writeReg(0x80); };
  start();
  for (const b of [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]) clockBit(b); // READ addr 0
  let word = 0;
  for (let i = 0; i < 16; i++) {
    writeReg(0xC0);
    word = (word << 1) | (cart.readRam(0xA080) & 1);
    writeReg(0x80);
  }
  writeReg(0x00);
  assert.equal(word, 0xFFFF, 'fresh EEPROM reads erased');
});
