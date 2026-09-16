// dmg-acid2 PPU conformance test (https://github.com/mattcurrie/dmg-acid2)
// Runs the ROM headless until the screen is stable, then compares every pixel
// against the reference image captured from real DMG hardware.
// Dependency-free PNG codec for the 2-bit grayscale reference / 8-bit debug dump.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { GameBoy } = require('../src/core/gameboy.js');

// ---------- minimal PNG decode (bit depths 1/2/8, colorType 0, non-interlaced) ----------
function decodeGrayPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8];
      if (data[9] !== 0) throw new Error('colorType ' + data[9] + ' unsupported');
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerLine = Math.ceil(w * depth / 8);
  const bpp = Math.max(1, Math.floor(depth / 8)) || 1; // filter unit
  const out = new Uint8Array(w * h);
  const line = Buffer.alloc(bytesPerLine), prev = Buffer.alloc(bytesPerLine);
  for (let y = 0; y < h; y++) {
    const p = y * (bytesPerLine + 1);
    const filter = raw[p];
    raw.copy(line, 0, p + 1, p + 1 + bytesPerLine);
    for (let i = 0; i < bytesPerLine; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 0xFF;
    }
    line.copy(prev, 0);
    if (depth === 8) line.copy(out, y * w);
    else for (let x = 0; x < w; x++) {
      const bitPos = x * depth, byte = line[bitPos >> 3];
      const shift = 8 - depth - (bitPos & 7);
      out[y * w + x] = (byte >> shift) & ((1 << depth) - 1);
    }
  }
  return { width: w, height: h, pixels: out };
}

// ---------- minimal 8-bit gray PNG encode (for debug dumps) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodeGrayPng(pixels, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit grayscale
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; Buffer.from(pixels.buffer, pixels.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1); }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- run the ROM until the framebuffer is stable ----------
function runToStability(maxFrames = 1200) {
  const gb = new GameBoy();
  gb.loadROM(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'dmg-acid2.gb')));
  let fb = null, stableFor = 0, prev = null;
  for (let f = 0; f < maxFrames; f++) {
    const cur = gb.runFrame();
    if (cur && f > 120) {
      if (prev && Buffer.compare(Buffer.from(cur), Buffer.from(prev)) === 0) {
        stableFor++;
        if (stableFor >= 90) { fb = cur; break; }
      } else stableFor = 0;
      prev = cur;
    }
  }
  if (!fb) fb = gb.ppu.framebuffer; // fall back to whatever is on screen
  return { gb, fb };
}

test('dmg-acid2: PPU renders the reference image pixel-perfectly', () => {
  const { gb, fb } = runToStability();

  const ref = decodeGrayPng(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'reference-dmg.png')));
  assert.strictEqual(ref.width, 160);
  assert.strictEqual(ref.height, 144);

  // Reference gray value v (0=black..3=white) maps to shade index 3-v on DMG.
  // Verify polarity empirically instead of assuming.
  const refShades = new Uint8Array(160 * 144);
  for (let i = 0; i < refShades.length; i++) refShades[i] = 3 - ref.pixels[i];

  let mismatches = 0;
  const firstFew = [];
  for (let i = 0; i < 160 * 144; i++) {
    if ((fb[i] & 3) !== refShades[i]) {
      mismatches++;
      if (firstFew.length < 12) firstFew.push(`(${i % 160},${(i / 160) | 0}) got ${fb[i] & 3} want ${refShades[i]}`);
    }
  }

  // Debug dump: our framebuffer as gray PNG (shade 0 = white like the reference)
  const dump = new Uint8Array(160 * 144);
  for (let i = 0; i < dump.length; i++) dump[i] = 3 - (fb[i] & 3);
  fs.writeFileSync(path.join(__dirname, 'dmg-acid2', 'actual-dmg.png'), encodeGrayPng(dump, 160, 144));

  assert.strictEqual(mismatches, 0, `dmg-acid2 mismatches: ${mismatches}\nfirst: ${firstFew.join('\n')}`);
});
