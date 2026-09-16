// PocketGB — cartridge parsing and memory bank controllers (MBC0/1/3/5 + RTC)
'use strict';

class Cartridge {
  constructor(rom) {
    this.rom = rom; // Uint8Array
    this.romBanks = [];
    for (let i = 0; i < rom.length; i += 0x4000) this.romBanks.push(rom.subarray(i, Math.min(i + 0x4000, rom.length)));
    this.parseHeader();
    this.ram = new Uint8Array(this.ramSize);
    this.ramEnabled = false;
    this.battery = this.hasBattery;
    this.dirty = false;
    // MBC state
    this.romBank = 1;        // low bits
    this.ramBank = 0;
    this.mode = 0;           // MBC1 mode
    this.bank2 = 0;          // MBC1 upper ROM bits / RTC register select
    this.rtcSelect = 0;
    this.rtc = { sec: 0, min: 0, hour: 0, dl: 0, secLatched: 0, minLatched: 0, hourLatched: 0, dlLatched: 0, latched: false, base: Date.now(), halt: false, dayCarry: false };
    this.rtcDirty = false;
    this.rtcTimer = null;
    this.startRtcClock();
  }

  parseHeader() {
    const r = this.rom;
    const cartType = r[0x147];
    const romSizeCode = r[0x148];
    const ramSizeCode = r[0x149];

    const romSizes = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192]; // KB
    let romKB = romSizeCode < romSizes.length ? romSizes[romSizeCode] : Math.ceil(r.length / 1024);
    if (r.length !== romKB * 1024) romKB = Math.ceil(r.length / 1024); // trust file size if mismatched
    this.numRomBanks = Math.max(2, Math.ceil(romKB / 16));

    this.ramSize = [0, 2048, 8192, 32768, 131072, 65536][ramSizeCode] ?? 0;
    if (cartType === 0x05 || cartType === 0x06) this.ramSize = 512; // MBC2

    this.hasBattery = [0x03, 0x06, 0x09, 0x0D, 0x0F, 0x10, 0x13, 0x1B, 0x1E].includes(cartType);
    this.hasRtc = (cartType === 0x0F || cartType === 0x10);
    this.hasRumble = (cartType >= 0x1C && cartType <= 0x1E);

    const t = cartType;
    this.mbc = (t === 0x00) ? 0
      : (t >= 0x01 && t <= 0x03) ? 1
      : (t === 0x05 || t === 0x06) ? 2
      : (t >= 0x0F && t <= 0x13) ? 3
      : (t >= 0x19 && t <= 0x1E) ? 5
      : 1;
    // Fallback heuristic for headers that lie (homebrew): ROM-only + big + RAM = MBC5
    if (this.mbc === 0 && this.numRomBanks > 2 && this.ramSize > 0) this.mbc = 5;

