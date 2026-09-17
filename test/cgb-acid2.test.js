// cgb-acid2 PPU conformance test (https://github.com/mattcurrie/cgb-acid2)
// Runs the CGB test ROM headless until the screen is stable, then compares
// every pixel of our BGR555 framebuffer against the reference image captured
// from real Game Boy Color hardware. The reference is an indexed PNG; its
// PLTE entries are converted back to 5-bit-per-channel values for an exact
// BGR555 compare (robust to either 5→8 bit expansion the author may have used).
// Dependency-free PNG codec, same style as the dmg-acid2 harness.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { GameBoy } = require('../src/core/gameboy.js');

// ---------- minimal PNG decode (indexed colorType 3, depth 1/2/4/8, non-interlaced) ----------
function decodeIndexedPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, palette = null, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8];
      if (data[9] !== 3) throw new Error('colorType ' + data[9] + ' unsupported (want indexed)');
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'PLTE') {
      palette = new Uint8Array(data); // RGB triplets
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!palette) throw new Error('missing PLTE');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerLine = Math.ceil(w * depth / 8);
  const out = new Uint8Array(w * h); // palette indices
  const line = Buffer.alloc(bytesPerLine), prev = Buffer.alloc(bytesPerLine);
  for (let y = 0; y < h; y++) {
    const p = y * (bytesPerLine + 1);
    const filter = raw[p];
    raw.copy(line, 0, p + 1, p + 1 + bytesPerLine);
    for (let i = 0; i < bytesPerLine; i++) {
      const a = i >= 1 ? line[i - 1] : 0, b = prev[i], c = i >= 1 ? prev[i - 1] : 0;
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
    for (let x = 0; x < w; x++) {
      const bitPos = x * depth, byte = line[bitPos >> 3];
      const shift = 8 - depth - (bitPos & 7);
      out[y * w + x] = (byte >> shift) & ((1 << depth) - 1);
    }
  }
  return { width: w, height: h, palette, pixels: out };
}

// ---------- minimal 8-bit truecolor PNG encode (for debug dumps) ----------
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
function encodeRgbPng(rgb, w, h) { // rgb = Uint8Array of w*h*3 bytes
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// PLTE byte → 5-bit channel value, recovering the exact 5-bit source regardless
// of whether the author expanded 5→8 bits with <<3 or *255/31 rounding.
function to5bit(v8) {
  let best = 0, bestErr = Infinity;
  for (let x = 0; x < 32; x++) {
    const err = Math.min(Math.abs(x * 8 - v8), Math.abs(Math.round(x * 255 / 31) - v8));
    if (err < bestErr) { bestErr = err; best = x; }
  }
  return best;
}

// ---------- run the ROM until the framebuffer is stable ----------
function runToStability(maxFrames = 1200) {
  const gb = new GameBoy();
  gb.loadROM(fs.readFileSync(path.join(__dirname, 'cgb-acid2', 'cgb-acid2.gbc')));
  let fb = null, stableFor = 0, prev = null;
  for (let f = 0; f < maxFrames; f++) {
    const cur = gb.runFrame();
    if (cur && f > 120) {
      if (prev && Buffer.compare(Buffer.from(cur.buffer, cur.byteOffset, cur.byteLength),
                                 Buffer.from(prev.buffer, prev.byteOffset, prev.byteLength)) === 0) {
        stableFor++;
        if (stableFor >= 90) { fb = cur; break; }
      } else stableFor = 0;
      prev = cur;
    }
  }
  if (!fb) fb = gb.ppu.colorFramebuffer || gb.ppu.framebuffer;
  return { gb, fb };
}

test('cgb-acid2: CGB PPU renders the reference image pixel-perfectly', () => {
  const { gb, fb } = runToStability();
  assert.ok(gb.ppu.colorFramebuffer, 'CGB ROM selected the CGB PPU');

  const ref = decodeIndexedPng(fs.readFileSync(path.join(__dirname, 'cgb-acid2', 'reference.png')));
  assert.strictEqual(ref.width, 160);
  assert.strictEqual(ref.height, 144);

  // Reference palette index → exact 5-bit (r,g,b)
  const pal5 = [];
  for (let i = 0; i < ref.palette.length; i += 3) {
    pal5.push([to5bit(ref.palette[i]), to5bit(ref.palette[i + 1]), to5bit(ref.palette[i + 2])]);
  }

  let mismatches = 0;
  const firstFew = [];
  for (let i = 0; i < 160 * 144; i++) {
    const c = fb[i];
    const mine = [c & 31, (c >> 5) & 31, (c >> 10) & 31];
    const want = pal5[ref.pixels[i]];
    if (mine[0] !== want[0] || mine[1] !== want[1] || mine[2] !== want[2]) {
      mismatches++;
      if (firstFew.length < 12) {
        firstFew.push(`(${i % 160},${(i / 160) | 0}) got rgb5(${mine}) idx${ref.pixels[i]} want rgb5(${want})`);
      }
    }
  }

  // Debug dump: our framebuffer as truecolor PNG
  const dump = new Uint8Array(160 * 144 * 3);
  for (let i = 0; i < 160 * 144; i++) {
    const c = fb[i];
    dump[i * 3] = (c & 31) << 3;
    dump[i * 3 + 1] = ((c >> 5) & 31) << 3;
    dump[i * 3 + 2] = ((c >> 10) & 31) << 3;
  }
  fs.writeFileSync(path.join(__dirname, 'cgb-acid2', 'actual-cgb.png'), encodeRgbPng(dump, 160, 144));

  assert.strictEqual(mismatches, 0, `cgb-acid2 mismatches: ${mismatches}\nfirst: ${firstFew.join('\n')}`);
});
