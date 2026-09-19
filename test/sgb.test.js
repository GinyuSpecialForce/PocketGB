'use strict';
// Tests for the Super Game Boy layer (src/core/sgb.js): packet transport,
// palette commands, attribute maps, mask, VRAM-transfer parsing, and the
// joypad multiplayer-detection path.
const { test } = require('node:test');
const assert = require('node:assert');
const { SGB, bgr555to888 } = require('../src/core/sgb');

// Send a 16-byte packet by bit-banging P14/P15 exactly like the games do:
// both-low reset pulse, 128 data bits LSB-first, idle high between bits.
function sendPacket(sgb, bytes) {
  const w = (v) => sgb.writeP14P15(v & 0x30);
  w(0x00); // RESET (both low)
  w(0x30); // idle high
  for (let i = 0; i < 128; i++) {
    const bit = (bytes[i >> 3] >> (i & 7)) & 1;
    w(bit ? 0x10 : 0x20); // "1" = P15 low, "0" = P14 low
    w(0x30);
  }
}
function packet(cmd, len, params) {
  const p = new Uint8Array(16);
  p[0] = (cmd << 3) | len;
  p.set(params || [], 1);
  return p;
}

test('PAL01 packet fills palettes 0 and 1 through the transport', () => {
  const sgb = new SGB();
  const cols = [0x7FFF, 0x5294, 0x294A, 0x0000, 0x1111, 0x2222, 0x3333];
  const params = new Uint8Array(15);
  for (let i = 0; i < 7; i++) { params[i * 2] = cols[i] & 0xFF; params[i * 2 + 1] = cols[i] >> 8; }
  sendPacket(sgb, packet(0x00, 1, params));
  assert.deepStrictEqual([...sgb.palData.slice(0, 4)], cols.slice(0, 4));
  // pal 1 gets colors 1-3 from the packet; its color 0 is the packet's color 0
  // (spec: "the value transferred as color 0 will be applied for all four palettes")
  assert.deepStrictEqual([...sgb.palData.slice(16, 20)], [0x7FFF, 0x1111, 0x2222, 0x3333]);
});

test('PAL_SET copies system palettes into the visible ones and cancels the mask', () => {
  const sgb = new SGB();
  sgb.systemPal[7 * 4 + 2] = 0xABC; // system palette 7, color 2
  sgb.mask = 2;
  // params: 4 palette numbers (2 bytes each), then byte 8 = attr/mask control
  sendPacket(sgb, packet(0x0A, 1, new Uint8Array([7, 0, 1, 0, 2, 0, 3, 0, 0x40])));
  assert.strictEqual(sgb.mask, 0);
  assert.strictEqual(sgb.mapShade(2, 0), 0xABC, 'screen pal 0 now shows system pal 7 colors');
});

test('ATTR_DIV and ATTR_BLK write the 20x18 attribute map', () => {
  const sgb = new SGB();
  // divide: vertical line at x=10 — bits0-1 = right pal 2, bits2-3 = left pal 1,
  // bits4-5 = line pal 3 → byte1 = 3<<4 | 1<<2 | 2 = 0x36
  sendPacket(sgb, packet(0x06, 1, new Uint8Array([0x36, 10, 0])));
  assert.strictEqual(sgb.attrMap[9], 1);      // x=9 → left
  assert.strictEqual(sgb.attrMap[10], 3);     // x=10 → line
  assert.strictEqual(sgb.attrMap[11], 2);     // x=11 → right
  assert.strictEqual(sgb.attrMap[17 * 20 + 9], 1, 'division spans full height');
  // block: ctl 0x01 (inside only), pals byte 0x02 (inside pal 2), region 2,2..5,5
  sendPacket(sgb, packet(0x04, 1, new Uint8Array([1, 0x01, 0x02, 2, 2, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0])));
  assert.strictEqual(sgb.attrMap[3 * 20 + 4], 2, 'inside gets pal 2');
  assert.strictEqual(sgb.attrMap[9], 1, 'outside keeps its prior pal 1 from the divide');
});

test('MASK_EN freeze snapshots and cancel restores', () => {
  const sgb = new SGB();
  sgb.maskEn(new Uint8Array([1, 2])); // black
  assert.strictEqual(sgb.mask, 2);
  sgb.maskEn(new Uint8Array([1, 1])); // freeze
  sgb.freeze(new Uint8Array([1, 2, 3]));
  assert.deepStrictEqual([...sgb.frozen], [1, 2, 3]);
  sgb.maskEn(new Uint8Array([1, 0]));
  assert.strictEqual(sgb.frozen, null);
});

