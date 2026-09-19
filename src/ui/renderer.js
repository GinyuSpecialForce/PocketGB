// PocketGB — renderer: canvas display with DMG palette, LCD effects, scaling
//
// Pipeline: the emulator blits into a 160×144 offscreen buffer (2D), then
// present() draws it to the visible canvas at native display resolution.
// When shader effects (subpixel LCD grid / curvature) are enabled and WebGL is
// available, the offscreen is first upscaled through a GL program (pixel-space
// grid, RGB subpixel stripes, barrel distortion), then drawn to the visible
// canvas. Without WebGL — or with shaders off — everything falls back to the
// original 2D scanline overlay path.
'use strict';

const DMG_PALETTE = [
  [155, 188, 15],   // 0 lightest
  [139, 172, 15],   // 1
  [48, 98, 48],     // 2
  [15, 56, 15],     // 3 darkest
];

// Fragment shader: pixel-grid LCD emulation.
//   - rgb subpixel stripes within a pixel (visible at ≥3× scale)
//   - grid gaps between pixels (subpixel = every LCD cell edge)
//   - optional barrel distortion (curvature)
// Coordinates are in *lcd cells*: cellUV = fragPx / cellSize, so grid edges
// stay 1 device px regardless of scale. texelUV must sample cell centers.
const LCD_FRAG = [
  'precision mediump float;',
  'uniform sampler2D uTex;',
  'uniform vec2 uOutPx;',    // output canvas size in px
  'uniform vec2 uCells;',    // 160x144 LCD cells
  'uniform float uCurv;',    // 0..1 curvature amount
  'uniform float uGrid;',    // grid gap strength 0..1
  'uniform float uSubpx;',   // subpixel stripe strength 0..1
  'uniform float uScan;',    // shader scanline strength 0..1
  'const float PI = 3.14159265;',
  'void main() {',
  '  vec2 uv = gl_FragCoord.xy / uOutPx;',          // 0..1
  '  vec2 c = uv - 0.5;',
  '  float r2 = dot(c, c);',
  '  vec2 cuv = c * (1.0 + uCurv * r2 * 1.8) + 0.5;', // barrel-distorted uv',
  '  if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) {',
  '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;',
  '  }',
  '  vec2 fragPx = cuv * uOutPx;',
  '  vec2 cellPx = uOutPx / uCells;',
  '  vec2 cell = floor(fragPx / cellPx);',           // cell index
  '  vec2 inCell = fract(fragPx / cellPx);',         // 0..1 within the cell
  '  vec2 texel = (cell + vec2(0.5)) / uCells;',     // cell-center texel
  '  vec3 col = texture2D(uTex, texel).rgb;',
  // shader scanlines: darken odd rows (cell y parity is stable per LCD row)
  '  float row = mod(cell.y, 2.0);',
  '  col *= 1.0 - uScan * row * 0.5;',
  // subpixel stripes: one R/G/B stripe per third of a cell (only readable
  // when a cell spans >= ~3 device px; uSubpx fades it out at small scales)
  '  float band = floor(inCell.x * 3.0);',
  '  vec3 mask = vec3(equal(vec3(band), vec3(0.0, 1.0, 2.0)));',
  '  col *= mix(vec3(1.0), vec3(0.65) + 0.7 * mask, uSubpx);',
  // grid gaps: darken a 1-px border around every cell
  '  vec2 gap = min(inCell, 1.0 - inCell) * cellPx;', // px distance to cell edge
  '  float edge = min(gap.x, gap.y);',
  '  col *= 1.0 - uGrid * (1.0 - smoothstep(0.0, 1.0, edge));',
  '  gl_FragColor = vec4(col, 1.0);',
  '}',
].join('\n');

// User shader-pack fragment shader (`.pbg-fx`). Preamble uniforms mirror the
// built-in LCD program; the pack's GLSL is appended verbatim and must assign
// gl_FragColor. Validated with compileProgram on load; packs that fail to
// compile are rejected and the built-in LCD program keeps rendering.
const PACK_FRAG_HEAD = [
  'precision mediump float;',
  'uniform sampler2D uTex;',
  'uniform vec2 uOutPx;',
  'uniform vec2 uCells;',
  'uniform float uCurv;',
  'uniform float uGrid;',
  'uniform float uSubpx;',
  'uniform float uScan;',
  'varying vec2 vCellUV;',
  'varying vec2 vTexelUV;',
].join('\n');

