// PocketGB — screenshots, GIF capture (DMG + CGB), and WebM video capture
//
// Screenshots: canvas → PNG data URL, written through IPC from the caller.
// GIF (DMG): frames arrive as Uint8Array(160*144) shade indices 0–3; encoded
//   with the display palette (4-color GIF).
// GIF (CGB): frames arrive as Uint32Array BGR555. GIF allows 256 colors per
//   palette, so we build an exact palette when the recording has ≤256 unique
//   colors (typical for GB pixel art) and median-cut quantize beyond that.
// WebM: MediaRecorder over canvas.captureStream() (+ the audio track when
//   provided) — records exactly what the effects pipeline presents.
'use strict';

class Capture {
  constructor(renderer, mainCanvas) {
    this.renderer = renderer;
    this.canvas = mainCanvas;
    this.frames = [];           // DMG: recent frames as Uint8Array(160*144) shade indices
    this.framesCgb = [];        // CGB: recent frames as Uint16Array(160*144) BGR555
    this.maxFrames = 300;       // ~5s at 60fps of rolling history
    this.recording = false;
    this.recordMode = null;     // 'dmg' | 'cgb' while recording
    this.recorded = [];         // frames captured while recording (DMG)
    this.recordedCgb = [];      // frames captured while recording (CGB)
    this.recorder = null;       // MediaRecorder while recording WebM
    this._lastCapture = 0;
    this.onStatus = null;
  }

  setOnStatus(cb) { this.onStatus = cb; }
  status(msg) { if (this.onStatus) this.onStatus(msg); }

  // Rolling history for "record last N seconds" — call once per presented frame.
  // fb is a shade-index Uint8Array (DMG) or BGR555 Uint32Array (CGB).
  observe(fb, isColor) {
    const now = performance.now();
    if (now - this._lastCapture < 16.6) return;
    this._lastCapture = now;

    if (isColor) {
      const copy = new Uint16Array(fb.length);
      for (let i = 0; i < fb.length; i++) copy[i] = fb[i] & 0x7FFF; // 555 (bit 15 unused)
      this.framesCgb.push(copy);
      if (this.framesCgb.length > this.maxFrames) this.framesCgb.shift();
      if (this.recording && this.recordMode === 'cgb') {
        this.recordedCgb.push(copy);
        if (this.recordedCgb.length % 30 === 0) {
          this.status(`recording… ${Math.round(this.recordedCgb.length / 60 * 10) / 10}s`);
        }
      }
      return;
    }

    const copy = new Uint8Array(160 * 144);
    copy.set(fb);
    this.frames.push(copy);
    if (this.frames.length > this.maxFrames) this.frames.shift();
    if (this.recording && this.recordMode === 'dmg') {
      this.recorded.push(copy);
      if (this.recorded.length % 30 === 0) {
        this.status(`recording… ${Math.round(this.recorded.length / 60 * 10) / 10}s`);
      }
    }
  }

  // PNG of the current canvas (works for both 2D and WebGL presentation).
  screenshot() {
    return this.canvas.toDataURL('image/png');
  }

  startGif() {
    this.recording = true;
    this.recordMode = this.framesCgb.length ? 'cgb' : 'dmg';
    if (this.recordMode === 'cgb') {
      this.recordedCgb = this.framesCgb.slice(-60); // include the last second
      this.recorded = [];
    } else {
      this.recorded = this.frames.slice(-60);
      this.recordedCgb = [];
    }
    this.status('recording…');
  }

  stopGif() {
    this.recording = false;
    const color = this.recordMode === 'cgb';
    const frames = color ? this.recordedCgb : this.recorded;
    this.recorded = [];
    this.recordedCgb = [];
    this.recordMode = null;
    if (!frames.length) { this.status('no frames recorded'); return; }
    this.status(`encoding gif (${color ? 'color' : '4-color'})…`);
    // give the UI a beat, then encode
    setTimeout(() => {
      const bytes = color
        ? encodeGifColor(frames, 160, 144)
        : encodeGif(frames, this.renderer.palRGB);
      const b64 = bytesToBase64(bytes);
      const name = `pocketgb-${new Date().toISOString().replace(/[:.]/g, '-')}.gif`;
      window.pocketgb.saveFile(name, b64).then((p) => {
        this.status(p ? `saved ${name}` : 'gif save failed');
      });
    }, 30);
  }

