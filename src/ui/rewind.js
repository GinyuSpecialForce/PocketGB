// PocketGB — rewind: rolling ring of save states
// Snapshots every `interval` ms while playing; holding rewind steps back
// through the ring. Memory-bounded (capacity × ~30 KB).
'use strict';

class RewindManager {
  constructor(gb, opts = {}) {
    this.gb = gb;
    this.capacity = opts.capacity || 600; // states kept
    this.interval = opts.interval || 200; // ms between snapshots
    this.entries = [];
    this._last = 0;
    this._failed = 0;
  }

  update(now) {
    if (now - this._last < this.interval) return;
    this._last = now;
    try {
      this.entries.push(this.gb.saveState());
      if (this.entries.length > this.capacity) this.entries.shift();
      this._failed = 0;
    } catch (err) {
      if (++this._failed < 3) console.error('rewind snapshot failed:', err);
    }
  }

  // Step back one snapshot (call repeatedly while the key is held). Returns true if rewound.
  step() {
    if (this.entries.length === 0) return false;
    try {
      this.gb.loadState(this.entries.pop());
      return true;
    } catch (err) {
      console.error('rewind load failed:', err);
      this.entries.length = 0; // corrupt ring: drop it
      return false;
    }
  }

  reset() {
    this.entries.length = 0;
    this._last = 0;
  }
}

if (typeof module !== 'undefined') module.exports = { RewindManager };
