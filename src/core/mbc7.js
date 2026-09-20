// PocketGB — MBC7 accelerometer (Kirby Tilt'n'Tumble) + EEPROM (93LC56)
//
// Pan Docs MBC7: A000-AFFF is a small register file addressed by bits 4-7 of
// the bus address, gated behind TWO enable writes (0000-1FFF = 0x0A, then
// 4000-5FFF = 0x40). The accelerometer is an ADXL202E: 16-bit samples,
// centered 0x81D0, roughly 0x70 per g. Games must write 0x55 to Ax0x (erase)
// then 0xAA to Ax1x (latch) before reading; re-latching without an erase does
// nothing — Kirby Tilt'n'Tumble relies on this latch dance every frame.
//
// The EEPROM (93LC56, 256 bytes as 128 × 16-bit words) is driven bit-by-bit
// through the Ax8x register: CS (bit 7), CLK (bit 6), DI (bit 1), DO (bit 0).
// The game shifts in a start bit + opcode + 7-bit address, then reads/writes
// 16 bits MSB-first. Save data lives here, so the words are kept in cart RAM
// (this.ram) by the cartridge — this module only drives the protocol.
'use strict';

const MBC7_BASE = 0x81D0;  // level center
const MBC7_PER_G = 0x70;   // counts per g
const MBC7_MIN = 0x81D0 - 0x6A0; // ≈ ±12g span, matching hardware range
const MBC7_MAX = 0x81D0 + 0x6A0;

class Mbc7 {
  constructor(cart) {
    this.cart = cart;
    this.enabled1 = false;  // 0000-1FFF gate (0x0A)
    this.enabled2 = false;  // 4000-5FFF gate (0x40)
    this.latched = false;   // 0x55 then 0xAA seen → samples addressable
    this.x = 0x81D0;        // current tilt, set by the UI each frame
    this.y = 0x81D0;
    this.lx = 0x8000;       // latched samples (0x8000 before first latch)
    this.ly = 0x8000;
    // EEPROM protocol state
    this.eepromClk = 0;
    this.eepromCS = 0;
    this.eepromDI = 0;
    this._prevClk = 0;
    this._bits = [];        // shifted-in bits since CS rise
    this._busy = 0;         // programming cycles remaining (DO reads 0 while busy)
  }

  // UI hook: set tilt from -1..1 (left/right, down/up). Input mapping lives in
  // the app layer (arrow keys or gamepad axes); the core only needs counts.
  setTilt(nx, ny) {
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    this.x = Math.round(MBC7_BASE + clamp(nx) * MBC7_PER_G * 8);
    this.y = Math.round(MBC7_BASE + clamp(ny) * MBC7_PER_G * 8);
    this.x = Math.max(MBC7_MIN, Math.min(MBC7_MAX, this.x));
    this.y = Math.max(MBC7_MIN, Math.min(MBC7_MAX, this.y));
  }

  reset() {
    this.enabled1 = this.enabled2 = false;
    this.latched = false;
    this.lx = this.ly = 0x8000;
    this._bits.length = 0;
    this._busy = 0;
  }

  handleWrite(addr, v) {
    if (addr < 0x2000) { this.enabled1 = (v & 0x0F) === 0x0A; return; }
    if (addr < 0x4000) { /* ROM bank — handled by the cart like MBC5 */ return; }
    if (addr < 0x6000) { this.enabled2 = v === 0x40; return; }
  }

  // Returns a byte for A000-BFFF reads, or undefined if not ours to answer.
  read(addr) {
    if (!this.enabled1 || !this.enabled2) return 0xFF;
    if (addr < 0xA000 || addr >= 0xB000) return 0xFF;
    const reg = (addr >> 4) & 0x0F;
    switch (reg) {
      case 0x2: return this.lx & 0xFF;         // X low
      case 0x3: return (this.lx >> 8) & 0xFF;  // X high
      case 0x4: return this.ly & 0xFF;         // Y low
      case 0x5: return (this.ly >> 8) & 0xFF;  // Y high
      case 0x6: return 0x00;                   // reserved
      case 0x7: return 0xFF;                   // reserved
      case 0x8: return this._eepromRead();     // EEPROM pins
      default: return 0xFF;                    // 0-1 write-only latch, 9-F unused
    }
  }

  // Returns true if the write was consumed (A000-BFFF register write).
  write(addr, v) {
    if (!this.enabled1 || !this.enabled2) return addr >= 0xA000 && addr < 0xB000;
    if (addr < 0xA000 || addr >= 0xB000) return false;
    const reg = (addr >> 4) & 0x0F;
    if (reg === 0x0) { if (v === 0x55) this.latched = false; return true; }      // erase
    if (reg === 0x1) { if (v === 0xAA && !this.latched) { this.lx = this.x; this.ly = this.y; this.latched = true; } return true; } // latch (once per erase)
    if (reg === 0x8) { this._eepromWrite(v); return true; }
    return true; // other registers: writes do nothing but are consumed
  }

  // ---- 93LC56 protocol ----
  _eepromRead() {
    let out = 0;
    if (this.eepromCS) out |= 0x80;
    if (this.eepromClk) out |= 0x40;
    if (this._doBit) out |= 0x01;
    return out;
  }

