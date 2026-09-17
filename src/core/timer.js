// PocketGB — timer (DIV/TIMA/TMA/TAC)
'use strict';

class Timer {
  constructor(interrupt) {
    this.interrupt = interrupt; // object with requestInterrupt(bit)
    this.reset();
  }
  reset() {
    this.div = 0xABCC;      // internal 16-bit counter; upper 8 exposed at FF04
    this.tima = 0x00;
    this.tma = 0x00;
    this.tac = 0x00;        // bit2 enable, bits0-1 speed
  }

  static RATE = [1024, 16, 64, 256]; // T-cycles per TIMA tick for 4096/262144/65536/16384 Hz (reference)

  tick(tCycles) {
    // O(1): bit b of DIV falls exactly at counter values that are multiples of
    // 2^(b+1), so count those crossings in (div, div+n] instead of looping.
    // Wrap-safe: 65536 is a multiple of every period. Input is T-cycles
    // (4.19 MHz master clock) — the BITSELECT table encodes real frequencies.
    let div = this.div + tCycles;
    if (this.tac & 0x04) {
      const bit = Timer.BITSELECT[this.tac & 3];
      const P = 1 << (bit + 1);
      let edges = Math.floor(div / P) - Math.floor(this.div / P);
      this.div = div & 0xFFFF;
      while (edges-- > 0) {
        if (++this.tima > 0xFF) {
          this.tima = this.tma;
          this.interrupt.requestInterrupt(2); // Timer
        }
      }
      return;
    }
    this.div = div & 0xFFFF;
  }
}

Timer.BITSELECT = [9, 3, 5, 7];

if (typeof module !== 'undefined') module.exports = { Timer };