test('ATTR_TRN VRAM block decodes all 45 attribute files', () => {
  const sgb = new SGB();
  const block = new Uint8Array(4096);
  // file 3, row 0: 0xE4 = 11 10 01 00 → pals 3,2,1,0 (2 bits MSB-first per char)
  for (let i = 0; i < 5; i++) block[3 * 90 + i] = 0xE4;
  sgb.pendingTrn = 'attr';
  sgb.consumeVramBlock(block);
  assert.deepStrictEqual([...sgb.atf[3].slice(0, 4)], [3, 2, 1, 0]);
  // file 44 starts at 44*90 = 3960 (fits in 4050)
  block[44 * 90] = 0x80; // pal 2, then 0
  sgb.pendingTrn = 'attr';
  sgb.consumeVramBlock(block);
  assert.deepStrictEqual([...sgb.atf[44].slice(0, 2)], [2, 0]);
});

test('PAL_TRN and PCT_TRN VRAM blocks fill system palettes and border data', () => {
  const sgb = new SGB();
  const block = new Uint8Array(4096);
  block[0] = 0x34; block[1] = 0x12; // system palette 0 color 0 = 0x1234
  sgb.pendingTrn = 'pal';
  sgb.consumeVramBlock(block);
  assert.strictEqual(sgb.systemPal[0], 0x1234);

  const b2 = new Uint8Array(4096);
  b2[0] = 0x01; b2[1] = 0x80;              // map entry 0: tile 1, palette 4
  b2[0x800] = 0xCD; b2[0x801] = 0x01;      // border pal 4 color 0 = 0x01CD
  sgb.pendingTrn = 'pct';
  sgb.consumeVramBlock(b2);
  assert.strictEqual(sgb.borderMap[0], 0x8001);
  assert.strictEqual(sgb.borderPal[0], 0x01CD);
  assert.strictEqual(sgb.borderDirty, true);
});

test('CHR_TRN latches tile halves and marks the border dirty', () => {
  const sgb = new SGB();
  const block = new Uint8Array(4096);
  block[5] = 0xAB;
  sgb.pendingTrn = 'chr-bg';
  sgb.consumeVramBlock(block);
  assert.strictEqual(sgb.borderTiles[5], 0xAB);
  assert.strictEqual(sgb.borderDirty, true);
  sgb.borderDirty = false;
  block[5] = 0xCD;
  sgb.pendingTrn = 'chr-obj'; // second half (tiles 128-255; same bank per docs)
  sgb.consumeVramBlock(block);
  assert.strictEqual(sgb.borderTiles[128 * 32 + 5], 0xCD);
});

test('bgr555to888 expands channels with bit replication', () => {
  assert.strictEqual(bgr555to888(0x7FFF) >>> 0, (0xFF000000 | (0xFF << 16) | (0xFF << 8) | 0xFF) >>> 0);
  assert.strictEqual(bgr555to888(0) >>> 0, 0xFF000000 >>> 0);
  // 5-bit 0b00001 → 8-bit 0b00001000 (replication copies the top 3 bits: 000)
  assert.strictEqual(bgr555to888(0x0001) & 0xFF, 0b00001000);
});

test('joypad: MLT_REQ enables multiplayer IDs for SGB detection', () => {
  const layer = new SGB();
  // fake joypad integration
  const joy = {
    selectBits: 0x30, directionBits: 0x0F, actionBits: 0x0F,
    read() {
      if (layer.mltPlayers > 1 && (this.selectBits & 0x30) === 0x30) return 0xC0 | 0x30 | (0x0F - layer.joyId);
      let low = 0x0F;
      if (!(this.selectBits & 0x10)) low &= 0x0F;
      if (!(this.selectBits & 0x20)) low &= 0x0F;
      return 0xC0 | (this.selectBits & 0x30) | low;
    },
    write(v) { this.selectBits = v & 0x30; layer.writeP14P15(v & 0x30); },
    writeP14P15(v) { layer.writeP14P15(v & 0x30); }, // transport passthrough
  };
  const sgb = layer;
  // two-player request
  sendPacket(joy, packet(0x11, 1, new Uint8Array([1])));
  assert.strictEqual(sgb.mltPlayers, 2);
  // The MLT_REQ packet itself pulses the lines, so start from a clean ID 0.
  sgb.joyId = 0;
  joy.write(0x30);
  assert.strictEqual(joy.read() & 0x0F, 0x0F);
  joy.write(0x00); joy.write(0x30); // explicit deselect edge → increment
  assert.strictEqual(joy.read() & 0x0F, 0x0E, 'ID increments on the next deselect edge');
  // back to one player
  sendPacket(joy, packet(0x11, 1, new Uint8Array([0])));
  assert.strictEqual(sgb.mltPlayers, 1);
  joy.write(0x30);
  assert.strictEqual(joy.read() & 0x0F, 0x0F);
});