    this.title = '';
    for (let i = 0x134; i <= 0x142; i++) { const ch = r[i]; if (ch >= 32 && ch < 127) this.title += String.fromCharCode(ch); }
    this.title = this.title.trim();
    this.cgbFlag = r[0x143];
    this.isGBC = this.cgbFlag === 0xC0;
  }

  // ---- battery RAM ----
  loadSav(u8) {
    if (!u8 || !u8.length) return;
    const n = Math.min(u8.length, this.ram.length);
    this.ram.set(u8.subarray(0, n));
    if (this.hasRtc && u8.length > this.ram.length) {
      // Blargg's RTC format: 48 bytes appended
      const o = this.ram.length;
      this.rtc.secLatched = u8[o] | 0; this.rtc.sec = u8[o] | 0;
      this.rtc.minLatched = u8[o + 4] | 0; this.rtc.min = u8[o + 4] | 0;
      this.rtc.hourLatched = u8[o + 8] | 0; this.rtc.hour = u8[o + 8] | 0;
      this.rtc.dlLatched = u8[o + 12] | 0; this.rtc.dl = u8[o + 12] | 0;
      this.rtc.base = Date.now();
    }
  }
  serializeSav() {
    let extra = 0;
    if (this.hasRtc) extra = 48;
    const out = new Uint8Array(this.ram.length + extra);
    out.set(this.ram);
    if (this.hasRtc) {
      const o = this.ram.length;
      out[o] = this.rtc.sec & 0xFF; out[o + 4] = this.rtc.min & 0xFF;
      out[o + 8] = this.rtc.hour & 0xFF; out[o + 12] = this.rtc.dl & 0xFF;
      // bytes at +16..+47 are parameter bytes (halt flag, day carry) — leave 0
      if (this.rtc.halt) out[o + 16] = 0x40;
      if (this.rtc.dayCarry) out[o + 16] |= 0x80;
    }
    return out;
  }

  startRtcClock() {
    if (this.rtcTimer) clearInterval(this.rtcTimer);
    this.rtcTimer = setInterval(() => {
      if (this.rtc.halt) return;
      this.rtc.sec++;
      if (this.rtc.sec >= 60) { this.rtc.sec = 0; this.rtc.min++; }
      if (this.rtc.min >= 60) { this.rtc.min = 0; this.rtc.hour++; }
      if (this.rtc.hour >= 24) { this.rtc.hour = 0; this.rtc.dl++; }
      if (this.rtc.dl > 0x1FF) { this.rtc.dl = 0; this.rtc.dayCarry = true; }
      this.rtcDirty = true;
    }, 1000);
    if (this.rtcTimer.unref) this.rtcTimer.unref(); // never block process exit
  }
  stopRtcClock() { if (this.rtcTimer) { clearInterval(this.rtcTimer); this.rtcTimer = null; } }

  latchRtc(data) {
    if (data & 1) {
      const now = (Date.now() - this.rtc.base) / 1000;
      // advance from base then latch (keeps continuity with the 1s timer)
      this.rtc.secLatched = this.rtc.sec; this.rtc.minLatched = this.rtc.min;
      this.rtc.hourLatched = this.rtc.hour; this.rtc.dlLatched = this.rtc.dl;
      this.rtc.latched = true;
    }
  }

  rtcRegister() {
    const map = [this.rtc.secLatched, this.rtc.minLatched, this.rtc.hourLatched, this.rtc.dlLatched & 0xFF, this.rtc.dlLatched >> 8];
    const v = map[this.rtcSelect] ?? 0xFF;
    if (this.rtcSelect === 4) return (v & 1) | (this.rtc.dayCarry ? 2 : 0) | (this.rtc.halt ? 0x40 : 0);
    return v;
  }
  setRtcRegister(v) {
    switch (this.rtcSelect) {
      case 0: this.rtc.sec = v; break;
      case 1: this.rtc.min = v; break;
      case 2: this.rtc.hour = v; break;
      case 3: this.rtc.dl = (this.rtc.dl & 0x100) | (v & 0xFF); break;
      case 4: this.rtc.dl = (this.rtc.dl & 0xFF) | ((v & 1) << 8); this.rtc.halt = !!(v & 0x40); this.rtc.dayCarry = !!(v & 0x80); break;
    }
    this.rtcDirty = true;
  }

  // ---- banking ----
  handleBankWrite(a, v) {
    switch (this.mbc) {
      case 0: return;
      case 1: {
        if (a < 0x2000) { this.ramEnabled = (v & 0xF) === 0xA; return; }
        if (a < 0x4000) { this.romBank = v & 0x1F; return; }
        if (a < 0x6000) { this.bank2 = v & 3; return; }
        this.mode = v & 1; return;
      }
      case 2: {
        if (a < 0x4000) {
          if (a & 0x100) { this.romBank = v & 0x0F; }
          else { this.ramEnabled = (v & 0xF) === 0xA; }
          return;
        }
        return;
      }
      case 3: {
        if (a < 0x2000) { this.ramEnabled = (v & 0xF) === 0xA; return; }
        if (a < 0x4000) { this.romBank = v & 0x7F; return; }
        if (a < 0x6000) { this.ramBank = v & 0x0F; return; }
        this.latchRtc(v); return;
      }
      case 5: {
        if (a < 0x2000) { this.ramEnabled = (v & 0xF) === 0xA; return; }
        if (a < 0x3000) { this.romBank = (this.romBank & 0x100) | (v & 0xFF); return; }
        if (a < 0x4000) { this.romBank = (this.romBank & 0xFF) | ((v & 1) << 8); return; }
        if (a < 0x6000) { this.ramBank = v & 0x0F; return; }
        return;
      }
    }
  }

  readRom(addr) {
    // addr in 0x0000-0x7FFF
    let bank;
    if (addr < 0x4000) {
      bank = 0;
      if (this.mbc === 1 && this.mode === 1) bank = (this.bank2 << 5) % this.numRomBanks;
    } else {
      let b = this.romBank;
      if (this.mbc === 1) b |= (this.mode === 1 ? this.bank2 << 5 : 0);
      bank = b % this.numRomBanks;
      // MBC1/2/3 skip bank 0 in the switchable area (maps to 1); MBC5 may map 0 legally
      if (bank === 0 && this.mbc !== 5 && this.mbc !== 0) bank = 1 % this.numRomBanks;
    }
    const arr = this.romBanks[bank] || this.romBanks[0];
    const romByte = arr[addr & 0x3FFF];
    if (this.cheats) {
      const patched = this.cheats.patchROM(addr, romByte);
      if (patched !== undefined) return patched;
    }
    return romByte;
  }

  readRam(addr) {
    if (this.mbc === 3 && this.ramBank >= 0x08 && this.ramBank <= 0x0C) {
      if (!this.rtc.latched) { // live read
        this.latchRtc(1); // latch current values
        this.rtc.latched = false; // but keep live semantics per-read
        const save = { s: this.rtc.secLatched, m: this.rtc.minLatched, h: this.rtc.hourLatched, d: this.rtc.dlLatched };
        const map = [save.s, save.m, save.h, save.d & 0xFF, save.d >> 8];
        return map[this.rtcSelect] ?? 0xFF;
      }
      return this.rtcRegister();
    }
    if (!this.ramEnabled || this.ramSize === 0) return 0xFF;
    if (this.mbc === 2) { // MBC2 built-in 512x4 RAM
      const idx = (addr - 0xA000) & 0x1FF;
      return this.ram[idx] & 0x0F;
    }
    const mask = this.ramSize > 8192 ? 0x1FFF : 0x07FF;
    return this.ram[((this.ramBank & 0x03) * 0x2000 + (addr - 0xA000)) & mask] ?? 0xFF;
  }

  writeRam(addr, v) {
    if (this.mbc === 3 && this.ramBank >= 0x08 && this.ramBank <= 0x0C) { this.setRtcRegister(v); return; }
    if (!this.ramEnabled || this.ramSize === 0) return;
    if (this.mbc === 2) {
      const idx = (addr - 0xA000) & 0x1FF;
      this.ram[idx] = v & 0x0F;
      this.dirty = true;
      return;
    }
    const mask = this.ramSize > 8192 ? 0x1FFF : 0x07FF;
    const phys = ((this.ramBank & 0x03) * 0x2000 + (addr - 0xA000)) & mask;
    if (this.ram[phys] !== v) { this.ram[phys] = v; this.dirty = true; }
  }

  dispose() { this.stopRtcClock(); }
}

if (typeof module !== 'undefined') module.exports = { Cartridge };
