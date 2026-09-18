'use strict';
// Tests for the shared ROM title extractor (src/core/romtitle.js).
// Pins the junk-handling rules that keep library cards, the recent menu,
// window title, and cartridge camera detection showing readable names.

const { test } = require('node:test');
const assert = require('node:assert');
const { extractRomTitle, titleLooksBroken, basenameOf } = require('../src/core/romtitle');

function romWithTitle(text, { pad = 0x00, len = 0x150 } = {}) {
  const rom = new Uint8Array(len).fill(0x00);
  const out = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c > 0xFF) throw new Error('test titles must be latin1');
    out.push(c);
  }
  while (out.length < 15) out.push(pad); // title field is 0x134-0x142 (15 bytes)
  rom.set(out.slice(0, 15), 0x134);
  return rom;
}

test('plain NUL-padded title extracts cleanly', () => {
  assert.strictEqual(extractRomTitle(romWithTitle('TETRIS')), 'TETRIS');
});

test('0xFF padding becomes spaces and is trimmed', () => {
  assert.strictEqual(extractRomTitle(romWithTitle('ZELDA', { pad: 0xFF })), 'ZELDA');
});

test('embedded 0xFF runs read as single gaps, not garbage', () => {
  // many shipped dumps look like "SUPER\xFF\xFFMARIO" — the run must
  // collapse to one space, not produce ÿ characters or double gaps
  const rom = new Uint8Array(0x150);
  const bytes = [...'SUPER'].map((c) => c.charCodeAt(0)).concat([0xFF, 0xFF], [...'MARIO'].map((c) => c.charCodeAt(0)));
  bytes.push(0x00);
  rom.set(bytes, 0x134);
  assert.strictEqual(extractRomTitle(rom), 'SUPER MARIO');
});

test('first NUL terminates the title (trailing junk ignored)', () => {
  const rom = romWithTitle('GAME');
  rom[0x139] = 0x41; // 'A' after the NUL must not appear
  assert.strictEqual(extractRomTitle(rom), 'GAME');
});

test('all-0xFF header yields empty title (caller falls back to filename)', () => {
  const rom = new Uint8Array(0x150).fill(0xFF);
  assert.strictEqual(extractRomTitle(rom), '');
});

test('control bytes become gaps; result is trimmed', () => {
  const rom = romWithTitle('AB CD');
  rom[0x134 + 2] = 0x01; // control byte between B and space
  assert.strictEqual(extractRomTitle(rom), 'AB CD');
});

test('0x143 (CGB flag) is never consumed as title text', () => {
  const rom = romWithTitle('ColorGame');
  rom[0x143] = 0xC0; // CGB-only flag
  assert.strictEqual(extractRomTitle(rom), 'ColorGame');
});

test('Latin-1 accented letters pass through', () => {
  const rom = romWithTitle('Pok\u00E9mon');
  assert.strictEqual(extractRomTitle(rom), 'Pok\u00E9mon');
});

test('short/absent buffers return empty', () => {
  assert.strictEqual(extractRomTitle(new Uint8Array(0x100)), '');
  assert.strictEqual(extractRomTitle(null), '');
  assert.strictEqual(extractRomTitle(new Uint8Array(0)), '');
});

test('titleLooksBroken flags junk or empty stored titles', () => {
  assert.strictEqual(titleLooksBroken('TETRIS'), false);
  assert.strictEqual(titleLooksBroken(''), true);
  assert.strictEqual(titleLooksBroken(null), true);
  assert.strictEqual(titleLooksBroken('bad\u0007bell'), true);
  assert.strictEqual(titleLooksBroken('bad\uFFFDchar'), true);
});

test('basenameOf handles both path separators', () => {
  assert.strictEqual(basenameOf('/Users/jon/Roms/Tetris.gb'), 'Tetris.gb');
  assert.strictEqual(basenameOf('C:\\Users\\jon\\Roms\\Tetris.gb'), 'Tetris.gb');
  assert.strictEqual(basenameOf('game.gb'), 'game.gb');
});
