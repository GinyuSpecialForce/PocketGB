// PocketGB — timer (DIV/TIMA/TMA/TAC)
//
// Models the hardware quirks Blargg's instr_timing depends on:
//  • TIMA ticks on the FALLING edge of the selected DIV bit (when enabled).
//  • On overflow TIMA reads 0 for 4 T-cycles, then loads TMA and sets the
//    timer interrupt at the same moment (the delayed-IF behavior).
//  • Writing TIMA during that window cancels the pending reload AND its IF.
//  • Writing DIV (any value) resets the counter; if the selected bit falls
//    as a result, TIMA increments (the notorious DIV-write edge).
//  • Disabling the timer via TAC with the selected bit high ticks TIMA once.
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
    this.reloadIn = -1;     // T-cycles until pending overflow reload (−1 = none)
  }

  static RATE = [1024, 16, 64, 256];   // T-cycles per TIMA tick (reference)
  static BITSELECT = [9, 3, 5, 7];     // DIV bit watched for each TAC speed

  tick(tCycles) {
    let n = tCycles;
    // pending overflow window: DIV keeps counting; reload + IF at deadline
    if (this.reloadIn >= 0) {
      const step = Math.min(n, this.reloadIn);
      this.div = (this.div + step) & 0xFFFF;
      this.reloadIn -= step;
      n -= step;
      if (this.reloadIn === 0) {
        this.tima = this.tma;
        this.interrupt.requestInterrupt(2);
        this.reloadIn = -1;
      }
      if (n === 0) return;
    }
    if (!(this.tac & 0x04)) { this.div = (this.div + n) & 0xFFFF; return; }
    // Falling edges of the selected DIV bit occur exactly at counter values
    // that are multiples of the period — count those in (div, div+n].
    const bit = Timer.BITSELECT[this.tac & 3];
    const P = 1 << (bit + 1);
    const div = this.div;
    const div2 = div + n;
    // Fast path: no period boundary inside this (small) window — the common
    // case at per-access granularity. Same edge math, one less division pair.
    if (((div2 / P) | 0) === ((div / P) | 0)) { this.div = div2 & 0xFFFF; return; }
    let edges = Math.floor(div2 / P) - Math.floor(div / P);
    this.div = div2 & 0xFFFF;
    while (edges-- > 0) this.incrementTIMA();
  }

  readTIMA() { return this.tima; }
  writeTIMA(v) {
    this.tima = v & 0xFF;
    this.reloadIn = -1; // writing TIMA during the pending window cancels reload + IF
  }
  writeDIV() {
    const bit = Timer.BITSELECT[this.tac & 3];
    const wasHigh = (this.tac & 0x04) && ((this.div >> bit) & 1);
    this.div = 0;
    if (wasHigh) this.incrementTIMA(); // falling edge caused by the reset
  }
  writeTAC(v) {
    const old = this.tac;
    this.tac = v & 0xFF;
    const bit = Timer.BITSELECT[old & 3];
    // disable 1→0 while the previously-watched bit is high: falling edge ticks TIMA
    if ((old & 0x04) && !(this.tac & 0x04) && ((this.div >> bit) & 1)) {
      this.incrementTIMA();
    }
  }
  incrementTIMA() {
    // An arriving edge always lands after the 4-T reload window (fastest
    // timer period is 16 T), so complete any pending reload first.
    if (this.reloadIn >= 0) {
      this.tima = this.tma;
      this.interrupt.requestInterrupt(2);
      this.reloadIn = -1;
    }
    if (++this.tima > 0xFF) {
      this.tima = 0;
      this.reloadIn = 4;
    }
  }
}

if (typeof module !== 'undefined') module.exports = { Timer };
