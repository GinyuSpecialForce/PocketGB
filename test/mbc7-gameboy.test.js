'use strict';
// Integration tests for MBC7 wiring through GameBoy.loadROM (src/core/gameboy.js).
//
// Regression 1: loadROM used to REPLACE the cartridge's Mbc7 instance with
// `new Mbc7()` — no cart argument. The EEPROM command path does
// `this.cart.ram`, so every EEPROM command (Kirby Tilt'n'Tumble's save/load)
// threw a TypeError and froze the machine while the accelerometer kept
// working. The instance must stay bound to the cart.
//
// Regression 2: index.html loads cartridge.js BEFORE mbc7.js, and with
// nodeIntegration off cartridge.js cannot require() it late — so the slot is
// empty in the browser. loadROM must late-bind MBC7 for 0x20 carts.
//
// The EEPROM protocol is exercised end-to-end through the MMU bus exactly as
// a game would (enable dance, EWEN, WRITE, READ).
const { test } = require('node:test');
const assert = require('node:assert');

const mbc7Path = require.resolve('../src/core/mbc7.js');
const cartPath = require.resolve('../src/core/cartridge.js');
const gbPath = require.resolve('../src/core/gameboy.js');

// The real Mbc7 class, loaded before any cache juggling.
const { Mbc7 } = require(mbc7Path);
const realMbc7Entry = require.cache[mbc7Path];

// Build a fresh GameBoy module where cartridge.js sees (or does not see) the
// Mbc7 module at ITS evaluation time — mirroring index.html script order.
// gameboy.js's lazy require('./mbc7') runs at loadROM time, after the cache
// is restored, exactly like the browser where the global exists by then.
function loadGameBoy({ hideMbc7FromCartridge }) {
  const saved = require.cache[mbc7Path];
  if (hideMbc7FromCartridge) {
    require.cache[mbc7Path] = { id: mbc7Path, filename: mbc7Path, loaded: true, exports: { Mbc7: null } };
  }
  delete require.cache[cartPath];
  delete require.cache[gbPath];
  const gbMod = require(gbPath);
  require.cache[mbc7Path] = saved;
  delete require.cache[cartPath];
  delete require.cache[gbPath];
  return gbMod;
}

function makeMbc7Rom() {
  const rom = new Uint8Array(0x8000);
  rom[0x100] = 0x00; rom[0x101] = 0xC3; rom[0x102] = 0x50; rom[0x103] = 0x01;
  rom[0x147] = 0x20; // MBC7
  rom[0x148] = 0;    // 32 KB ROM
  rom[0x149] = 0x03; // 32 KB cart RAM (the emu keeps EEPROM words in it)
  rom[0x150] = 0x18; rom[0x151] = 0xFE; // idle loop
  return rom;
}

// EWEN + WRITE word + READ word over the MMU bus, bit-banged like a game.
function eepromRoundTrip(gb, addr, value) {
  const w = (a, v) => gb.mmu.write(a, v);
  const r = (a) => gb.mmu.read(a);
  w(0x0000, 0x0A); w(0x4000, 0x40); // MBC7 double enable dance
  const clockBit = (bit) => { w(0xA080, 0xC0 | (bit ? 2 : 0)); w(0xA080, 0x80 | (bit ? 2 : 0)); };
  const sendBits = (arr) => { for (const b of arr) clockBit(b); };
  const start = () => { w(0xA080, 0x00); w(0xA080, 0x80); }; // CS low, CS high
  // EWEN (op 00, addr bits 11)
  start(); sendBits([1, 0, 0, 1, 1, 0, 0, 0, 0, 0]); w(0xA080, 0x00);
  // WRITE addr (op 01), then 16 data bits MSB-first
  start();
  sendBits([1, 0, 1, (addr >> 6) & 1, (addr >> 5) & 1, (addr >> 4) & 1, (addr >> 3) & 1, (addr >> 2) & 1, (addr >> 1) & 1, addr & 1]);
  const data = [];
  for (let i = 15; i >= 0; i--) data.push((value >> i) & 1);
  sendBits(data);
  w(0xA080, 0x00);
  // programming takes time: clock until RDY (DO=1) — bound the poll
  for (let i = 0; i < 64; i++) { w(0xA080, 0xC0); w(0xA080, 0x80); }
  // READ addr (op 10), then 16 clocks shift the word out MSB-first
  start();
  sendBits([1, 1, 0, (addr >> 6) & 1, (addr >> 5) & 1, (addr >> 4) & 1, (addr >> 3) & 1, (addr >> 2) & 1, (addr >> 1) & 1, addr & 1]);
  let word = 0;
  for (let i = 0; i < 16; i++) {
    w(0xA080, 0xC0);
    word = (word << 1) | (r(0xA080) & 1);
    w(0xA080, 0x80);
  }
  w(0xA080, 0x00);
  return word;
}

test('loadROM keeps the cartridge-built MBC7 bound to the cart', () => {
  const { GameBoy } = loadGameBoy({ hideMbc7FromCartridge: false });
  const gb = new GameBoy();
  gb.loadROM(makeMbc7Rom());
  assert.ok(gb.cart.mbc7, 'MBC7 attached for cart type 0x20');
  // NOTE: compare booleans, never the cart object itself — an assertion that
  // fails with the cart in actual/expected wedges node:test's result
  // serialization (functions + cycles don't clone) and hangs the whole file.
  assert.strictEqual(gb.cart.mbc7 instanceof Mbc7, true, 'the real Mbc7 class is in use');
  assert.strictEqual(gb.cart.mbc7.cart === gb.cart, true,
    'MBC7 instance must hold the cart (the EEPROM path uses this.cart.ram)');
});

test('loadROM late-binds MBC7 when cartridge.js could not load it (script order)', () => {
  const { GameBoy } = loadGameBoy({ hideMbc7FromCartridge: true });
  const gb = new GameBoy();
  gb.loadROM(makeMbc7Rom());
  assert.ok(gb.cart.mbc7, 'MBC7 attached even though the cartridge slot started empty');
  assert.strictEqual(gb.cart.mbc7.cart === gb.cart, true, 'late-bound instance is bound to the cart');
});

test('EEPROM EWEN→WRITE→READ round-trips through the MMU bus', () => {
  const { GameBoy } = loadGameBoy({ hideMbc7FromCartridge: false });
  const gb = new GameBoy();
  gb.loadROM(makeMbc7Rom());
  assert.strictEqual(eepromRoundTrip(gb, 3, 0x1234), 0x1234,
    'word written at address 3 reads back exactly (would throw with a cart-less Mbc7)');
  assert.strictEqual(gb.cart.mbc7.cart.dirty, true, 'write marks the cart dirty');
});
