// PocketGB — Game Boy Printer (serial accessory, MBC3-era hardware)
//
// The printer listens on the link port. The game sends packets:
//   bytes 0-1  magic 0x88 0x33
//   byte  2    command (0x01 init, 0x02 print, 0x04 data, 0x0F inquiry)
//   byte  3    compression flag (0x01 = RLE)
//   bytes 4-5  payload length (LE)
//   payload
//   byte  -2   checksum lo, byte -1 checksum hi (sum of bytes 2..-3, LE)
//
// Print data payload: 40-byte tile rows. Each tile is 16 bytes (8×8 2bpp),
// groups of 2 tiles = 1 byte palette byte between them. Standard payload is
// 640 bytes = 20 tiles = 160 px wide (one printer line = 16 scanlines).
// RLE: control byte 0 = literal (n+1 bytes follow); else (n&0x7F)+2 copies
// of the next byte.
'use strict';

const CMD_INIT = 0x01, CMD_PRINT = 0x02, CMD_DATA = 0x04, CMD_INQUIRY = 0x0F;

const TILE_W = 8, TILE_H = 8, TILE_BYTES = 16;
const LINE_BYTES = 640; // 40 tiles = 160×16 px per data payload

class GBPrinter {
  constructor() {
    this.reset();
  }
  reset() {
    this._buf = [];          // incoming packet bytes
    this._need = 10;         // bytes still required (header first, then re-aimed)
    this.image = [];         // decoded 2bpp palette indices, row-major
    this.width = 160;
    this.status = 0;         // last inquiry/print status byte
    this.printing = false;
    this.printProgress = 0;
    this.sheets = 0;         // completed prints
    this.onPrint = null;     // (pngBytes: Uint8Array) => void
    this._printTimer = null;
  }

  // Serial hook: the game clocks out one byte; we reply the printer's status.
  receiveByte(b) {
    this._buf.push(b & 0xFF);
    if (this._buf.length < 6) return this.statusByte(); // still reading the header
    const len = this._buf[4] | (this._buf[5] << 8);
    const total = 6 + len + 2;
    if (this._buf.length < total) return this.statusByte();
    const pkt = this._buf;
    if (pkt.length < 6 || pkt[0] !== 0x88 || pkt[1] !== 0x33) {
      this.resetPacket();
      return this.statusByte();
    }
    this.status |= 0x80; // magic received (stays set for the session)
    const cmd = pkt[2], compressed = pkt[3] === 1;
    this._buf = [];   // packet consumed (valid or not)
    // checksum over command..payload end
    let sum = 0;
    for (let i = 2; i < 6 + len; i++) sum = (sum + pkt[i]) & 0xFFFF;
    const ok = sum === ((pkt[6 + len] | (pkt[7 + len] << 8)) & 0xFFFF);
    if (!ok) { this.status |= 0x01; return this.statusByte(); } // CRC error flag
    this.status &= ~0x01; // a valid packet clears the error
    const payload = pkt.slice(6, 6 + len);
    switch (cmd) {
      case CMD_DATA: this.consumeData(compressed ? this.decompress(payload) : payload); break;
      case CMD_PRINT: this.startPrint(payload); break;
      case CMD_INIT: case CMD_INQUIRY: break;
    }
    return this.statusByte();
  }

  statusByte() {
    // Bits: 7 = magic seen, 1 = battery low(0=ok), 0 = CRC error.
    // While printing, bit0 doubles as "busy" — no packet is in flight, so
    // games polling INQUIRY read it until it clears.
    if (this.printing) return (this.status | 0x01) & 0xFF;
    return this.status & 0xFF;
  }

  resetPacket() {
    // resync: drop everything before a possible magic pair
    while (this._buf.length && (this._buf[0] !== 0x88 || (this._buf.length > 1 && this._buf[1] !== 0x33))) this._buf.shift();
    if (this._buf.length === 1 && this._buf[0] !== 0x88) this._buf = [];
  }

