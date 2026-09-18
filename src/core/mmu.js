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

    this.cgb = false;            // set by GameBoy.loadROM
    this.dmaActive = false;      // OAM DMA state (see startOAMDMA/dmaTick)
    this.dmaPage = 0;
    this.dmaSrc = 0;
    this.dmaDelay = 0;
    this.dmaRestartGap = 0;
    // WRAM: bank 0 (C000-CFFF) then banks 1-7 (D000-DFFF), bank n at n*0x1000.
    // On DMG only banks 0-1 exist; wramBank stays 1 so the layout matches.
    this.wram = new Uint8Array(0x8000);
    this.wramBank = 1;           // SVBK: current bank for D000-DFFF (CGB, 0 reads as 1)
    this.ff72 = 0; this.ff73 = 0; this.ff74 = 0; this.ff75 = 0; // CGB FF72-FF75
    this.hram = new Uint8Array(0x80);
    this.serial = null; // Serial instance (set by GameBoy.loadROM)

    this.ie = 0x00; // IE (FFFF)
    this.if = 0xE1; // IF (FF0F) — post-boot value
  }

  read(a) {
    a &= 0xFFFF;
    // Boot ROM maps at 0000-00FF (DMG) or 0000-08FF (CGB) until FF50 unlocks it
    if (this.bootrom && !this.bootromDisabled && a < (this.cgb ? 0x900 : 0x100)) return this.bootrom[a];
    if (a < 0x8000) return this.cart.readRom(a);
    if (a < 0xA000) return this.ppu.readVRAM(a);
    if (a < 0xC000) return this.cart.readRam(a);
    if (a < 0xFE00) return this.readWRAM(a);
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
    if (a < 0xFE00) { this.writeWRAM(a, v); return; }
    if (a < 0xFEA0) { this.ppu.writeOAM(a, v); return; }
    if (a < 0xFF00) return; // unusable
    if (a < 0xFF80) { this.writeIO(a, v); return; }
    if (a < 0xFFFF) { this.hram[a - 0xFF80] = v; return; }
    if (a === 0xFFFF) { this.ie = v; return; }
  }

  // WRAM including the E000-FDFF echo of C000-DDFF. Offsets 0x000-0xFFF are
  // fixed bank 0; the rest uses the SVBK-selected bank (0 maps to bank 8).
  readWRAM(a) {
    const off = a & 0x1FFF;
    if (off < 0x1000) return this.wram[off];
    return this.wram[this.wramBank * 0x1000 + (off - 0x1000)];
  }
  writeWRAM(a, v) {
    const off = a & 0x1FFF;
    if (off < 0x1000) { this.wram[off] = v; return; }
    this.wram[this.wramBank * 0x1000 + (off - 0x1000)] = v;
  }

  requestInterrupt(bit) { this.if |= (1 << bit) & 0x1F; }

  // ---- OAM DMA (FF46): 160-byte copy over 648 T-cycles (2 startup + 160×4 + 4) ----
  startOAMDMA(v) {
    if (this.dmaActive) return; // a write during an active DMA is ignored (no restart)
    this.dmaPage = v;
    this.dmaSrc = 0;
    this.dmaDelay = 8;      // T-cycles before the first byte (hardware ~2 m-cycles)
    this.dmaRestartGap = 0; // OAM-restart gap after the copy (blocks OAM access briefly)
    this.dmaActive = true;
  }

  dmaTick(tCycles) {
    if (!this.dmaActive) return;
    let n = tCycles;
    while (n > 0) {
      if (this.dmaDelay > 0) {
        const step = Math.min(n, this.dmaDelay);
        this.dmaDelay -= step;
        n -= step;
      } else if (this.dmaSrc >= 0xA0) { // copy done: burn the restart gap
        this.dmaRestartGap += n;
        n = 0;
        if (this.dmaRestartGap >= 16) this.dmaActive = false;
      } else {
        this.ppu.writeOAM(0xFE00 + this.dmaSrc, this.read((this.dmaPage << 8) + this.dmaSrc));
        this.dmaSrc++;
        n -= 4; // one byte per 4 T-cycles
      }
    }
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
      case 0xFF4D: // KEY1 — CGB speed switch (FF on DMG)
        if (!this.cgb) return 0xFF;
        return 0x7E | (this.cpu.doubleSpeed ? 0x80 : 0) | (this.cpu.speedSwitchArmed ? 0x01 : 0);
    }
    if (a >= 0xFF10 && a <= 0xFF3F) return this.apu.read(a);
    if (this.cgb) return this.readIOcgb(a);
    return 0xFF;
  }

  // CGB-only registers (undefined on DMG: reads return FF, writes are ignored)
  readIOcgb(a) {
    switch (a) {
      case 0xFF4F: return this.ppu.readVBK();
      case 0xFF51: return 0xFF; case 0xFF52: return 0xFF; // HDMA1-4 write-only
      case 0xFF53: return 0xFF; case 0xFF54: return 0xFF;
      case 0xFF55: return this.ppu.readHDMA5();
      case 0xFF68: return this.ppu.bgpi | (this.ppu.bcpsIncrement ? 0x80 : 0);
      case 0xFF69: return this.ppu.readBGPD();
      case 0xFF6A: return this.ppu.ocpi | (this.ppu.ocpsIncrement ? 0x80 : 0);
      case 0xFF6B: return this.ppu.readOCPD();
      case 0xFF6C: return this.ppu.opri ? 0x01 : 0xFE; // OPRI: object priority mode
      case 0xFF70: return this.wramBank | 0xF8; // SVBK
      case 0xFF72: return this.ff72;
      case 0xFF73: return this.ff73;
      case 0xFF74: return this.ff74;
      case 0xFF75: return 0x8F | (this.ff75 & 0x60);
    }
    return 0xFF;
  }

  writeIO(a, v) {
    switch (a) {
      case 0xFF00: this.joypad.write(v); return;
      case 0xFF01: if (this.serial) this.serial.writeSB(v); return;
      case 0xFF02: if (this.serial) this.serial.writeSC(v); return;
      case 0xFF04: this.timer.writeDIV(); return;
      case 0xFF05: this.timer.writeTIMA(v); return;
      case 0xFF06: this.timer.tma = v; return;
      case 0xFF07: this.timer.writeTAC(v & 0x07); return;
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
      case 0xFF50: this.bootromDisabled = true; return; // any write unlocks
      case 0xFF4D: if (this.cgb) this.cpu.speedSwitchArmed = !!(v & 1); return;
    }
    if (a >= 0xFF10 && a <= 0xFF3F) { this.apu.write(a, v); return; }
    if (this.cgb) this.writeIOcgb(a, v);
  }

  writeIOcgb(a, v) {
    switch (a) {
      case 0xFF4F: this.ppu.writeVBK(v); return;
      case 0xFF51: this.ppu.writeHDMA1(v); return;
      case 0xFF52: this.ppu.writeHDMA2(v); return;
      case 0xFF53: this.ppu.writeHDMA3(v); return;
      case 0xFF54: this.ppu.writeHDMA4(v); return;
      case 0xFF55: this.ppu.writeHDMA5(v); return;
      case 0xFF68: this.ppu.writeBGPI(v); return;
      case 0xFF69: this.ppu.writeBGPD(v); return;
      case 0xFF6A: this.ppu.writeOCPI(v); return;
      case 0xFF6B: this.ppu.writeOCPD(v); return;
      case 0xFF6C: this.ppu.opri = v & 1; return; // OPRI: 0 = OAM order, 1 = X coord (DMG-style)
      case 0xFF70: this.wramBank = (v & 0x07) || 1; return; // SVBK (0 aliases bank 1)
      case 0xFF72: this.ff72 = v; return;
      case 0xFF73: this.ff73 = v; return;
      case 0xFF74: this.ff74 = v; return;
      case 0xFF75: this.ff75 = v & 0x60; return;
    }
  }
}

if (typeof module !== 'undefined') module.exports = { MMU };
