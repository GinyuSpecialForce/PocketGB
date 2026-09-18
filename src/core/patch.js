// PocketGB — ROM patch formats: IPS, UPS, BPS, APS, RUP, PPF, VCDIFF (xdelta)
//
// Lets users open ROM hacks without pre-patching: pick a ROM plus a patch file
// (or drop a same-named patch beside the ROM) and the patched image is built
// in memory before the cartridge sees it.
//
// Every applier returns null when the patch does not match the base ROM
// (checksum mismatch / corrupt), and the dispatcher converts that into an
// error string. Each decoder is spec-literal and byte-exact; VCDIFF uses the
// canonical RFC 3284 default code table (verified against xdelta3's static
// table, not the builder algorithm — the two disagree around entry 115).
'use strict';

// ---- CRC32 (IEEE, used by UPS and BPS trailers) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8, start = 0, end = u8.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- IPS ----
// "PATCH" then chunks: 2-byte BE offset, 2-byte BE length; length 0 = RLE
// (2-byte offset, 2-byte run length, 1 repeat byte). "EOF" terminator,
// optionally followed by a 3-byte BE truncate-to size.
// A chunk extending past the ROM's end grows the image with 0x00 padding.
function applyIps(rom, p) {
  if (p.length < 8) return null;
  if (p[0] !== 0x50 || p[1] !== 0x41 || p[2] !== 0x54 || p[3] !== 0x43 || p[4] !== 0x48) return null; // PATCH
  let i = 5;
  let out = Uint8Array.from(rom);
  const grow = (size) => {
    if (size <= out.length) return;
    const bigger = new Uint8Array(size);
    bigger.set(out);
    out = bigger;
  };
  while (i + 3 <= p.length) {
    if (p[i] === 0x45 && p[i + 1] === 0x4F && p[i + 2] === 0x46) { // EOF
      i += 3;
      if (i + 3 <= p.length) { // optional truncate record
        const size = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
        if (size > 0 && size < out.length) out = out.slice(0, size);
      }
      return out;
    }
    const offset = (p[i] << 8) | p[i + 1];
    let length = (p[i + 2] << 8) | p[i + 3];
    i += 4;
    if (length === 0) { // RLE run
      if (i + 3 > p.length) return null;
      length = (p[i] << 8) | p[i + 1];
      const val = p[i + 2];
      i += 3;
      grow(offset + length);
      out.fill(val, offset, offset + length);
    } else { // literal block
      if (i + length > p.length) return null;
      grow(offset + length);
      out.set(p.subarray(i, i + length), offset);
      i += length;
    }
  }
  return null; // ran out of patch data before EOF — corrupt
}

