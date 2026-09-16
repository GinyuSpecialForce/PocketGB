// PocketGB — memory bus
'use strict';

class MMU {
  constructor(cpu, cartridge, ppu, apu, timer, joypad) {
    this.cpu = cpu;
    this.cart = cartridge;
    this.ppu = ppu;
    this.apu = apu;
    this.timer = timer;
    this.joypad = joypad;

    this.wram = new Uint8Array(0x2000);
    this.hram = new Uint8Array(0x80);
    this.serial = null; // Serial instance (set by GameBoy.loadROM)

    this.ie = 0x00; // IE (FFFF)
    this.if = 0xE1; // IF (FF0F) — post-boot value
  }

  read(a) {
    a &= 0xFFFF;
    if (a < 0x8000) return this.cart.readRom(a);
    if (a < 0xA000) return this.ppu.readVRAM(a);
    if (a < 0xC000) return this.cart.readRam(a);
    if (a < 0xFE00) return this.wram[a - 0xC000];
    if (a < 0xFEA0) return this.ppu.readOAM(a);
    if (a < 0xFF00) return 0x00; // unusable
    if (a < 0xFF80) return this.readIO(a);
    if (a < 0xFFFF) return this.hram[a - 0xFF80];
    if (a === 0xFFFF) return this.ie;
    return 0xFF;
  }

  write(a, v) {
    a &= 0xFFFF; v &= 0xFF;
    if (a < 0x8000) { this.cart.handleBankWrite(a, v); return; }
    if (a < 0xA000) { this.ppu.writeVRAM(a, v); return; }
    if (a < 0xC000) { this.cart.writeRam(a, v); return; }
    if (a < 0xFE00) { this.wram[a - 0xC000] = v; return; }
    if (a < 0xFEA0) { this.ppu.writeOAM(a, v); return; }
    if (a < 0xFF00) return; // unusable
    if (a < 0xFF80) { this.writeIO(a, v); return; }
    if (a < 0xFFFF) { this.hram[a - 0xFF80] = v; return; }
    if (a === 0xFFFF) { this.ie = v; return; }
  }

  requestInterrupt(bit) { this.if |= (1 << bit) & 0x1F; }

  // ---- OAM DMA (FF46): copies 160 bytes over 160 m-cycles from page v<<8 ----
  startOAMDMA(v) {
    if (this.dmaActive) return; // a write during an active DMA is ignored (no restart)
    this.dmaPage = v;
    this.dmaSrc = 0;
    this.dmaActive = true;
  }

  dmaTick(mCycles) {
    if (!this.dmaActive) return;
    const page = this.dmaPage << 8;
    let n = mCycles;
    if (this.dmaSrc + n > 0xA0) n = 0xA0 - this.dmaSrc;
    for (let i = 0; i < n; i++) this.ppu.writeOAM(0xFE00 + this.dmaSrc, this.read(page + this.dmaSrc++));
    if (this.dmaSrc >= 0xA0) this.dmaActive = false;
  }

  readIO(a) {
    switch (a) {
      case 0xFF00: return this.joypad.read();
      case 0xFF01: return this.serial ? this.serial.readSB() : 0x00;
      case 0xFF02: return this.serial ? this.serial.readSC() : 0x7E;
      case 0xFF04: return this.timer.div;
      case 0xFF05: return this.timer.tima;
      case 0xFF06: return this.timer.tma;
      case 0xFF07: return this.timer.tac | 0xF8;
      case 0xFF0F: return this.if | 0xE0;
      case 0xFF40: return this.ppu.lcdc;
      case 0xFF41: return this.ppu.stat | 0x80;
      case 0xFF42: return this.ppu.scy;
      case 0xFF43: return this.ppu.scx;
      case 0xFF44: return this.ppu.ly;
      case 0xFF45: return this.ppu.lyc;
      case 0xFF46: return this.ppu.dma;
      case 0xFF47: return this.ppu.bgp;
      case 0xFF48: return this.ppu.obp0;
      case 0xFF49: return this.ppu.obp1;
      case 0xFF4A: return this.ppu.wy;
      case 0xFF4B: return this.ppu.wx;
      case 0xFF50: return this.bootromDisabled ? 0xFF : 0x00;
      case 0xFF4D: return 0xFF; // CGB speed switch — DMG returns FF
    }
    if (a >= 0xFF10 && a <= 0xFF3F) return this.apu.read(a);
    return 0xFF;
  }

  writeIO(a, v) {
    switch (a) {
      case 0xFF00: this.joypad.write(v); return;
      case 0xFF01: if (this.serial) this.serial.writeSB(v); return;
      case 0xFF02: if (this.serial) this.serial.writeSC(v); return;
      case 0xFF04: this.timer.div = 0; return;
      case 0xFF05: this.timer.tima = v; return;
      case 0xFF06: this.timer.tma = v; return;
      case 0xFF07: this.timer.tac = v & 0x07; return;
      case 0xFF0F: this.if = v & 0x1F; return;
      case 0xFF40: this.ppu.writeLCDC(v); return;
      case 0xFF41: this.ppu.writeSTAT(v); return;
      case 0xFF42: this.ppu.scy = v; return;
      case 0xFF43: this.ppu.writeSCX(v); return; // mid-scanline flush
      case 0xFF44: return; // LY read-only
      case 0xFF45: this.ppu.lyc = v; return;
      case 0xFF46: this.ppu.dma = v; this.startOAMDMA(v); return;
      case 0xFF47: this.ppu.bgp = v; return;
      case 0xFF48: this.ppu.obp0 = v; return;
      case 0xFF49: this.ppu.obp1 = v; return;
      case 0xFF4A: this.ppu.writeWY(v); return; // mid-scanline flush
      case 0xFF4B: this.ppu.writeWX(v); return; // mid-scanline flush
      case 0xFF50: this.bootromDisabled = true; return;
      case 0xFF4D: return;
    }
    if (a >= 0xFF10 && a <= 0xFF3F) { this.apu.write(a, v); return; }
  }
}

if (typeof module !== 'undefined') module.exports = { MMU };