  _eepromWrite(v) {
    const cs = !!(v & 0x80), clk = !!(v & 0x40), di = !!(v & 0x02);
    if (!cs) {
      if (this.eepromCS) {
        // CS fall terminates any command: clears the shifter AND ends a
        // read/write data phase (games drop CS between commands).
        this._bits.length = 0;
        this._readMode = false;
        this._writeMode = false;
        this._doBit = 0;
      }
      this.eepromCS = false; this.eepromClk = clk;
      this._prevClk = clk;
      return;
    }
    this.eepromCS = true;
    if (clk && !this._prevClk) {
      // Programming takes time: while busy the chip ignores DI entirely and
      // DO reads 0; the game keeps clocking and polls DO for the ready 1
      // (93LC56 datasheet's RDY/BUSY). Reads themselves are never busy.
      if (this._busy > 0) {
        this._busy--;
        this._doBit = this._busy === 0 ? 1 : 0;
      } else {
        this._eepromClock(di);
      }
    }
    this._prevClk = clk;
    this.eepromClk = clk;
    this.eepromDI = di;
  }

  _eepromClock(di) {
    // Data phase first: 16 rising clocks after a READ/WRITE shift the value
    // out/in before any new command can be accepted.
    if (this._writeMode || this._readMode) { this._eepromDataClock(di); return; }
    // Leading 0s before the start bit are ignored (games send at least one);
    // the start bit is the first 1. Then: 2 opcode bits + 7 address bits.
    const bit = di ? 1 : 0;
    if (this._bits.length === 0 && bit === 0) return;
    this._bits.push(bit);
    if (this._bits.length < 10) return;
    const bits = this._bits;
    const op = (bits[1] << 1) | bits[2];
    const address = (bits[3] << 6) | (bits[4] << 5) | (bits[5] << 4) | (bits[6] << 3) | (bits[7] << 2) | (bits[8] << 1) | bits[9];
    this._runCommand(op, address, bits);
    this._bits.length = 0;
  }

  _runCommand(op, address, bits) {
    const ram = this.cart.ram;
    const wordAt = (a) => (ram[a * 2] | (ram[a * 2 + 1] << 8)) & 0xFFFF;
    // 93LC56 opcodes (x16 organization): 10=READ, 01=WRITE, 11=ERASE,
    // 00=EWEN/EWDS/ERAL/WRAL (selected by the two address bits).
    switch (op) {
      case 2: { // READ: shift out 16 bits MSB-first on DO on subsequent clocks
        // A never-written word reads ERASED (0xFFFF): the Cartridge inits the
        // EEPROM region of a fresh cart to 0xFF (real blank-chip state).
        this._readWord = wordAt(address & 0x7F);
        this._readPos = 0;
        this._readMode = true;
        break;
      }
      case 1: { // WRITE: next 16 clocks carry the data (needs EWEN)
        this._writeAddr = address & 0x7F;
        this._writeAll = false;
        this._dataBits = [];
        this._writeMode = this._ewen;
        break;
      }
      case 3: { // ERASE: fill one word with 0xFFFF (needs EWEN)
        if (this._ewen) {
          ram[address * 2] = 0xFF; ram[address * 2 + 1] = 0xFF;
          this.cart.dirty = true;
          this._busy = 8;
        }
        break;
      }
      case 0: {
        // address bits select: 11=EWEN, 00=EWDS, 10=ERAL (erase all),
        // 01=WRAL (write same value everywhere — data phase follows)
        const sel = (bits[3] << 1) | bits[4];
        if (sel === 3) this._ewen = true;
        else if (sel === 0) this._ewen = false;
        else if (sel === 2 && this._ewen) { ram.fill(0xFF); this.cart.dirty = true; this._busy = 24; }
        else if (sel === 1) { this._writeAll = true; this._dataBits = []; this._writeMode = this._ewen; }
        break;
      }
    }
  }

  // Called by _eepromClock for clocks beyond the command phase.
  _eepromDataClock(di) {
    if (this._writeMode) {
      this._dataBits.push(di ? 1 : 0);
      if (this._dataBits.length === 16) {
        const w = this._dataBits.reduce((acc, b) => (acc << 1) | b, 0);
        if (this._writeAll) {
          for (let a = 0; a < 128; a++) { this.cart.ram[a * 2] = w & 0xFF; this.cart.ram[a * 2 + 1] = (w >> 8) & 0xFF; }
        } else {
          this.cart.ram[this._writeAddr * 2] = w & 0xFF;
          this.cart.ram[this._writeAddr * 2 + 1] = (w >> 8) & 0xFF;
        }
        this.cart.dirty = true;
        this._writeMode = false;
        this._writeAll = false;
        this._busy = 12;
      }
    } else if (this._readMode) {
      this._doBit = (this._readWord >> (15 - this._readPos)) & 1;
      this._readPos = (this._readPos + 1) & 15;
    }
  }
}

if (typeof module !== 'undefined') module.exports = { Mbc7, MBC7_BASE, MBC7_PER_G };
