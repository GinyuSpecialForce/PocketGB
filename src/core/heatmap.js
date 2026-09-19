// PocketGB — cartridge heatmap: watch the game execute.
//
// Every frame we sample the CPU's PC and mark coverage in the physical ROM
// bank it was executing from (cart.bankFor(pc) translates the current MBC
// mapping). Coverage is stored as per-bank hit counts in 64-byte buckets —
// 256 per 16K bank, fine enough to see functions and hot loops in the
// overlay, small enough that months of play stay bounded. Buckets saturate
// at 255 so the overlay can render a stable relative heat.
//
// Sampled per frame rather than per instruction: one sample per 70k cycles
// gives a genuinely proportional picture of where time goes (that's why it's
// a *heatmap of execution*, not a coverage tracer — and it costs nothing).
'use strict';

const BUCKET = 64;                    // ROM bytes per bucket (0x4000/64 = 256/bank)

class CartridgeHeatmap {
  constructor(cart) {
    this.cart = cart;
    this.reset();
  }

  reset() {
    this.banks = new Map();           // physical bank → Uint8Array(256) hit counts
    this.frames = 0;                  // samples taken
    this.lastBank = -1;
  }

  sample(pc) {
    const bank = this.cart.bankFor(pc & 0x7FFF);
    if (bank === undefined || bank === null) return;
    let arr = this.banks.get(bank);
    if (!arr) { arr = new Uint8Array(0x4000 / BUCKET); this.banks.set(bank, arr); }
    const idx = ((pc & 0x3FFF) / BUCKET) | 0;
    if (arr[idx] < 255) arr[idx]++;
    this.frames++;
    this.lastBank = bank;
  }

  // Aggregate view for the overlay: per-bank { bank, buckets, hot, coverage }
  snapshot() {
    const out = [];
    for (const [bank, arr] of this.banks) {
      let touched = 0, hot = 0, max = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i]) touched++;
        if (arr[i] > hot) hot = arr[i];
        if (arr[i] > max) max = arr[i];
      }
      out.push({ bank, buckets: arr, touched, hot: max, coverage: touched / arr.length });
    }
    out.sort((a, b) => b.hot - a.hot || a.bank - b.bank);
    return out;
  }

  // Serialize compactly for save/export: {v, frames, banks: {bank: base64}}
  serialize() {
    const banks = {};
    for (const [bank, arr] of this.banks) {
      // Buffer is Node-only; the app runs this in the renderer (contextIsolation)
      const b64 = (typeof Buffer !== 'undefined')
        ? Buffer.from(arr).toString('base64')
        : btoa(String.fromCharCode(...arr));
      banks[bank] = b64;
    }
    return { v: 1, frames: this.frames, bucket: BUCKET, banks };
  }
}

if (typeof module !== 'undefined') module.exports = { CartridgeHeatmap, HEAT_BUCKET: BUCKET };
if (typeof window !== 'undefined') window.PocketHeat = { CartridgeHeatmap };
