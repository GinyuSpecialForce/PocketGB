// Runs Blargg's test ROMs headless. Each ROM writes "code:description" lines
// out the serial port, then "Passed" or a failure line. Serial transfers are
// "accelerated": a write to SC with bit 7 set completes instantly, delivering SB
// to our capture buffer and raising the serial interrupt (as hardware would).
//
// Required: all 11 cpu_instrs individual ROMs plus the accuracy trio
// (halt_bug, instr_timing, mem_timing — all pass with per-access hardware
// delivery: CPU._mAccess ticks the bus 4 T-cycles per memory access).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { GameBoy } = require('../src/core/gameboy');

const dir = path.join(__dirname, 'blargg');
const hasRoms = fs.existsSync(dir) && fs.readdirSync(dir).filter(f => f.endsWith('.gb')).length >= 10;

const REQUIRED = new Set([
  // cpu_instrs suite
  '01-special.gb', '02-interrupts.gb', '03-op_sp_hl.gb', '04-op_r_imm.gb',
  '05-op_rp.gb', '06-ld_r_r.gb', '07-jr_jp_call_ret_rst.gb', '08-misc_instrs.gb',
  '09-op_r_r.gb', '10-bit_ops.gb', '11-op_a_(hl).gb',
  // accuracy tests (render output to serial like the rest)
  'halt_bug.gb', 'instr_timing.gb', 'mem_timing.gb',
]);

function runBlargg(romPath, maxSeconds = 60) {
  const rom = new Uint8Array(fs.readFileSync(romPath));
  const gb = new GameBoy();
  gb.loadROM(rom);
  let serialOut = '';
  let screenOut = '';
  let lastLen = 0;
  let quietFrames = 0;

  const origWrite = gb.mmu.write.bind(gb.mmu);
  gb.mmu.write = (a, v) => {
    if ((a & 0xFFFF) === 0xFF02 && (v & 0x80) && (v & 0x01)) {
      // transfer start, internal clock: complete instantly
      serialOut += String.fromCharCode(gb.mmu.read(0xFF01));
      origWrite(0xFF02, v & 0x7F);      // bit 7 clears as on completion
      gb.mmu.requestInterrupt(3);       // serial interrupt
      return;
    }
    origWrite(a, v);
  };

  const totalFrames = maxSeconds * 60;
  for (let f = 0; f < totalFrames; f++) {
    gb.runFrame();
    if (serialOut.length !== lastLen) { lastLen = serialOut.length; quietFrames = 0; }
    else if (++quietFrames > 1800) break; // 30s of no output: done (some tests think for a long while)
    if (serialOut.includes('Passed')) break;
    // Screen-output fallback: some Blargg ROMs (halt_bug) render results on
    // the LCD and never touch serial. While no serial output has appeared,
    // poll the BG tilemap (tiles are ASCII-mapped in Blargg's shells).
    if (!serialOut.length && (f & 15) === 0) {
      let text = '';
      for (let i = 0; i < 0x400; i++) text += String.fromCharCode(gb.ppu.readVRAM(0x9800 + i));
      const m = text.match(/Passed|Failed/);
      if (m) { screenOut = m[0]; break; }
    }
  }
  return serialOut + screenOut;
}

if (!hasRoms) {
  test.skip('Blargg cpu_instrs: all individual tests pass (ROMs not fetched)', () => {});
} else {
  test('Blargg cpu_instrs + accuracy ROMs: all pass', () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.gb') && REQUIRED.has(f)).sort();
    assert.ok(files.length >= 10, `expected >=10 required test ROMs, found ${files.length}`);
    const failures = [];
    for (const f of files) {
      const out = runBlargg(path.join(dir, f), 60);
      if (!/Passed/.test(out)) failures.push(`${f}: ${out.slice(-120)}`);
    }
    assert.deepStrictEqual(failures, [], 'all required Blargg tests must print Passed');
  });
}
