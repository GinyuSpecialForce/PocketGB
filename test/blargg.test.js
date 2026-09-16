// Runs Blargg's cpu_instrs ROMs headless. Each ROM writes "code:description" lines
// out the serial port, then "Passed" or a failure line. Serial transfers are
// "accelerated": a write to SC with bit 7 set completes instantly, delivering SB
// to our capture buffer and raising the serial interrupt (as hardware would).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { GameBoy } = require('../src/core/gameboy');

const dir = path.join(__dirname, 'blargg');
const hasRoms = fs.existsSync(dir) && fs.readdirSync(dir).filter(f => f.endsWith('.gb')).length >= 10;

function runBlargg(romPath, maxSeconds = 60) {
  const rom = new Uint8Array(fs.readFileSync(romPath));
  const gb = new GameBoy();
  gb.loadROM(rom);
  let serialOut = '';
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
  }
  return serialOut;
}

// Only register tests when ROMs are present (npm run fetch-tests downloads them)
(hasRoms ? test : test.skip)('Blargg cpu_instrs: all individual tests pass', () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.gb')).sort();
  assert.ok(files.length >= 10, `expected >=10 test ROMs, found ${files.length}`);
  const failures = [];
  for (const f of files) {
    const out = runBlargg(path.join(dir, f), 60);
    if (!/Passed/.test(out)) failures.push(`${f}: ${out.slice(-120)}`);
  }
  assert.deepStrictEqual(failures, [], 'all Blargg cpu_instrs tests must print Passed');
});
