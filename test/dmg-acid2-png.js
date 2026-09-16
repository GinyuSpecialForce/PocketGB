// Dump emulator framebuffer (from actual-dmg.png) and reference as 160x144 text grids.
// Both normalized to: 0 = lightest/white ... 3 = darkest/black.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function decodeGrayPng(buf) {
  let off = 8, w = 0, h = 0, depth = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerLine = Math.ceil(w * depth / 8);
  const bpp = Math.max(1, Math.floor(depth / 8)) || 1;
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

const actualPng = decodeGrayPng(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'actual-dmg.png')));
const refPng = decodeGrayPng(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'reference-dmg.png')));

// actual-dmg.png: 8-bit gray, value 3 (dark) = shade 0 (white), value 0 = shade 3.
// reference-dmg.png: 2-bit index, value 0 = black(3), value 3 = white(0).
// Normalize both to 0=white..3=black.
const got = Buffer.alloc(160 * 144);
for (let i = 0; i < got.length; i++) got[i] = 0x30 + (3 - actualPng.pixels[i]);
const want = Buffer.alloc(160 * 144);
for (let i = 0; i < want.length; i++) want[i] = 0x30 + (3 - refPng.pixels[i]);

const gotLines = [], wantLines = [];
for (let y = 0; y < 144; y++) {
  gotLines.push(got.toString('ascii', y * 160, (y + 1) * 160));
  wantLines.push(want.toString('ascii', y * 160, (y + 1) * 160));
}
fs.writeFileSync(path.join(__dirname, 'dmg-acid2', 'got.txt'), gotLines.join('\n') + '\n');
fs.writeFileSync(path.join(__dirname, 'dmg-acid2', 'want.txt'), wantLines.join('\n') + '\n');

let mism = 0;
for (let i = 0; i < 160 * 144; i++) if (got[i] !== want[i]) mism++;
console.log('mismatches after normalization:', mism);