  // ---- WebM video capture ----
  // streamTracks: optional audio MediaStreamTracks to mux into the recording.
  startWebm(audioTracks) {
    if (this.recorder || typeof MediaRecorder === 'undefined') return false;
    const stream = this.canvas.captureStream(60);
    if (audioTracks) for (const t of audioTracks) if (t) stream.addTrack(t);
    let mime = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      this.recorder = null;
      const blob = new Blob(chunks, { type: 'video/webm' });
      blob.arrayBuffer().then((buf) => {
        const b64 = bytesToBase64(new Uint8Array(buf));
        const name = `pocketgb-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
        return window.pocketgb.saveFile(name, b64);
      }).then((p) => {
        this.status(p ? 'video saved' : 'webm save failed');
      }).catch((err) => this.status(`webm failed: ${err.message}`));
    };
    rec.start(250);
    this.recorder = rec;
    this.status('recording video…');
    return true;
  }

  get recordingWebm() { return !!this.recorder; }

  stopWebm() {
    if (!this.recorder) return;
    this.status('encoding webm…');
    this.recorder.stop();
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---- GIF89a encoding ----

// frames: array of Uint8Array(W*H) palette indices. palette: array of [r,g,b]
// (padded to a power of two). Works for any palette size 2–256.
function encodeGifIndexed(frames, palette, delayCs, minCodeSize) {
  const W = 160, H = 144;
  // GIF color tables are powers of two: pad with black.
  let sizePow2 = 1;
  while ((1 << sizePow2) < palette.length) sizePow2++;
  const entries = 1 << sizePow2;
  const out = [];
  const push = (...b) => out.push(...b);
  const str = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };

  str('GIF89a');
  // logical screen descriptor
  push(W & 0xFF, (W >> 8) & 0xFF, H & 0xFF, (H >> 8) & 0xFF);
  push(0x80 | (sizePow2 - 1) << 4 | (sizePow2 - 1)); // GCT present, color res, size
  push(0);          // background color index
  push(0);          // pixel aspect ratio
  // global color table
  for (let i = 0; i < entries; i++) {
    const c = palette[i] || [0, 0, 0];
    push(c[0] & 0xFF, c[1] & 0xFF, c[2] & 0xFF);
  }
  // netscape loop extension
  push(0x21, 0xFF, 0x0B); str('NETSCAPE2.0');
  push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of frames) {
    // graphic control extension
    push(0x21, 0xF9, 0x04, 0x04, delayCs & 0xFF, (delayCs >> 8) & 0xFF, 0x00, 0x00);
    // image descriptor
    push(0x2C);
    push(0, 0, 0, 0);             // left, top
    push(W & 0xFF, (W >> 8) & 0xFF, H & 0xFF, (H >> 8) & 0xFF);
    push(0x00);                   // no local color table, not interlaced
    const data = lzwEncode(frame, minCodeSize);
    push(minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      push(n);
      for (let j = 0; j < n; j++) out.push(data[i + j]);
    }
    push(0x00); // block terminator
  }
  push(0x3B); // trailer
  return new Uint8Array(out);
}

// DMG path (unchanged output format): shade-index frames + the display palette.
function encodeGif(frames, palRGB) {
  const palette = [];
  for (let i = 0; i < 4; i++) {
    const c = (palRGB && palRGB[i]) || 0xFF000000;
    palette.push([c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF]);
  }
  return encodeGifIndexed(frames, palette, 2, 3);
}

// CGB path: BGR555 frames → indexed frames + up-to-256-color palette.
function encodeGifColor(frames555, W, H) {
  const { indexed, palette } = quantize555(frames555);
  return encodeGifIndexed(indexed, palette, 2, 8);
}

// Build ≤maxColors palette from BGR555 frames and map every pixel to it.
// Exact mapping when the recording has ≤256 unique colors; median-cut
// quantization (weighted by pixel count) otherwise.
function quantize555(frames555, maxColors = 256) {
  const hist = new Map();
  for (const f of frames555) {
    for (let i = 0; i < f.length; i++) {
      const c = f[i];
      hist.set(c, (hist.get(c) || 0) + 1);
    }
  }
  let pal555;
  if (hist.size <= maxColors) {
    pal555 = [...hist.keys()];
    if (pal555.length === 0) pal555 = [0];
  } else {
    pal555 = medianCut555(hist, maxColors);
  }
  const to888 = (v) => (v << 3) | (v >> 2); // 5-bit → 8-bit
  const palette = pal555.map((c) => [
    to888(c & 31), to888((c >> 5) & 31), to888((c >> 10) & 31),
  ]);
  // map pixels: exact table first, nearest-color fallback cached per unique color
  const exact = new Map();
  pal555.forEach((c, i) => exact.set(c, i));
  const cache = new Map();
  const indexed = frames555.map((f) => {
    const out = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const c = f[i];
      let idx = exact.get(c);
      if (idx === undefined) {
        idx = cache.get(c);
        if (idx === undefined) { idx = nearest555(c, pal555); cache.set(c, idx); }
      }
      out[i] = idx;
    }
    return out;
  });
  return { indexed, palette };
}

// Weighted median cut over unique BGR555 colors (hist: Map color → pixel count).
function medianCut555(hist, maxColors) {
  const items = [...hist.entries()].map(([c, w]) => ({
    c, w, r: c & 31, g: (c >> 5) & 31, b: (c >> 10) & 31,
  }));
  const boxRange = (box) => {
    let mnR = 31, mxR = 0, mnG = 31, mxG = 0, mnB = 31, mxB = 0;
    for (const it of box) {
      if (it.r < mnR) mnR = it.r; if (it.r > mxR) mxR = it.r;
      if (it.g < mnG) mnG = it.g; if (it.g > mxG) mxG = it.g;
      if (it.b < mnB) mnB = it.b; if (it.b > mxB) mxB = it.b;
    }
    return Math.max(mxR - mnR, mxG - mnG, mxB - mnB);
  };
  let boxes = [items];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => boxRange(b) - boxRange(a));
    let split = false;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      // widest channel
      let ch = 'r', range = -1;
      for (const k of ['r', 'g', 'b']) {
        let mn = 31, mx = 0;
        for (const it of box) { if (it[k] < mn) mn = it[k]; if (it[k] > mx) mx = it[k]; }
        if (mx - mn > range) { range = mx - mn; ch = k; }
      }
      if (range <= 0) continue;
      box.sort((a, b) => a[ch] - b[ch]);
      let total = 0;
      for (const it of box) total += it.w;
      let acc = 0, idx = 0;
      for (; idx < box.length - 1; idx++) { acc += box[idx].w; if (acc >= total / 2) break; }
      boxes.splice(i, 1, box.slice(0, idx + 1), box.slice(idx + 1));
      split = true;
      break;
    }
    if (!split) break;
  }
  // palette = weighted mean of each box, clamped back into 5 bits
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0, w = 0;
    for (const it of box) { r += it.r * it.w; g += it.g * it.w; b += it.b * it.w; w += it.w; }
    const q = (v) => Math.max(0, Math.min(31, Math.round(v / w)));
    return (q(b) << 10) | (q(g) << 5) | q(r);
  });
}

function nearest555(c, pal555) {
  const r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;
  let best = 0, bd = Infinity;
  for (let i = 0; i < pal555.length; i++) {
    const p = pal555[i];
    const dr = r - (p & 31), dg = g - ((p >> 5) & 31), db = b - ((p >> 10) & 31);
    const d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// LZW for GIF: codes over a palette-index alphabet. minCodeSize 3 for the
// 4-color DMG palette, 8 for 256-color CGB. Dictionary grows to 12-bit codes.
function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const dict = new Map();

  const out = [];
  let bitBuf = 0, bitCount = 0;
  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { out.push(bitBuf & 0xFF); bitBuf >>= 8; bitCount -= 8; }
  };

  emit(clearCode);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (prefix << 8) | k; // prefix code (max ~4096) + 8-bit symbol
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emit(prefix);
      dict.set(key, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      else if (nextCode >= 4096) {
        emit(clearCode);
        dict.clear(); nextCode = eoiCode + 1; codeSize = minCodeSize + 1;
      }
      prefix = k;
    }
  }
  emit(prefix);
  emit(eoiCode);
  if (bitCount > 0) out.push(bitBuf & 0xFF);
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { Capture, encodeGif, encodeGifColor, encodeGifIndexed, quantize555, medianCut555, lzwEncode };
}