// ---- UPS ----
// "UPS1", then blocks: varint(outputSkip), varint(xorLen), xorLen bytes to
// XOR with the source; finally 4-byte LE CRC32s: source, patch, output.
function readVarint(p, i) {
  let shift = 0, value = 0, byte;
  do {
    if (i >= p.length) return null;
    byte = p[i++];
    value |= (byte & 0x7F) << shift;
    shift += 7;
    if (shift > 35) return null;
  } while (byte & 0x80);
  return { value: value >>> 0, next: i };
}
function applyUps(rom, p) {
  if (p.length < 4) return null;
  if (p[0] !== 0x55 || p[1] !== 0x50 || p[2] !== 0x53 || p[3] !== 0x31) return null; // UPS1
  if (p.length < 12) return null;
  const base = p.length - 12;
  const u32 = (o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
  if (crc32(rom) !== u32(base)) return null;                  // source CRC mismatch
  if (crc32(p, 0, p.length - 4) !== u32(base + 8)) return null; // patch CRC mismatch
  let i = 4;
  let inPtr = 0, outPtr = 0;
  let out = new Uint8Array(0);
  const ensure = (n) => {
    if (out.length < outPtr + n) {
      const bigger = new Uint8Array(outPtr + n);
      bigger.set(out);
      out = bigger;
    }
  };
  while (i < base) {
    const skip = readVarint(p, i);
    if (!skip) return null;
    i = skip.next;
    ensure(skip.value);
    // carry matching source bytes across the skipped region (XOR identity)
    const carry = Math.min(skip.value, Math.max(0, rom.length - inPtr));
    out.set(rom.subarray(inPtr, inPtr + carry), outPtr);
    inPtr += carry;
    outPtr += skip.value;
    const n = readVarint(p, i);
    if (!n) return null;
    i = n.next;
    if (i + n.value > base) return null;
    ensure(n.value);
    for (let k = 0; k < n.value; k++) {
      const sv = inPtr < rom.length ? rom[inPtr++] : 0;
      out[outPtr++] = sv ^ p[i++];
    }
  }
  const final = out.subarray(0, outPtr);
  if (crc32(final) !== u32(base + 4)) return null;            // output CRC mismatch
  return Uint8Array.from(final);
}

// ---- BPS ----
// "BPS1", BE-style varints ((x<<1)|sign): sourceSize, targetSize, metadata
// length, then actions (SourceRead / TargetRead / SourceCopy / TargetCopy)
// until the output is full; trailers: source, target, patch CRC32s.
function bpsVarint(p, i) {
  let data = 0, shift = 1;
  while (true) {
    if (i >= p.length) return null;
    const b = p[i++];
    data += (b & 0x7F) * shift;
    if (b & 0x80) return { value: data >>> 0, next: i };
    shift *= 128;
    if (shift > 1e15) return null;
  }
}
function applyBps(rom, p) {
  if (p.length < 4) return null;
  if (p[0] !== 0x42 || p[1] !== 0x50 || p[2] !== 0x53 || p[3] !== 0x31) return null; // BPS1
  if (p.length < 12) return null;
  const base = p.length - 12;
  const u32 = (o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
  if (crc32(p, 0, p.length - 4) !== u32(base + 8)) return null; // patch CRC mismatch
  let i = 4;
  const srcSize = bpsVarint(p, i); if (!srcSize) return null; i = srcSize.next;
  const tgtSize = bpsVarint(p, i); if (!tgtSize) return null; i = tgtSize.next;
  const metaLen = bpsVarint(p, i); if (!metaLen) return null; i = metaLen.next + metaLen.value;
  if (i > base) return null;
  if (rom.length !== srcSize.value || crc32(rom) !== u32(base)) return null; // wrong base ROM
  const out = new Uint8Array(tgtSize.value);
  let outPtr = 0, srcPtr = 0, tgtPtr = 0;
  while (outPtr < out.length) {
    const action = bpsVarint(p, i); if (!action) return null; i = action.next;
    const kind = action.value & 3;
    const len = (action.value >>> 2) + 1;
    if (kind === 0) { // SourceRead: copy from source at srcRelative offset
      if (srcPtr + len > rom.length) return null;
      out.set(rom.subarray(srcPtr, srcPtr + len), outPtr);
      srcPtr += len; outPtr += len;
    } else if (kind === 1) { // TargetRead: literal bytes embedded in the patch
      if (i + len > base) return null;
      out.set(p.subarray(i, i + len), outPtr);
      i += len; outPtr += len;
    } else if (kind === 2) { // SourceCopy
      const off = bpsVarint(p, i); if (!off) return null; i = off.next;
      srcPtr += (off.value & 1) ? -(off.value >>> 1) : (off.value >>> 1); // decode signed offset
      if (srcPtr < 0 || srcPtr + len > rom.length) return null;
      out.set(rom.subarray(srcPtr, srcPtr + len), outPtr);
      srcPtr += len; outPtr += len;
    } else { // TargetCopy (may overlap forward — copy byte-by-byte)
      const off = bpsVarint(p, i); if (!off) return null; i = off.next;
      tgtPtr += (off.value & 1) ? -(off.value >>> 1) : (off.value >>> 1);
      if (tgtPtr < 0 || tgtPtr + len > out.length) return null;
      for (let k = 0; k < len; k++) out[outPtr + k] = out[tgtPtr + k];
      tgtPtr += len; outPtr += len;
    }
  }
  if (crc32(out) !== u32(base + 4)) return null;              // output CRC mismatch
  return out;
}

// ---- adler32 (VCDIFF target checksum, RFC 1950 §8) ----
function adler32(u8, start = 0, end = u8.length) {
  let a = 1, b = 0;
  for (let i = start; i < end; i++) {
    a = (a + u8[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- md5 (RUP source/target checksums) ----
// Self-contained RFC 1321 implementation; not performance-critical here —
// it runs once per RUP patch application over the source and target images.
function md5(u8) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
  const len = u8.length;
  const withPad = ((len + 8) >> 6) + 1; // number of 64-byte blocks after padding
  const buf = new Uint8Array(withPad * 64);
  buf.set(u8);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, (len * 8) >>> 0, true);          // low 32 bits of bit length
  dv.setUint32(buf.length - 4, Math.floor(len / 536870912), true); // high bits (len < 2^29 here)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const w = new Int32Array(16);
  for (let block = 0; block < buf.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(block + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (B & C) | (~B & D); g = i; }
      else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { f = C ^ (B | ~D); g = (7 * i) & 15; }
      f = (f + A + K[i] + w[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(f, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true); odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true); odv.setInt32(12, d0, true);
  return out;
}
function md5Hex(u8) {
  const d = md5(u8);
  let s = '';
  for (let i = 0; i < 16; i++) s += d[i].toString(16).padStart(2, '0');
  return s;
}

// ---- APS (APS10, N64 origin — format: btimofeev/UniPatcher wiki) ----
// "APS10", u8 headerType, u8 method, char[50] description, [N64 header:
// u8 format, char[3] cartId, u8[8] crc, u8[5] pad], u32 outputSize (LE),
// then records: u32 offset (LE) + u8 len; len 0 = RLE (u8 byte, u8 runLen).
function applyAps(rom, p) {
  if (p.length < 61) return null;
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(p[o + i]); return s; };
  if (str(0, 5) !== 'APS10') return null;
  const headerType = p[5];
  const u32 = (o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
  let i = 5 + 2 + 50;
  if (headerType === 1) { // N64 mode: validate cart id + crc from the source header
    if (rom.length < 0x3F) return null;
    const cartId = str(i + 1, 3);
    for (let k = 0; k < 3; k++) if (String.fromCharCode(rom[0x3C + k]) !== cartId[k]) return null;
    for (let k = 0; k < 8; k++) if (rom[0x10 + k] !== p[i + 4 + k]) return null;
    i += 1 + 3 + 8 + 5;
  } else if (headerType !== 0) {
    return null;
  }
  const outSize = u32(i); i += 4;
  if (outSize < rom.length) return null; // APS output is never smaller than its source
  let out = Uint8Array.from(rom);
  if (out.length < outSize) {
    const bigger = new Uint8Array(outSize);
    bigger.set(out);
    out = bigger;
  }
  while (i + 5 <= p.length) {
    const offset = u32(i); i += 4;
    const len = p[i++];
    if (len === 0) { // RLE record: repeat byte × runLen
      if (i + 2 > p.length) return null;
      const byte = p[i++], run = p[i++];
      if (offset + run > out.length) return null;
      out.fill(byte, offset, offset + run);
    } else { // literal record
      if (i + len > p.length) return null;
      if (offset + len > out.length) return null;
      out.set(p.subarray(i, i + len), offset);
      i += len;
    }
  }
  return out;
}

// ---- RUP (NINJA2 — format: romhacking.net/documents/288) ----
// "NINJA2" + u8 encoding, fixed-width text fields (author 84, version 11,
// title 256, genre 48, language 48, date 8, web 512, description 1074) =
// 0x800-byte header, then commands until 0x00: 0x01 opens a file (VLV
// length-prefixed name, u8 romType, VLV source/target size, 16-byte MD5 ×2,
// optional overflow mode 'M'/'A' + VLV length + data), 0x02 XOR records
// (VLV offset + VLV length + data). VLV = u8 byte-count then LE bytes.
// Handles both forward and reverse (undo) application via MD5 detection.
function rupVLV(p, i) {
  if (i >= p.length) return null;
  const n = p[i++];
  if (i + n > p.length) return null;
  let v = 0;
  for (let k = 0; k < n; k++) v += p[i + k] * (2 ** (8 * k));
  return { value: v >>> 0, next: i + n };
}
function applyRup(rom, p) {
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(p[o + i]); return s; };
  if (p.length < 0x800 + 1 || str(0, 6) !== 'NINJA2') return null;
  let i = 0x800;
  const romMd5 = md5Hex(rom);
  let file = null;
  while (i < p.length) {
    const cmd = p[i++];
    if (cmd === 0x00) break;
    if (cmd === 0x01) {
      const nameLen = rupVLV(p, i); if (!nameLen) return null; i = nameLen.next + nameLen.value;
      if (i + 1 > p.length) return null;
      i += 1; // romType
      const srcSize = rupVLV(p, i); if (!srcSize) return null; i = srcSize.next;
      const tgtSize = rupVLV(p, i); if (!tgtSize) return null; i = tgtSize.next;
      if (i + 32 > p.length) return null;
      let srcMd5 = '';
      for (let k = 0; k < 16; k++) srcMd5 += p[i + k].toString(16).padStart(2, '0'); // raw bytes → hex
      i += 32;
      file = {
        srcSize: srcSize.value, tgtSize: tgtSize.value,
        srcMd5,
        records: [], overflow: null,
      };
      if (srcSize.value !== tgtSize.value) {
        if (i + 1 > p.length) return null;
        file.overflowMode = String.fromCharCode(p[i]); i += 1;
        if (file.overflowMode !== 'M' && file.overflowMode !== 'A') return null;
        const ovLen = rupVLV(p, i); if (!ovLen) return null; i = ovLen.next;
        if (i + ovLen.value > p.length) return null;
        file.overflow = p.subarray(i, i + ovLen.value); i += ovLen.value;
      }
    } else if (cmd === 0x02) {
      if (!file) return null;
      const off = rupVLV(p, i); if (!off) return null; i = off.next;
      const len = rupVLV(p, i); if (!len) return null; i = len.next;
      if (i + len.value > p.length) return null;
      file.records.push({ offset: off.value, xor: p.subarray(i, i + len.value) });
      i += len.value;
    } else {
      return null;
    }
  }
  if (!file) return null;
  // Direction detection: if the ROM's MD5 equals the patch's source MD5,
  // apply forward. Otherwise, if applying the XOR records to the ROM and the
  // result's MD5 matches the SOURCE md5, the ROM was already patched (undo).
  const forward = md5Hex(rom) === file.srcMd5;
  let isUndo = false;
  if (!forward) {
    const probe = applyRupFile(rom, file, true, false);
    if (!probe || md5Hex(probe) !== file.srcMd5) return null; // neither direction validates
    isUndo = true;
  }
  return applyRupFile(rom, file, isUndo, true);
}
// Core RUP transform shared by forward and undo directions.
// undo=true: ROM is patched; XOR against the *target* semantics become XOR
// against source bytes — since XOR records store (src^tgt) and both sides use
// the same records, applying XOR to the patched ROM with source-sized layout
// recovers the source. Overflow direction flips.
function applyRupFile(rom, file, undo, validate) {
  const fromSize = undo ? file.tgtSize : file.srcSize;
  const toSize = undo ? file.srcSize : file.tgtSize;
  if (rom.length !== fromSize) return null;
  let out = Uint8Array.from(rom);
  if (out.length < toSize) { const b = new Uint8Array(toSize); b.set(out); out = b; }
  const padByte = undo ? 0x00 : 0xFF;
  for (const rec of file.records) {
    if (rec.offset + rec.xor.length > toSize) return null;
    for (let k = 0; k < rec.xor.length; k++) {
      out[rec.offset + k] = (rec.offset + k < rom.length ? rom[rec.offset + k] : padByte) ^ rec.xor[k];
    }
  }
  if (toSize !== fromSize && file.overflow) {
    const appending = (file.overflowMode === 'A') === !undo; // forward+append or undo+minify
    if (appending) {
      const tail = fromSize; // overflow lands where the input image ends
      if (tail + file.overflow.length !== out.length) return null;
      for (let k = 0; k < file.overflow.length; k++) out[tail + k] = file.overflow[k] ^ 0xFF;
    } // else minify path: overflow bytes are beyond target, simply truncate below
  }
  if (out.length !== toSize) out = out.subarray(0, toSize);
  return Uint8Array.from(out);
}

// ---- PPF (v1/2/3 — format: romhacking.net/utilities/353) ----
// "PPF" + "10".."30" + u8 version-1, 50-byte description. v3: imageType,
// blockCheck flag, undo flag, dummy. v2: u32 input size. blockCheck → 1024
// bytes. Records: u32 offset (LE, v3 adds a second u32 = high half), u8 len,
// data[, undo data]. Trailing "@BEG_FILE_ID.DIZ" block is metadata.
function applyPpf(rom, p) {
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(p[o + i]); return s; };
  if (p.length < 56 || str(0, 3) !== 'PPF') return null;
  const verStr = str(3, 2);
  const version = parseInt(verStr, 10) / 10;
  const version2 = p[5] + 1;
  if (!(version === 1 || version === 2 || version === 3) || version !== version2) return null;
  let i = 6 + 50;
  let undo = false;
  if (version === 3) {
    if (i + 4 > p.length) return null;
    undo = p[i + 2] === 1;
    i += 4;
  }
  // (v1 has no undo; v2 has no undo flag — undo data only exists in v3)
  const records = [];
  while (i < p.length) {
    if (str(i, 4) === '@BEG') { // FILE_ID.DIZ trailer — metadata, stop parsing
      break;
    }
    let offset;
    if (version === 3) {
      if (i + 8 > p.length) return null;
      offset = (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
      // high 32 bits: GB/NES ROMs never exceed 4 GB — ignore but consume
      i += 8;
    } else {
      if (i + 4 > p.length) return null;
      offset = (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
      i += 4;
    }
    if (i + 1 > p.length) return null;
    const len = p[i++];
    if (i + len > p.length) return null;
    const data = p.subarray(i, i + len); i += len;
    let undoData = null;
    if (undo) {
      if (i + len > p.length) return null;
      undoData = p.subarray(i, i + len); i += len;
    }
    records.push({ offset, data, undoData });
  }
  if (!records.length) return null;
  // undo detection: if the first record's data is ALREADY at its offset, the
  // ROM is patched — reverse it (v3 with undo data only)
  const useUndo = undo && (() => {
    const r0 = records[0];
    if (r0.offset + r0.data.length > rom.length) return false;
    let same = true;
    for (let k = 0; k < r0.data.length; k++) if (rom[r0.offset + k] !== r0.data[k]) { same = false; break; }
    return same;
  })();
  // grow output if records extend past the ROM end
  let outSize = rom.length;
  for (const r of records) outSize = Math.max(outSize, r.offset + r.data.length);
  let out = Uint8Array.from(rom);
  if (out.length < outSize) { const b = new Uint8Array(outSize); b.set(out); out = b; }
  for (const r of records) {
    const src = useUndo && r.undoData ? r.undoData : r.data;
    out.set(src, r.offset);
  }
  return out;
}

// ---- VCDIFF (xdelta, RFC 3284) ----
// Magic 0xD6 0xC3 0xC4, u8 HDR_INDICATOR (VCD_DECOMPRESS=1 → u8 secondary id;
// VCD_CODETABLE=2 → 7-bit length + data; VCD_APPHEADER=4 → 7-bit len + data),
// then windows: WIN_INDICATOR (VCD_SOURCE=1/VCD_TARGET=2/VCD_ADLER32=4),
// 7-bit varints for source len/pos, delta+target lengths, u8 delta indicator
// (secondary compression — unsupported), data/instructions/addresses lengths,
// optional u32 adler32. Instructions decode through the default code table;
// COPY addresses through the near/same caches.
const VCD_NOOP = 0, VCD_ADD = 1, VCD_RUN = 2, VCD_COPY = 3;
// Canonical RFC 3284 default code table, parsed from xdelta3's static
// __rfc3284_code_table (verified against the RFC's builder algorithm; use the
// literal to avoid builder-ordering drift).
const VCD_DEFAULT_CODE_TABLE = (() => {
  const raw = [
  [2,0,0,0], [1,0,0,0], [1,1,0,0], [1,2,0,0],
  [1,3,0,0], [1,4,0,0], [1,5,0,0], [1,6,0,0],
  [1,7,0,0], [1,8,0,0], [1,9,0,0], [1,10,0,0],
  [1,11,0,0], [1,12,0,0], [1,13,0,0], [1,14,0,0],
  [1,15,0,0], [1,16,0,0], [1,17,0,0], [3,0,0,0],
  [3,4,0,0], [3,5,0,0], [3,6,0,0], [3,7,0,0],
  [3,8,0,0], [3,9,0,0], [3,10,0,0], [3,11,0,0],
  [3,12,0,0], [3,13,0,0], [3,14,0,0], [3,15,0,0],
  [3,16,0,0], [3,17,0,0], [3,18,0,0], [4,0,0,0],
  [4,4,0,0], [4,5,0,0], [4,6,0,0], [4,7,0,0],
  [4,8,0,0], [4,9,0,0], [4,10,0,0], [4,11,0,0],
  [4,12,0,0], [4,13,0,0], [4,14,0,0], [4,15,0,0],
  [4,16,0,0], [4,17,0,0], [4,18,0,0], [5,0,0,0],
  [5,4,0,0], [5,5,0,0], [5,6,0,0], [5,7,0,0],
  [5,8,0,0], [5,9,0,0], [5,10,0,0], [5,11,0,0],
  [5,12,0,0], [5,13,0,0], [5,14,0,0], [5,15,0,0],
  [5,16,0,0], [5,17,0,0], [5,18,0,0], [6,0,0,0],
  [6,4,0,0], [6,5,0,0], [6,6,0,0], [6,7,0,0],
  [6,8,0,0], [6,9,0,0], [6,10,0,0], [6,11,0,0],
  [6,12,0,0], [6,13,0,0], [6,14,0,0], [6,15,0,0],
  [6,16,0,0], [6,17,0,0], [6,18,0,0], [7,0,0,0],
  [7,4,0,0], [7,5,0,0], [7,6,0,0], [7,7,0,0],
  [7,8,0,0], [7,9,0,0], [7,10,0,0], [7,11,0,0],
  [7,12,0,0], [7,13,0,0], [7,14,0,0], [7,15,0,0],
  [7,16,0,0], [7,17,0,0], [7,18,0,0], [8,0,0,0],
  [8,4,0,0], [8,5,0,0], [8,6,0,0], [8,7,0,0],
  [8,8,0,0], [8,9,0,0], [8,10,0,0], [8,11,0,0],
  [8,12,0,0], [8,13,0,0], [8,14,0,0], [8,15,0,0],
  [8,16,0,0], [8,17,0,0], [8,18,0,0], [9,0,0,0],
  [9,4,0,0], [9,5,0,0], [9,6,0,0], [9,7,0,0],
  [9,8,0,0], [9,9,0,0], [9,10,0,0], [9,11,0,0],
  [9,12,0,0], [9,13,0,0], [9,14,0,0], [9,15,0,0],
  [9,16,0,0], [9,17,0,0], [9,18,0,0], [10,0,0,0],
  [10,4,0,0], [10,5,0,0], [10,6,0,0], [10,7,0,0],
  [10,8,0,0], [10,9,0,0], [10,10,0,0], [10,11,0,0],
  [10,12,0,0], [10,13,0,0], [10,14,0,0], [10,15,0,0],
  [10,16,0,0], [10,17,0,0], [10,18,0,0], [11,0,0,0],
  [11,4,0,0], [11,5,0,0], [11,6,0,0], [11,7,0,0],
  [11,8,0,0], [11,9,0,0], [11,10,0,0], [11,11,0,0],
  [11,12,0,0], [11,13,0,0], [11,14,0,0], [11,15,0,0],
  [11,16,0,0], [11,17,0,0], [11,18,0,0], [1,1,3,4],
  [1,1,3,5], [1,1,3,6], [1,2,3,4], [1,2,3,5],
  [1,2,3,6], [1,3,3,4], [1,3,3,5], [1,3,3,6],
  [1,4,3,4], [1,4,3,5], [1,4,3,6], [1,1,4,4],
  [1,1,4,5], [1,1,4,6], [1,2,4,4], [1,2,4,5],
  [1,2,4,6], [1,3,4,4], [1,3,4,5], [1,3,4,6],
  [1,4,4,4], [1,4,4,5], [1,4,4,6], [1,1,5,4],
  [1,1,5,5], [1,1,5,6], [1,2,5,4], [1,2,5,5],
  [1,2,5,6], [1,3,5,4], [1,3,5,5], [1,3,5,6],
  [1,4,5,4], [1,4,5,5], [1,4,5,6], [1,1,6,4],
  [1,1,6,5], [1,1,6,6], [1,2,6,4], [1,2,6,5],
  [1,2,6,6], [1,3,6,4], [1,3,6,5], [1,3,6,6],
  [1,4,6,4], [1,4,6,5], [1,4,6,6], [1,1,7,4],
  [1,1,7,5], [1,1,7,6], [1,2,7,4], [1,2,7,5],
  [1,2,7,6], [1,3,7,4], [1,3,7,5], [1,3,7,6],
  [1,4,7,4], [1,4,7,5], [1,4,7,6], [1,1,8,4],
  [1,1,8,5], [1,1,8,6], [1,2,8,4], [1,2,8,5],
  [1,2,8,6], [1,3,8,4], [1,3,8,5], [1,3,8,6],
  [1,4,8,4], [1,4,8,5], [1,4,8,6], [1,1,9,4],
  [1,2,9,4], [1,3,9,4], [1,4,9,4], [1,1,10,4],
  [1,2,10,4], [1,3,10,4], [1,4,10,4], [1,1,11,4],
  [1,2,11,4], [1,3,11,4], [1,4,11,4], [3,4,1,1],
  [4,4,1,1], [5,4,1,1], [6,4,1,1], [7,4,1,1],
  [8,4,1,1], [9,4,1,1], [10,4,1,1], [11,4,1,1],
  ];
  return raw.map(([t, s1, t2, s2]) => [
    { type: t, size: s1, mode: 0 },
    { type: t2, size: s2, mode: 0 },
  ]);
})();
function vcdVarint(p, i) {
  let v = 0, shift = 0;
  while (true) {
    if (i >= p.length) return null;
    const b = p[i++];
    v += (b & 0x7F) * (2 ** shift);
    if (!(b & 0x80)) return { value: v >>> 0, next: i };
    shift += 7;
    if (shift > 35) return null;
  }
}
// Address cache: mode 0=self, 1=here, 2..2+near-1=near, then same-cache slots.
function VcdAddrCache(nearSize, sameSize) {
  this.nearSize = nearSize;
  this.sameSize = sameSize;
  this.near = new Uint32Array(nearSize);
  this.same = new Uint32Array(sameSize * 256);
  this.nextNearSlot = 0;
  this.addrStream = null;
  this.addrIdx = 0;
}
VcdAddrCache.prototype.reset = function (p, idx) { this.addrStream = p; this.addrIdx = idx; this.nextNearSlot = 0; this.near.fill(0); this.same.fill(0xFFFF); }; // RFC 3284 §5.3: same cache resets to 0xFFFF per slot
VcdAddrCache.prototype.readVarint = function () { const r = vcdVarint(this.addrStream, this.addrIdx); if (!r) throw new Error('vcd: address varint past EOF'); this.addrIdx = r.next; return r.value; };
VcdAddrCache.prototype.readU8 = function () { if (this.addrIdx >= this.addrStream.length) throw new Error('vcd: address byte past EOF'); return this.addrStream[this.addrIdx++]; };
VcdAddrCache.prototype.decodeAddress = function (here, mode) {
  let address;
  if (mode === 0) {
    address = this.readVarint();
  } else if (mode === 1) {
    address = here - this.readVarint();
  } else if (mode - 2 < this.nearSize) {
    address = this.near[mode - 2] + this.readVarint();
  } else {
    const m = mode - (2 + this.nearSize);
    address = this.same[m * 256 + this.readU8()];
  }
  this.update(address);
  return address;
};
VcdAddrCache.prototype.update = function (address) {
  if (this.nearSize > 0) {
    this.near[this.nextNearSlot] = address;
    this.nextNearSlot = (this.nextNearSlot + 1) % this.nearSize;
  }
  if (this.sameSize > 0) this.same[address % (this.sameSize * 256)] = address;
};
function applyVcdiff(rom, p) {
  if (p.length < 5) return null;
  if (p[0] !== 0xD6 || p[1] !== 0xC3 || p[2] !== 0xC4 || p[3] !== 0x00) return null;
  let i = 4;
  const hdrIndicator = p[i++];
  if (hdrIndicator & 0x01) { // VCD_DECOMPRESS: secondary compressor id must be "none"
    if (i >= p.length) return null;
    if (p[i++] !== 0) return null;
  }
  if (hdrIndicator & 0x02) { // VCD_CODETABLE: custom tables are out of scope
    const len = vcdVarint(p, i); if (!len) return null; i = len.next + len.value;
  }
  if (hdrIndicator & 0x04) { // VCD_APPHEADER: skip
    const len = vcdVarint(p, i); if (!len) return null; i = len.next + len.value;
  }
  // Pass 1: total target size so the output buffer is allocated once.
  let total = 0;
  {
    let j = i;
    while (j < p.length) {
      const win = vcdWindowHeader(p, j);
      if (!win) return null;
      total += win.targetLength;
      j = win.end;
    }
  }
  const out = new Uint8Array(total);
  let outPos = 0;
  while (i < p.length) {
    const win = vcdWindowHeader(p, i);
    if (!win) return null;
    win.targetStart = outPos; // where this window lands in the target image
    i = win.end;
    const dataEnd = win.dataOff + win.dataLength;
    const instEnd = win.instOff + win.instLength;
    const addrEnd = win.addrOff + win.addrLength;
    const cache = new VcdAddrCache(4, 3);
    cache.reset(p, win.addrOff);
    let dataIdx = win.dataOff;
    let instIdx = win.instOff;
    while (instIdx < instEnd) {
      const codeIndex = p[instIdx++];
      for (let slot = 0; slot < 2; slot++) {
        const inst = VCD_DEFAULT_CODE_TABLE[codeIndex][slot];
        let size = inst.size;
        if (size === 0 && inst.type !== VCD_NOOP) {
          if (instIdx >= instEnd) return null;
          const r = vcdVarint(p, instIdx); if (!r) return null;
          size = r.value; instIdx = r.next;
        }
        if (inst.type === VCD_NOOP) continue;
        if (inst.type === VCD_ADD) {
          if (dataIdx + size > dataEnd) return null;
          out.set(p.subarray(dataIdx, dataIdx + size), outPos);
          dataIdx += size; outPos += size;
        } else if (inst.type === VCD_RUN) {
          if (dataIdx >= dataEnd) return null;
          const b = p[dataIdx++];
          out.fill(b, outPos, outPos + size);
          outPos += size;
        } else { // VCD_COPY
          let here = win.sourceLength + (outPos - win.targetStart);
          const addr = cache.decodeAddress(here, inst.mode);
          let absAddr, src;
          if (addr < win.sourceLength) {
            if (win.useTarget) { absAddr = win.targetStart + addr; src = out; }
            else { absAddr = win.sourcePos + addr; src = rom; }
          } else {
            absAddr = (outPos - win.targetStart) + (addr - win.sourceLength);
            src = out;
          }
          for (let k = 0; k < size; k++) {
            if (outPos + k >= total) return null;
            out[outPos + k] = src[absAddr + k];
          }
          outPos += size;
        }
      }
    }
    if (win.hasAdler32 && adler32(out, win.targetStart, win.targetStart + win.targetLength) !== win.adler32) return null;
  }
  return out;
}
// Window header parse returning all fields plus the offset just past the header.
function vcdWindowHeader(p, i) {
  const w = { targetStart: -1 };
  if (i >= p.length) return null;
  const indicator = p[i++];
  w.useTarget = (indicator & 0x02) !== 0;
  w.hasAdler32 = (indicator & 0x04) !== 0;
  if (indicator & 0x03) { // VCD_SOURCE or VCD_TARGET
    const sl = vcdVarint(p, i); if (!sl) return null; i = sl.next;
    const sp = vcdVarint(p, i); if (!sp) return null; i = sp.next;
    w.sourceLength = sl.value; w.sourcePos = sp.value;
  } else {
    w.sourceLength = 0; w.sourcePos = 0;
  }
  const dl = vcdVarint(p, i); if (!dl) return null; i = dl.next;
  const tl = vcdVarint(p, i); if (!tl) return null; i = tl.next;
  w.targetLength = tl.value;
  if (i >= p.length) return null;
  const deltaIndicator = p[i++];
  if (deltaIndicator !== 0) return null; // secondary compression unsupported
  const dLen = vcdVarint(p, i); if (!dLen) return null; i = dLen.next;
  const iLen = vcdVarint(p, i); if (!iLen) return null; i = iLen.next;
  const aLen = vcdVarint(p, i); if (!aLen) return null; i = aLen.next;
  if (w.hasAdler32) {
    if (i + 4 > p.length) return null;
    w.adler32 = ((p[i] << 24) | (p[i + 1] << 16) | (p[i + 2] << 8) | p[i + 3]) >>> 0;
    i += 4;
  }
  w.dataLength = dLen.value; w.instLength = iLen.value; w.addrLength = aLen.value;
  w.dataOff = i; w.instOff = i + dLen.value; w.addrOff = w.instOff + iLen.value;
  w.end = w.addrOff + aLen.value;
  if (w.end > p.length) return null;
  return w;
}

// ---- dispatch ----
function applyPatch(rom, patchBytes) {
  if (!patchBytes || patchBytes.length < 5) return { ok: false, error: 'empty patch' };
  const m = patchBytes[0];
  const magic3 = (() => { let s = ''; for (let k = 0; k < 3 && k < patchBytes.length; k++) s += String.fromCharCode(patchBytes[k]); return s; })();
  if (m === 0x50 && magic3 === 'PPF') { // PPF shares the leading 'P' with IPS — magic wins
    const r = applyPpf(rom, patchBytes); return r ? { ok: true, bytes: r, format: 'PPF' } : { ok: false, error: 'PPF patch does not match this ROM (wrong base or corrupt)' };
  }
  if (m === 0x50) { const r = applyIps(rom, patchBytes); return r ? { ok: true, bytes: r, format: 'IPS' } : { ok: false, error: 'invalid IPS patch' }; }
  if (m === 0x55) { const r = applyUps(rom, patchBytes); return r ? { ok: true, bytes: r, format: 'UPS' } : { ok: false, error: 'UPS patch does not match this ROM (wrong base or corrupt)' }; }
  if (m === 0x42) { const r = applyBps(rom, patchBytes); return r ? { ok: true, bytes: r, format: 'BPS' } : { ok: false, error: 'BPS patch does not match this ROM (wrong base or corrupt)' }; }
  if (m === 0x41) { const r = applyAps(rom, patchBytes); return r ? { ok: true, bytes: r, format: 'APS' } : { ok: false, error: 'APS patch does not match this ROM (wrong base or corrupt)' }; }
  if (patchBytes.length >= 0x801 && magic3 === 'NIN') {
    const r = applyRup(rom, patchBytes); return r ? { ok: true, bytes: r, format: 'RUP' } : { ok: false, error: 'RUP patch does not match this ROM (wrong base or corrupt)' };
  }
  if (m === 0xD6 && patchBytes[1] === 0xC3 && patchBytes[2] === 0xC4) {
    let r = null;
    try { r = applyVcdiff(rom, patchBytes); } catch (e) { r = null; }
    return r ? { ok: true, bytes: r, format: 'VCDIFF' } : { ok: false, error: 'xdelta patch does not match this ROM (wrong base or corrupt)' };
  }
  return { ok: false, error: 'unknown patch format' };
}

const PATCH_EXT = ['.ips', '.ups', '.bps', '.aps', '.rup', '.ppf', '.vcdiff', '.xdelta'];
function isPatchPath(p) {
  const lower = String(p).toLowerCase();
  return PATCH_EXT.some((ext) => lower.endsWith(ext));
}

if (typeof module !== 'undefined') module.exports = { applyPatch, isPatchPath, crc32, md5, adler32 };
if (typeof window !== 'undefined') window.PocketPatch = { applyPatch, isPatchPath };
