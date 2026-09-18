// PocketGB — serial port (SB/SC) with link-cable transport hooks
//
// DMG serial: writing SC with bit7 set starts an 8-bit shift transfer. With the
// internal clock (SC bit0 = 1) the transfer takes 8 × 128 m-cycles (8192 Hz),
// then SC bit7 clears and the serial interrupt fires. With an external clock
// (bit0 = 0, the slave on a link cable) the transfer completes when the peer's
// clock arrives — here, when the transport delivers a byte.
//
// Transport model (byte exchange, sufficient for Pokémon trades / Tetris 2P):
// the master sends its byte when the 8 clocks elapse and waits up to one frame
// for the peer's reply (the second half of the hardware exchange, which over a
// real cable happens during the same 8 clocks); timeout completes with 0xFF,
// exactly like an unplugged cable. A slave completes on delivery: incoming
// byte lands in SB, our byte goes out.
'use strict';

const TCYCLES_PER_TRANSFER = 8 * 512; // 4096 T-cycles: 8 bits at 8192 Hz
const REPLY_TIMEOUT = 280896;         // one frame (70224 m-cycles) in T-cycles: treat silence as no cable

const ST_IDLE = 0, ST_MASTER_RUN = 1, ST_MASTER_WAIT = 2;

class Serial {
  constructor() {
    this.sb = 0x00;            // FF01
    this.sc = 0x7E;            // FF02 (bits 6..1 read as 1 on DMG)
    this._state = ST_IDLE;
    this._counter = 0;                // T-cycles to the next state transition
    this._armed = false;       // slave transfer waiting for the peer's clock
    this._pendingPeer = null;  // peer byte received during the master transfer
    // transport hooks (set by the UI layer)
    this.onSend = null;        // (byte) => void — our SB goes to the peer
    this.onComplete = null;    // () => void — a transfer finished (UI status)
    this.connected = false;
  }

  reset() {
    this.sb = 0x00;
    this.sc = 0x7E;
    this._state = ST_IDLE;
    this._counter = 0;
    this._armed = false;
    this._pendingPeer = null;
  }

  readSB() { return this.sb; }
  readSC() { return this.sc | 0x7E; }

  writeSB(v) { this.sb = v; }

  writeSC(v) {
    this.sc = (v & 0x81) | 0x7E; // keep Start + ClockSpeed; DMG reads 1 elsewhere
    if (this.sc & 0x80) {
      if (this.sc & 0x01) {
        // internal clock: shift 8 bits over 4096 T-cycles
        this._state = ST_MASTER_RUN;
        this._counter = TCYCLES_PER_TRANSFER;
        this._armed = false;
      } else {
        // external clock: wait for the peer's clock (transport delivery)
        this._armed = true;
        this._state = ST_IDLE;
        this._counter = 0;
      }
    } else {
      // transfer aborted
      this._state = ST_IDLE;
      this._counter = 0;
      this._armed = false;
      this._pendingPeer = null;
    }
  }

  tick(tCycles) {
    if (this._state === ST_MASTER_RUN) {
      this._counter -= tCycles;
      if (this._counter <= 0) {
        const out = this.sb;
        this._pendingPeer = null;
        if (this.onSend) this.onSend(out); // peer may reply synchronously
        if (this._pendingPeer !== null) this._complete(this._pendingPeer);
        else { this._state = ST_MASTER_WAIT; this._counter = REPLY_TIMEOUT; }
      }
    } else if (this._state === ST_MASTER_WAIT) {
      this._counter -= tCycles;
      if (this._counter <= 0) this._complete(0xFF); // no reply: like no cable
    }
  }

  // Peer delivered a byte (their master clock, or the reply half of an exchange).
  receiveByte(b) {
    b &= 0xFF;
    if (this._state === ST_MASTER_WAIT) {
      this._complete(b);
    } else if (this._armed) {
      // slave transfer completes on the peer's clock; our byte goes out
      this._armed = false;
      const out = this.sb;
      this.sb = b;
      this.sc &= ~0x80;
      if (this.onSend) this.onSend(out);
      this._irq();
    } else if (this._state === ST_MASTER_RUN) {
      this._pendingPeer = b; // reply raced ahead of our 8 clocks
    } else {
      // unsolicited byte (peer-clocked transfer we never armed for): latch it
      this.sb = b;
      this._irq();
    }
  }

  _complete(inByte) {
    this._state = ST_IDLE;
    this._counter = 0;
    this._pendingPeer = null;
    this.sc &= ~0x80;
    this.sb = inByte & 0xFF;
    this._irq();
  }

  _irq() {
    if (this.onComplete) this.onComplete();
    // serial interrupt (bit 3) via the machine's interrupt line
    if (this.requestInterrupt) this.requestInterrupt(3);
  }

  serialize() {
    return { sb: this.sb, sc: this.sc };
  }

  restore(s) {
    if (!s) return;
    this.sb = s.sb | 0;
    this.sc = (s.sc & 0x81) | 0x7E;
    this._state = ST_IDLE;
    this._counter = 0;
    this._armed = false;
    this._pendingPeer = null;
  }
}

if (typeof module !== 'undefined') module.exports = { Serial };
