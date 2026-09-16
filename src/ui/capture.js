// PocketGB — screenshots and GIF capture
// Screenshot: canvas → PNG via Electron's nativeImage in main (simpler: toDataURL
// here and write through IPC as a data URL is avoided; we send raw bytes).
// GIF: encoder for an animated GIF from 160x144 indexed frames (palette = current
// display palette), written through the state-file IPC path.
'use strict';

class Capture {
  constructor(renderer, mainCanvas) {
    this.renderer = renderer;
    this.canvas = mainCanvas;
    this.frames = [];           // recent frames as Uint8Array(160*144) shade indices
    this.maxFrames = 300;       // ~5s at 60fps of rolling history
    this.recording = false;
    this.recorded = [];         // frames captured while recording
    this._lastCapture = 0;
    this.onStatus = null;
  }

  setOnStatus(cb) { this.onStatus = cb; }
  status(msg) { if (this.onStatus) this.onStatus(msg); }

  // Rolling history for "record last N seconds" — call once per presented frame.
  observe(fb) {
    const now = performance.now();
    if (now - this._lastCapture < 16.6) return;
    this._lastCapture = now;
    const copy = new Uint8Array(160 * 144);
    copy.set(fb);
    this.frames.push(copy);
    if (this.frames.length > this.maxFrames) this.frames.shift();
    if (this.recording) {
      this.recorded.push(copy);
      if (this.recorded.length % 30 === 0) this.status(`recording… ${Math.round(this.recorded.length / 60 * 10) / 10}s`);
    }
  }

  // PNG of the current canvas via toDataURL (Electron supports a.download through
  // main process; here we write through the settings IPC as base64 → file).
  screenshot() {
    const dataUrl = this.canvas.toDataURL('image/png');
    return dataUrl;
  }

  startGif() {
    this.recording = true;
    this.recorded = this.frames.slice(-60); // include the last second
    this.status('recording…');
  }

  stopGif() {
    this.recording = false;
    const frames = this.recorded;
    this.recorded = [];
    this.status('encoding gif…');
    // give the UI a beat, then encode
    setTimeout(() => {
      const bytes = encodeGif(frames, this.renderer.palRGB);
      const b64 = bytesToBase64(bytes);
      const name = `pocketgb-${new Date().toISOString().replace(/[:.]/g, '-')}.gif`;
      window.pocketgb.saveFile(name, b64).then((p) => {
        this.status(p ? `saved ${name}` : 'gif save failed');
      });
    }, 30);
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

// ---- minimal GIF89a encoder for 160x144 frames with a fixed 4-color palette ----
// Frames are Uint8Array(160*144) of shade indices 0-3. Uses LZW with 3-bit codes.
function encodeGif(frames, palRGB) {
  const W = 160, H = 144;
  const out = [];
  const push = (...b) => out.push(...b);
  const str = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };

  str('GIF89a');
  // logical screen descriptor
  push(W & 0xFF, (W >> 8) & 0xFF, H & 0xFF, (H >> 8) & 0xFF);
  push(0xF1);       // GCT present (0x80) + color res 7 (0x70) + size=1 → 2^(1+1) = 4 entries
  push(0);          // background color index
  push(0);          // pixel aspect ratio
  // global color table: exactly 4 entries (must match the size field above)
  for (let i = 0; i < 4; i++) {
    const c = palRGB[i] || 0xFF000000;
    push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF);
  }
  // netscape loop extension
  push(0x21, 0xFF, 0x0B); str('NETSCAPE2.0');
  push(0x03, 0x01, 0x00, 0x00, 0x00);

  const delayCs = 2; // 20ms per frame
  for (const frame of frames) {
    // graphic control extension
    push(0x21, 0xF9, 0x04, 0x04, delayCs & 0xFF, (delayCs >> 8) & 0xFF, 0x00, 0x00);
    // image descriptor
    push(0x2C);
    push(0, 0, 0, 0);             // left, top
    push(W & 0xFF, (W >> 8) & 0xFF, H & 0xFF, (H >> 8) & 0xFF);
    push(0x00);                   // no local color table, not interlaced
    // LZW-compressed image data, min code size 3 (4-color palette needs 3 bits)
    const minCode = 3;
    const data = lzwEncode(frame, minCode);
    push(minCode);
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

// LZW for GIF: codes over a 4-symbol alphabet, min code size 3.
function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;       // 8
  const eoiCode = clearCode + 1;            // 9
  let codeSize = minCodeSize + 1;           // 4
  let nextCode = eoiCode + 1;               // 10
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

if (typeof module !== 'undefined') module.exports = { Capture, encodeGif };