const LCD_VERT = [
  'attribute vec2 aPos;',
  'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }',
].join('\n');

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = 160; this.offscreen.height = 144;
    this.octx = this.offscreen.getContext('2d');
    this.imageData = this.octx.createImageData(160, 144);
    this.palRGB = new Uint32Array(4);
    this.setPalette(DMG_PALETTE);

    // ---- LCD effects (2D path) ----
    this.effects = { ghosting: false, scanlines: false, shader: false, curvature: false };
    this.ghostStrength = 0.45;   // how much of the previous frame bleeds through
    this.prevPx = null;          // previous frame's pixel buffer (Uint32Array)
    this.scanCanvas = document.createElement('canvas');
    this.scanCanvas.width = 160; this.scanCanvas.height = 144;
    this._buildScanlines();

    // ---- WebGL shader path ----
    this.gl = null;
    this.frameCount = 0;
    // ---- Super Game Boy ----
    this.sgb = null;             // active SGB layer (set by app.js per game)
    this.sgbBorder = null;       // 256x224 RGBA canvas-ish Uint32Array when present
    // ---- ghost racer picture-in-picture ----
    // Ghost draws at full palette color into its own 160x144 surface, which
    // the app displays in the #ghost-pip panel BESIDE the game screen. If the
    // app hasn't attached the panel yet, fall back to an offscreen canvas.
    this.ghostCanvas = document.getElementById('ghost-screen') || document.createElement('canvas');
    if (this.ghostCanvas.width !== 160) { this.ghostCanvas.width = 160; this.ghostCanvas.height = 144; }
    this.gctx = this.ghostCanvas.getContext('2d');
    this.ghostImage = this.gctx.createImageData(160, 144);
    this.ghostPx = new Uint32Array(this.ghostImage.data.buffer);
  }

  setPalette(colors) {
    // canvas is little-endian ABGR packing
    for (let i = 0; i < 4; i++) {
      const [r, g, b] = colors[i];
      this.palRGB[i] = (0xFF << 24) | (b << 16) | (g << 8) | r;
    }
  }

  // Attach an SGB layer and rebuild the border bitmap when the game sends one.
  setSGB(sgb) {
    this.sgb = sgb;
    if (!sgb) this.sgbBorder = null;
  }

  // Rebuild the 256x224 border RGBA buffer from the game's CHR/map/palette
  // transfers (SNES 4bpp planar tiles, 32x28 map, 4 palettes of 16).
  _rebuildSgbBorder(sgb) {
    const W = 256, H = 224;
    const out = new Uint32Array(W * H);
    out.fill(0xFF000000); // backdrop black behind everything
    const tiles = sgb.borderTiles, map = sgb.borderMap, pals = sgb.borderPal;
    for (let my = 0; my < 28; my++) {
      for (let mx = 0; mx < 32; mx++) {
        const e = map[my * 32 + mx];
        const tile = e & 0xFF, palIdx = ((e >> 10) & 7) - 4; // palettes 4-7 → 0-3
        const xflip = !!(e & 0x4000), yflip = !!(e & 0x8000);
        if (palIdx < 0 || palIdx > 3 || !tiles) continue;
        for (let py = 0; py < 8; py++) {
          const ty = yflip ? 7 - py : py;
          // SNES 4bpp: 8 bytes per tile-row — low plane byte, then high plane byte
          const lo = tiles[tile * 32 + ty * 2], hi = tiles[tile * 32 + ty * 2 + 1];
          const lo2 = tiles[tile * 32 + ty * 2 + 16], hi2 = tiles[tile * 32 + ty * 2 + 17];
          for (let px = 0; px < 8; px++) {
            const bit = xflip ? px : 7 - px;
            const b0 = (lo >> bit) & 1, b1 = (hi >> bit) & 1, b2 = (lo2 >> bit) & 1, b3 = (hi2 >> bit) & 1;
            const ci = b0 | (b1 << 1) | (b2 << 2) | (b3 << 3);
            const c = pals[palIdx * 16 + ci];
            if (ci === 0) continue; // color 0 transparent → backdrop
            const dx = mx * 8 + px, dy = my * 8 + py;
            if (dx >= W || dy >= H) continue;
            const r = (c & 31) << 3, g = ((c >> 5) & 31) << 3, b = ((c >> 10) & 31) << 3;
            out[dy * W + dx] = (0xFF << 24) | (b << 16) | (g << 8) | r;
          }
        }
      }
    }
    this.sgbBorder = out;
  }

  // Paint the border into the visible canvas around the 160x144 game area.
  _presentSgbBorder() {
    const sgb = this.sgb;
    if (!sgb) return;
    if (sgb.borderDirty && sgb.borderMap && sgb.borderPal) { this._rebuildSgbBorder(sgb); sgb.borderDirty = false; }
    if (!this.sgbBorder) return;
    // layout: border canvas scaled to fit the visible canvas, GB area centered
    const W = 256, H = 224;
    const scale = Math.min(this.canvas.width / W, this.canvas.height / H);
    const dw = Math.floor(W * scale), dh = Math.floor(H * scale);
    const ox = Math.floor((this.canvas.width - dw) / 2), oy = Math.floor((this.canvas.height - dh) / 2);
    const bctx = this._borderCtx || (this._borderCtx = document.createElement('canvas').getContext('2d'));
    const bc = bctx.canvas; bc.width = W; bc.height = H;
    const img = bctx.createImageData(W, H);
    new Uint32Array(img.data.buffer).set(this.sgbBorder);
    bctx.putImageData(img, 0, 0);
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bc, ox, oy, dw, dh);
    // the game window position inside the border
    const gx = ox + Math.floor(48 * scale), gy = oy + Math.floor(40 * scale);
    const gw = Math.floor(160 * scale), gh = Math.floor(144 * scale);
    ctx.drawImage(this.offscreen, gx, gy, gw, gh);
  }

  setEffects(e) {
    this.effects.ghosting = !!e.ghosting;
    this.effects.scanlines = !!e.scanlines;
    this.effects.shader = !!e.shader;
    this.effects.curvature = !!e.curvature;
    if (!this.effects.ghosting && this.prevPx) { this.prevPx = null; }
    // (Re)init GL lazily on demand; drop the context when disabled.
    if (!this.effects.shader && this.gl) { this._glLoss(); }
  }

  _glLoss() {
    const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    this.gl = null;
  }

  // Lazy WebGL setup: a GL canvas at the visible canvas size + the program.
  // Builds the shader-pack program when one is loaded, else the built-in LCD
  // program. A pack that fails to compile is rejected (error surfaced via the
  // callback) and the built-in keeps rendering.
  _ensureGL() {
    const packKey = this.shaderPack ? this.shaderPack.name + '\u0000' + this.shaderPack.glsl : null;
    if (this.gl && this._glPackId === packKey) return true;
    if (this.gl) this._glLoss();
    try {
      const glc = document.createElement('canvas');
      glc.width = this.canvas.width; glc.height = this.canvas.height;
      const gl = glc.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
      if (!gl) return false;
      const pack = this.shaderPack;
      const fragSrc = pack
        ? `${PACK_FRAG_HEAD}\n#define uCellUV vCellUV\n#define uTexelUV vTexelUV\n${pack.glsl}`
        : LCD_FRAG;
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, LCD_VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
      this.glUniform = {
        outPx: gl.getUniformLocation(prog, 'uOutPx'),
        cells: gl.getUniformLocation(prog, 'uCells'),
        curv: gl.getUniformLocation(prog, 'uCurv'),
        grid: gl.getUniformLocation(prog, 'uGrid'),
        subpx: gl.getUniformLocation(prog, 'uSubpx'),
        scan: gl.getUniformLocation(prog, 'uScan'),
      };
      this.glCanvas = glc;
      this.gl = gl;
      this._glPackId = pack ? pack.name + '\u0000' + pack.glsl : null;
      return true;
    } catch (err) {
      console.error('shader init failed, falling back to 2D:', err);
      this.gl = null;
      this.effects.shader = false;
      return false;
    }
  }

  // ---- shader packs (.pbg-fx) ----
  // pack = { name, glsl } from parseShaderPack(); null/undefined selects the
  // built-in LCD program. The current GL program rebuilds lazily on next
  // present() when the pack changes (hot-reload friendly). Change detection
  // keys on NAME + GLSL: a hot-reload edits the file but keeps the name, and
  // that must still rebuild the program.
  setShaderPack(pack) {
    const key = (p) => (p ? p.name + '\u0000' + p.glsl : null);
    const changed = key(pack) !== key(this.shaderPack);
    this.shaderPack = pack || null;
    if (changed && this.gl) this._glPackId = undefined; // force program rebuild
  }

  get shaderPackError() { return this._packError || null; }
  set shaderPackError(v) { this._packError = v; }

  // Pre-render the 2D-path scanline overlay once (every other row darkened ~18%).
  _buildScanlines() {
    const c = this.scanCanvas.getContext('2d');
    const img = c.createImageData(160, 144);
    const px = new Uint32Array(img.data.buffer);
    for (let y = 0; y < 144; y++) {
      const dark = (y & 1) === 1;
      // black with alpha 46/255 ≈ 18%
      const v = dark ? 0x2E000000 : 0x00000000;
      for (let x = 0; x < 160; x++) px[y * 160 + x] = v;
    }
    c.putImageData(img, 0, 0);
  }

  // fb is either a shade-index buffer (DMG, 1 byte/pixel) or a BGR555 color
  // buffer (CGB, 1 uint32/pixel). Blends ghosting with the previous frame.
  blit(fb, isColor) {
    if (!fb) return;
    if (!this.px) this.px = new Uint32Array(this.imageData.data.buffer);
    if (!this._rgb555LUT) {
      // 32K-entry BGR555→xRGB888 LUT: the CGB blit is otherwise 23,040
      // function calls per frame (the single largest per-frame CPU cost for
      // color games). One-time ~256 KB allocation, then one array read/pixel.
      this._rgb555LUT = new Uint32Array(32768);
      for (let c = 0; c < 32768; c++) this._rgb555LUT[c] = rgb555to888(c);
    }
    const rgb555LUT = this._rgb555LUT;
    // SGB path: remap DMG shades through the game's SGB palettes, honor the
    // screen mask, then skip the normal DMG palette entirely.
    const sgb = this.sgb;
    if (sgb && !isColor) {
      if (sgb.mask === 2) { this.px.fill(0xFF000000); }
      else if (sgb.mask === 3) { this.px.fill(0xFF000000 | (rgb555to888(sgb.palData[0]))); }
      else {
        const src = sgb.mask === 1 && sgb.frozen ? sgb.frozen : fb;
        if (sgb.mask === 1 && !sgb.frozen) sgb.freeze(fb);
        for (let i = 0; i < this.px.length; i++) {
          const tile = (i / 160) | 0, col = i % 160;
          const pal = sgb.attrMap[((tile >> 3) * 20 + (col >> 3)) % sgb.attrMap.length];
          this.px[i] = rgb555to888(sgb.mapShade(src[i] & 3, pal));
        }
      }
    } else {
    const px = this.px;
    const ghost = this.effects.ghosting && this.prevPx;
    if (isColor) {
      if (ghost) {
        const g = this.ghostStrength, ig = 1 - g, prev = this.prevPx;
        for (let i = 0; i < px.length; i++) {
          const cur = rgb555LUT[fb[i] & 0x7FFF], old = prev[i];
          const r = (((cur & 0xFF) * ig + (old & 0xFF) * g) | 0);
          const gc = ((((cur >>> 8) & 0xFF) * ig + ((old >>> 8) & 0xFF) * g) | 0);
          const b = ((((cur >>> 16) & 0xFF) * ig + ((old >>> 16) & 0xFF) * g) | 0);
          px[i] = 0xFF000000 | (b << 16) | (gc << 8) | r;
        }
      } else {
        for (let i = 0; i < px.length; i++) px[i] = rgb555LUT[fb[i] & 0x7FFF];
      }
    } else if (ghost) {
      // Mix each channel with the previous frame (LCD response-time ghosting).
      const g = this.ghostStrength;
      const ig = 1 - g;
      const prev = this.prevPx;
      for (let i = 0; i < px.length; i++) {
        const cur = this.palRGB[fb[i] & 3], old = prev[i];
        const r = (((cur & 0xFF) * ig + (old & 0xFF) * g) | 0);
        const gc = ((((cur >>> 8) & 0xFF) * ig + ((old >>> 8) & 0xFF) * g) | 0);
        const b = ((((cur >>> 16) & 0xFF) * ig + ((old >>> 16) & 0xFF) * g) | 0);
        px[i] = 0xFF000000 | (b << 16) | (gc << 8) | r;
      }
    } else {
      for (let i = 0; i < px.length; i++) px[i] = this.palRGB[fb[i] & 3];
    }
    if (this.effects.ghosting) {
      if (!this.prevPx) this.prevPx = new Uint32Array(px.length);
      this.prevPx.set(px);
    }
    this.octx.putImageData(this.imageData, 0, 0);
    this.frameCount++;
    } // end non-SGB blit path
    // Ghost racer picture-in-picture: drawn to its OWN canvas panel beside
    // the game (see index.html #ghost-pip) — never over the game display.
    // capture.observe() receives the raw game framebuffer, so GIF/WebM/movies
    // stay ghost-free.
    if (this.ghostFrame) this.blitGhost(this.ghostFrame, isColor);
    this.ghostFrame = null; // one-shot: only the frame that set it composites
  }

  // Ghost PiP: render the ghost machine's framebuffer into the separate
  // #ghost-screen canvas at REGULAR palette color. The panel visibility is
  // managed by the app (`.on` class); this just blits pixels.
  blitGhost(gf, isColor) {
    const gp = this.ghostPx;
    if (isColor) {
      const lut = this._rgb555LUT;
      if (lut) {
        for (let i = 0; i < gp.length; i++) gp[i] = lut[gf[i] & 0x7FFF];
      } else {
        for (let i = 0; i < gp.length; i++) gp[i] = rgb555to888(gf[i]);
      }
    } else {
      for (let i = 0; i < gp.length; i++) gp[i] = this.palRGB[gf[i] & 3];
    }
    this.gctx.putImageData(this.ghostImage, 0, 0);
  }

  present() {
    const useShader = this.effects.shader && this._ensureGL();
    if (useShader) this._presentGL();
    else this._present2D();
    // SGB border (if the game transferred one) wraps the game area; drawn over
    // the background after the game window so it can overlap like on hardware.
    if (this.sgb && this.sgbBorder !== null) this._presentSgbBorder();
  }

  _present2D() {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.offscreen, 0, 0, this.canvas.width, this.canvas.height);
    if (this.effects.scanlines) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.scanCanvas, 0, 0, this.canvas.width, this.canvas.height);
      ctx.imageSmoothingEnabled = false;
    }
  }

  _presentGL() {
    const gl = this.gl;
    // upload the 160x144 offscreen as the texture
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.offscreen);
    // shader knobs: grid + subpixel stripes always on with the shader;
    // curvature honors its own toggle; scanlines move into the shader.
    // An active pack's uniform overrides win over the defaults.
    const ov = this.shaderPack ? packUniformOverrides(this.shaderPack) : null;
    gl.uniform2f(this.glUniform.outPx, this.glCanvas.width, this.glCanvas.height);
    gl.uniform2f(this.glUniform.cells, 160, 144);
    gl.uniform1f(this.glUniform.curv, ov && ov.curv !== undefined ? ov.curv : this.effects.curvature ? 1.0 : 0.0);
    gl.uniform1f(this.glUniform.grid, ov && ov.grid !== undefined ? ov.grid : 0.35);
    // subpixel stripes only make sense when a cell spans >= 3 device px
    const cellPx = Math.min(this.glCanvas.width / 160, this.glCanvas.height / 144);
    const autoSubpx = cellPx >= 3 ? 0.5 : 0.0;
    gl.uniform1f(this.glUniform.subpx, ov && ov.subpx !== undefined ? ov.subpx : autoSubpx);
    gl.uniform1f(this.glUniform.scan, ov && ov.scan !== undefined ? ov.scan : this.effects.scanlines ? 1.0 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // composite the GL result onto the visible canvas
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.glCanvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  drawBlank() {
    const px = new Uint32Array(this.imageData.data.buffer);
    px.fill(this.palRGB[0]);
    this.octx.putImageData(this.imageData, 0, 0);
    this.present();
  }
}

// packUniformOverrides is defined in shader-pack.js (loaded before renderer.js
// in index.html; under Node the test harness requires it directly).

// Expand BGR555 to an xRGB888 canvas pixel (little-endian ABGR packing)
function rgb555to888(c) {
  const r5 = c & 0x1F, g5 = (c >> 5) & 0x1F, b5 = (c >> 10) & 0x1F;
  const r = (r5 << 3) | (r5 >> 2), g = (g5 << 3) | (g5 >> 2), b = (b5 << 3) | (b5 >> 2);
  return 0xFF000000 | (b << 16) | (g << 8) | r;
}

if (typeof module !== 'undefined' && typeof __dirname !== 'undefined') {
  // Under Node (tests) pull packUniformOverrides from shader-pack.js; in the
  // browser it arrives as a global because shader-pack.js loads first. Resolve
  // via globalThis (never a bare identifier): a bare `typeof X` throws if any
  // outer scope holds a TDZ binding named X — exactly the classic-script
  // collision class this codebase guards against.
  const _pvo = globalThis.packUniformOverrides
    || require('./shader-pack').packUniformOverrides;
  module.exports = { Renderer, DMG_PALETTE, packUniformOverrides: _pvo };
}