  decompress(p) {
    const out = [];
    let i = 0;
    while (i < p.length) {
      const c = p[i++];
      if (c === 0) { const n = p[i++] + 1; for (let k = 0; k < n; k++) out.push(p[i++]); }
      else { const n = (c & 0x7F) + 2; const v = p[i++]; for (let k = 0; k < n; k++) out.push(v); }
    }
    return Uint8Array.from(out);
  }

  consumeData(payload) {
    // 640 bytes = 40 8×8 2bpp tiles (2 tile-rows of 20), plain planar data
    const tiles = Math.floor(payload.length / TILE_BYTES);
    for (let t = 0; t < tiles; t++) {
      for (let y = 0; y < TILE_H; y++) {
        const lo = payload[t * TILE_BYTES + y * 2], hi = payload[t * TILE_BYTES + y * 2 + 1];
        for (let x = 0; x < TILE_W; x++) {
          const bit = 7 - x;
          this.image.push(((lo >> bit) & 1) | (((hi >> bit) & 1) << 1));
        }
      }
    }
  }

  startPrint(margins) {
    void margins;
    if (!this.image.length) { this.status |= 0x80; return; }
    this.printing = true;
    this.printProgress = 0;
    // the real printer feeds 16-line bands with visible pauses; compress to ~1.2 s
    const bands = Math.ceil(this.image.length / (this.width * 16));
    this._printTimer = setInterval(() => {
      this.printProgress++;
      if (this.printProgress >= Math.max(3, bands)) {
        clearInterval(this._printTimer);
        this._printTimer = null;
        this.printing = false;
        this.sheets++;
        this.status = (this.status & ~0x80) | 0x80; // done (bit semantics per game expectations)
        if (this.onPrint) this.onPrint(this.renderPNG());
        this.image = [];
      }
    }, 400);
    if (this._printTimer.unref) this._printTimer.unref();
  }

  // Render accumulated pixels to an uncompressed-grayscale PNG (1 byte/px).
  renderPNG() {
    const w = this.width, h = this.image.length / w | 0;
    const raw = new Uint8Array(h * (1 + w));
    for (let y = 0; y < h; y++) {
      raw[y * (1 + w)] = 0; // filter: none
      for (let x = 0; x < w; x++) raw[y * (1 + w) + 1 + x] = this.image[y * w + x] * 85;
    }
    return encodePNG(raw, w, h, 8);
  }
}

// ---- minimal PNG writer (grayscale/grayalpha-safe, zlib stored blocks) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function encodePNG(raw, w, h, bitDepth) {
  void bitDepth;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // zlib with stored (uncompressed) deflate blocks
  const blocks = [];
  for (let i = 0; i < raw.length; i += 0xFFFF) {
    const slice = raw.subarray(i, Math.min(i + 0xFFFF, raw.length));
    blocks.push([i + 0xFFFF < raw.length ? 0 : 1, slice]);
  }
  const zsize = raw.length + blocks.length * 5 + 6;
  const z = new Uint8Array(zsize);
  z[0] = 0x78; z[1] = 0x01;
  let zp = 2;
  for (const [last, slice] of blocks) {
    z[zp++] = last;
    z[zp++] = slice.length & 0xFF; z[zp++] = slice.length >> 8;
    z[zp++] = ~slice.length & 0xFF; z[zp++] = (~slice.length >> 8) & 0xFF;
    z.set(slice, zp); zp += slice.length;
  }
  const adler = adler32(raw);
  z[zp++] = (adler >>> 24) & 0xFF; z[zp++] = (adler >>> 16) & 0xFF;
  z[zp++] = (adler >>> 8) & 0xFF; z[zp] = adler & 0xFF;
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

if (typeof module !== 'undefined') module.exports = { GBPrinter, encodePNG };
if (typeof window !== 'undefined') window.GBPrinter = GBPrinter;