test('loadROM keeps the SGB layer linked to the joypad across resets', () => {
  // Regression: resetComponents() builds a fresh Joypad AFTER loadROM attached
  // the SGB layer, silently unlinking packets — every SGB game through the real
  // app path lost SGB features on load.
  const { GameBoy } = require('../src/core/gameboy');
  const rom = new Uint8Array(0x8000);
  rom[0x100] = 0x00; rom[0x101] = 0xC3; rom[0x102] = 0x50; rom[0x103] = 0x01;
  rom[0x146] = 0x03; rom[0x14B] = 0x33; // SGB unlock
  rom[0x150] = 0x18; rom[0x151] = 0xFE; // idle loop
  const gb = new GameBoy();
  gb.loadROM(rom);
  assert.ok(gb.sgb, 'SGB layer created for an unlocked DMG header');
  assert.strictEqual(gb.joypad.sgb, gb.sgb, 'joypad linked after load');
  assert.strictEqual(gb.mmu.joypad, gb.joypad, 'mmu points at the live joypad');
  gb.loadROM(rom); // the reset path is a full re-load
  assert.strictEqual(gb.joypad.sgb, gb.sgb, 'still linked after a re-load/reset');
});

test('multi-packet ATTR_BLK buffers the whole group and executes once', () => {
  // Hardware accumulates all declared packets, then runs the command with the
  // full parameter block. Executing early would read past packet 1 and
  // re-parse continuation bytes as a header.
  const sgb = new SGB();
  // 3 rectangle sets = 2 + 18 bytes → a 2-packet group (cmd 0x04, len 2).
  // Set layout: ctl, pals, x1, y1, x2, y2. Sets start at packet-1 byte 2, so
  // set 3 SPLITS across the packet boundary — exercising the buffered merge.
  // Sets use inside-only flags and disjoint regions so no set paints another's
  // probe point (the outside flag would legitimately overwrite earlier sets).
  // set 1: inside only, pal 1, rows 1-3, cols 1-6
  // set 2: line only,  pal 2, rect cols 8-12, rows 4-6 (perimeter painted)
  // set 3: inside only, pal 3, rows 9-16, cols 9-12
  const first = packet(0x04, 2, [3, 0x01, 0x11, 1, 1, 3, 6, 0x02, 0x08, 8, 4, 12, 6, 0x01, 0x33]);
  const second = new Uint8Array(16);
  second.set([9, 9, 12, 16], 0); // set 3 tail: x1, y1, x2, y2
  sendPacket(sgb, first);
  sendPacket(sgb, second); // continuation: bit-banged like any packet
  // verify each set landed with correct semantics
  assert.strictEqual(sgb.attrMap[2 * 20 + 3], 1, 'inside set 1');       // (x3,y2)
  assert.strictEqual(sgb.attrMap[4 * 20 + 10], 2, 'line set 2 paints the top edge'); // (x10,y4)
  assert.strictEqual(sgb.attrMap[5 * 20 + 10], 0, 'line set 2 leaves the interior');
  assert.strictEqual(sgb.attrMap[12 * 20 + 10], 3, 'inside set 3');     // (x10,y12)
  assert.strictEqual(sgb.attrMap[0 * 20 + 0], 0, 'outside untouched (default 0)');
  // and a following single-packet command still works after the group:
  // ATTR_DIV horizontal at y=9 — bits0-1 below=0, bits2-3 above=2, bits4-5
  // line=3, bit6 horizontal → 0x78
  sendPacket(sgb, packet(0x06, 1, [0x78, 9]));
  assert.strictEqual(sgb.attrMap[0 * 20 + 0], 2, 'ATTR_DIV above line = above palette');
  assert.strictEqual(sgb.attrMap[9 * 20 + 10], 3, 'ATTR_DIV line row = line palette');
  assert.strictEqual(sgb.attrMap[17 * 20 + 0], 0, 'ATTR_DIV below line = below palette');
});

test('RESET pulse mid-command aborts a partially received group', () => {
  const sgb = new SGB();
  sendPacket(sgb, packet(0x04, 2, [1, 0])); // declares 2 packets; only one arrives
  // next RESET pulse + a fresh single-packet command must not be swallowed
  sendPacket(sgb, packet(0x0A, 1, [0, 0, 0, 0, 0, 0, 0, 0]));
  // PAL_SET with all-zero palette ids copies system palette 0 (grays or zeroes)
  assert.ok(sgb.palData instanceof Uint16Array);
  assert.strictEqual(sgb.cmdActive, false, 'no command left pending');
});
