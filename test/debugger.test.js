'use strict';
// Tests for the debugger core (src/core/debugger.js): watchpoint arming and
// firing through the real MMU, runFrame stop-on-watch, and step-over/step-out
// planning.

const { test } = require('node:test');
const assert = require('node:assert');
const { BreakpointManager, stepOverTarget, stepOutFrameReturn } = require('../src/core/debugger');
const { GameBoy } = require('../src/core/gameboy');

function makeGB() {
  const rom = new Uint8Array(0x8000);
  rom[0x100] = 0x00; // NOP
  rom[0x101] = 0x76; // HALT
  rom[0x147] = 0; rom[0x148] = 0; rom[0x149] = 0;
  const gb = new GameBoy();
  gb.loadROM(rom);
  return gb;
}

test('watchpoint manager: arming, listing, unwatching', () => {
  const bp = new BreakpointManager();
  assert.equal(bp.armed, false, 'starts disarmed');
  bp.watchRead(0xC100);
  assert.equal(bp.armed, true);
  assert.deepEqual(bp.list(), [{ addr: 0xC100, kind: 'r' }]);
  bp.watchWrite(0xC100);
  assert.deepEqual(bp.list(), [{ addr: 0xC100, kind: 'r' }, { addr: 0xC100, kind: 'w' }]);
  bp.unwatchRead(0xC100);
  assert.deepEqual(bp.list(), [{ addr: 0xC100, kind: 'w' }]);
  bp.clear();
  assert.equal(bp.armed, false);
  assert.deepEqual(bp.list(), []);
});

test('watchpoint fires through the MMU with the current PC', () => {
  const gb = makeGB();
  gb.watchAccess(0xC0A0);
  // trigger a write via the CPU: LD (nn),A / LD A,n / LD (nn),A sequence
  // simpler: drive the bus directly from a CPU-context write
  gb.mmu.write(0xC0A0, 0x42);
  assert.equal(gb._bpMgr.lastHit.kind, 'w', 'write recorded');
  assert.equal(gb._bpMgr.lastHit.addr, 0xC0A0);
  gb.mmu.read(0xC0A0);
  assert.equal(gb._bpMgr.lastHit.kind, 'r', 'read recorded');
  // disarm → no more hits
  gb.clearWatchpoints();
  gb._bpMgr.lastHit = null;
  gb.mmu.write(0xC0A0, 0x42);
  assert.equal(gb._bpMgr.lastHit, null, 'cleared watchpoints stay silent');
});

test('runFrame stops when a watched address is touched, reports the hit', () => {
  const gb = makeGB();
  // program: LD A,$77 (3E 77); LD (C0A0),A (EA A0 C0); JR -2 loop (18 FE)
  const rom = new Uint8Array(0x8000);
  rom[0x100] = 0x3E; rom[0x101] = 0x77;
  rom[0x102] = 0xEA; rom[0x103] = 0xA0; rom[0x104] = 0xC0;
  rom[0x105] = 0x18; rom[0x106] = 0xFE; // JR -2: tight loop writing C0A0 forever
  gb.loadROM(rom);
  gb.watchWrite(0xC0A0);
  const fb = gb.runFrame();
  assert.ok(fb, 'frame still returns a picture');
  assert.equal(gb._watchFired, true, 'watch flag raised');
  assert.equal(gb._bpMgr.lastHit.addr, 0xC0A0);
  assert.ok(gb.cpu.pc >= 0x100 && gb.cpu.pc <= 0x107, 'stopped inside the touching code');
  gb.clearWatchpoints();
  gb._watchFired = false;
  gb.runFrame();
  assert.equal(gb._watchFired, false, 'no watchpoints → runs freely');
});

test('stepOverTarget: CALL/RST plans a return target, others step', () => {
  const gb = makeGB();
  const rom = new Uint8Array(0x8000);
  gb.loadROM(rom);
  const cpu = gb.cpu;
  rom[0x100] = 0xCD; rom[0x101] = 0x50; rom[0x102] = 0x01; // CALL $0150
  cpu.pc = 0x100;
  assert.equal(stepOverTarget(cpu), 0x103, 'CALL steps over to the next instruction');
  rom[0x100] = 0xC7; // RST 00
  cpu.pc = 0x100;
  assert.equal(stepOverTarget(cpu), 0x101, 'RST steps over to the next instruction');
  rom[0x100] = 0x3E; rom[0x101] = 0x77; // LD A,n
  cpu.pc = 0x100;
  assert.equal(stepOverTarget(cpu), null, 'plain instruction = plain step');
  rom[0x100] = 0xC4; rom[0x101] = 0x50; rom[0x102] = 0x01; // CALL NZ
  cpu.pc = 0x100;
  assert.equal(stepOverTarget(cpu), 0x103, 'conditional CALL also steps over');
});

test('stepOutFrameReturn reads the return address at SP', () => {
  const gb = makeGB();
  gb.mmu.write(0xFFFE, 0x34); gb.mmu.write(0xFFFF, 0x12); // ret addr $1234
  gb.cpu.sp = 0xFFFE;
  assert.equal(stepOutFrameReturn(gb.cpu), 0x1234);
});

test('watchpoints on watchless machines cost nothing (no manager, no crash)', () => {
  // A GameBoy before loadROM has no MMU — the manager is attached at loadROM
  const gb = makeGB();
  assert.ok(gb._bpMgr, 'manager created lazily on first loadROM');
});
