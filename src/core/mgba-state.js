// PocketGB — mGBA save-state codec (GBA cheat-finder plumbing).
//
// The vendored mGBA wasm build exposes no memory peek/poke (no busRead8), so
// the cheat finder cannot scan GBA RAM live. It CAN, however, scan save
// states: mGBA's GBA state is a PNG whose "gbAs" chunk holds the zipped core
// state at a FIXED layout — EWRAM, IWRAM, VRAM, palette, OAM, I/O and CPU at
// byte offsets that do not move between saves of the same build. So the finder
// reads EWRAM/IWRAM straight out of a saved state, and a freeze is promoted to
// a VBA-format cheat code (XXXXXXXX:YY) that mGBA's own cheat engine applies
// every frame — no core changes required.
//
// Layout (verified empirically against Pokémon Emerald on this exact build:
// VBA-cheat marker bytes planted at known bus addresses are found at these
// payload offsets, and the regions tile the payload exactly):
//   total inflated size 0x61000 with EWRAM at 0x21000 and IWRAM at 0x19000.
//   0x00000..0x19000  CPU/scheduler state, palette RAM, OAM, I/O, VRAM
//   0x19000..0x21000  IWRAM (32 KB)
//   0x21000..0x61000  EWRAM (256 KB) — runs to the end of the payload
// If a future core build shuffles the layout, the MgbaState size check
// rejects the state instead of serving bytes from wrong offsets.
'use strict';

// PNG chunk walk: after the 8-byte signature each chunk is
// [u32 BE length][4 type bytes][data][u32 CRC]. Returns { off, len } of the
// DATA (not the chunk header) for the first chunk of that type, or null.
function findPngChunk(bytes, type) {
  if (bytes.length < 8) return null;
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    if (len < 0 || off + 12 + len > bytes.length) return null;
    const t = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (t === type) return { off: off + 8, len };
    off += 12 + len;
  }
  return null;
}

// Replace the data of the chunk of `type` with `newData` (same type, CRC not
// recomputed — mGBA reads its own states without verifying them) and return a
// new PNG. All other chunks are copied byte-for-byte.
function replacePngChunk(bytes, type, newData) {
  const c = findPngChunk(bytes, type);
  if (!c) throw new Error(`state PNG has no ${type} chunk`);
  const head = c.off - 8; // chunk length/type header, just before the data
  const out = new Uint8Array(bytes.length - c.len + newData.length);
  out.set(bytes.subarray(0, head));
  const n = newData.length;
  out[head] = (n >>> 24) & 255; out[head + 1] = (n >>> 16) & 255;
  out[head + 2] = (n >>> 8) & 255; out[head + 3] = n & 255;
  out.set(bytes.subarray(head + 4, head + 8), head + 4); // keep chunk type
  out.set(newData, c.off);
  out.set(bytes.subarray(c.off + c.len + 4), c.off + n + 4); // skip the old CRC
  return out;
}

// ---- compression -----------------------------------------------------------
// The gbAs payload is zlib (78 9C …). Browsers and Node ≥ 18 both ship the
// Web Streams CompressionStream/DecompressionStream API, so one async code
// path serves the app, the tests, and tooling alike.

function inflate(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')))
    .arrayBuffer().then((ab) => new Uint8Array(ab));
}

function deflate(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')))
    .arrayBuffer().then((ab) => new Uint8Array(ab));
}

// ---- state layout ----------------------------------------------------------

const LAYOUT = {
  total: 0x61000,
  ewram: { at: 0x21000, size: 0x40000 },
  iwram: { at: 0x19000, size: 0x8000 },
};

// GBA bus address → payload offset. Covers EWRAM, IWRAM and their hardware
// mirrors (0x02000000-0x02FFFFFF step 0x40000, 0x03000000-0x03FFFFFF step
// 0x8000 — the regions repeat, decoded modulo their size like the real bus).
// Outside those: null.
function busToPayload(addr) {
  const a = addr >>> 0;
  if (a >= 0x02000000 && a < 0x03000000) return LAYOUT.ewram.at + ((a - 0x02000000) % LAYOUT.ewram.size);
  if (a >= 0x03000000 && a < 0x04000000) return LAYOUT.iwram.at + ((a - 0x03000000) % LAYOUT.iwram.size);
  return null;
}

// A decoded state: exposes EWRAM/IWRAM as indexable byte windows over the
// inflated payload plus bus-address reads/writes with mirror handling.
class MgbaState {
  constructor(payload) {
    if (!payload || payload.length !== LAYOUT.total) {
      throw new Error(`unexpected state size ${payload ? payload.length : 0} (want 0x${LAYOUT.total.toString(16)})`);
    }
    this.payload = payload;
  }

  get ewram() { return this.payload.subarray(LAYOUT.ewram.at, LAYOUT.ewram.at + LAYOUT.ewram.size); }
  get iwram() { return this.payload.subarray(LAYOUT.iwram.at, LAYOUT.iwram.at + LAYOUT.iwram.size); }

  // Bus-addressed byte read (mirrors like the hardware bus); null if unmapped.
  readBus(addr) {
    const off = busToPayload(addr);
    return off === null ? null : this.payload[off];
  }

  // Bus-addressed byte write (mirrors like the hardware bus).
  writeBus(addr, value) {
    const off = busToPayload(addr);
    if (off !== null) this.payload[off] = value & 0xFF;
  }
}

// ---- codec -----------------------------------------------------------------

// Decode a saved state (PNG bytes from machine.saveState()) → MgbaState.
async function decodeState(pngBytes) {
  const c = findPngChunk(pngBytes, 'gbAs');
  if (!c) throw new Error('not an mGBA GBA state (no gbAs chunk)');
  const payload = await inflate(pngBytes.subarray(c.off, c.off + c.len));
  return new MgbaState(payload);
}

// Rebuild the full PNG around a (possibly patched) state payload. The original
// PNG is passed in so all other chunks (screenshot, metadata, IEND) are
// preserved untouched.
async function rebuildStatePng(pngBytes, state) {
  const newData = await deflate(state.payload);
  return replacePngChunk(pngBytes, 'gbAs', newData);
}

if (typeof module !== 'undefined') {
  module.exports = { MgbaState, decodeState, rebuildStatePng, findPngChunk, replacePngChunk, busToPayload, LAYOUT };
}
if (typeof window !== 'undefined') {
  window.PocketMgbaState = { MgbaState, decodeState, rebuildStatePng, findPngChunk, replacePngChunk, busToPayload, LAYOUT };
}
