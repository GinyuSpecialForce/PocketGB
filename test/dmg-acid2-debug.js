// Quick diff analysis: cluster mismatches and show ASCII of our render vs reference.
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

const actual = decodeGrayPng(fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'actual-dmg.png')));
const refPng = fs.readFileSync(path.join(__dirname, 'dmg-acid2', 'reference-dmg.png'));
const ref = decodeGrayPng(refPng);

// Our dump: 8-bit gray, value 3 (dark) = shade 0 (white), value 0 = shade 3 (black).
// Reference: 2-bit index, 0=black(3), 3=white(0). Normalize both to 0=white..3=black.
const got = new Uint8Array(160 * 144);
for (let i = 0; i < got.length; i++) got[i] = 3 - actual.pixels[i];
const want = new Uint8Array(160 * 144);
for (let i = 0; i < want.length; i++) want[i] = 3 - ref.pixels[i];

// Per-row / per-column histograms
const rowHist = new Array(144).fill(0);
const colHist = new Array(160).fill(0);
let total = 0;
for (let y = 0; y < 144; y++) {
  for (let x = 0; x < 160; x++) {
    if (got[y * 160 + x] !== want[y * 160 + x]) { rowHist[y]++; colHist[x]++; total++; }
  }
}
console.log('total mismatches:', total);

console.log('\nrows with mismatches (y: count):');
for (let y = 0; y < 144; y++) if (rowHist[y]) console.log(`  ${y}: ${rowHist[y]}`);

console.log('\ncolumns with mismatches (x: count):');
let runs = [];
for (let x = 0; x < 160; x++) {
  if (colHist[x]) {
    if (runs.length && runs[runs.length - 1].end === x - 1) runs[runs.length - 1].end = x;
    else runs.push({ start: x, end: x, n: 0 });
  }
}
for (const r of runs) {
  let n = 0;
  for (let x = r.start; x <= r.end; x++) n += colHist[x];
  r.n = n;
  console.log(`  ${r.start}-${r.end}: ${n}`);
}

// ASCII dump of the two worst row-bands, ours vs reference side by side
const chars = '.123456789'; // 0=white..9=black — use 0123 for shades
function dumpBand(y0, y1) {
  console.log(`\nband y=${y0}..${y1}  ('.'=white 0, 1,2,3 = darker shades)`);
  for (let y = y0; y <= y1; y++) {
    let a = '', b = '', marks = '';
    for (let x = 0; x < 160; x++) {
      const g = got[y * 160 + x], w = want[y * 160 + x];
      a += g === 0 ? '.' : String(g);
      b += w === 0 ? '.' : String(w);
      marks += g === w ? ' ' : '^';
    }
    console.log(`A${y}: ${a}`);
    console.log(`B${y}: ${b}`);
    console.log(` : ${marks}`);
  }
}
// find top mismatch bands
const bands = [];
for (let y = 0; y < 144; y++) if (rowHist[y]) bands.push(y);
if (bands.length) {
  const first = bands[0], last = bands[bands.length - 1];
  // dump up to 3 compact bands
  let y = bands[0];
  while (y <= 143) {
    if (!rowHist[y]) { y++; continue; }
    let y1 = y;
    while (y1 + 1 <= 143 && rowHist[y1 + 1]) y1++;
    dumpBand(y, y1);
    y = y1 + 1;
    // limit output
    if (y > 143) break;
  }
}
