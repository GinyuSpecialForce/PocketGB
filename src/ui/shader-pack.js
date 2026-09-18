'use strict';
// PocketGB — shader pack loader (`.pbg-fx`).
// A pack is a JSON file with a GLSL fragment body that colours one output
// pixel given the emulated LCD texel:
//   { "name": "my-fx", "uniforms": { "grid": 0.5 }, "glsl": "…gl_FragColor = …" }
// The body is appended after a fixed preamble (uTex, uOutPx, uCells, uCurv,
// uGrid, uSubpx, uScan + vCellUV/vTexelUV varyings, also exposed as
// uCellUV/uTexelUV macros). Everything is validated before use: JSON.parse,
// name/size limits, `gl_FragColor` must be assigned, GLSL must not redeclare
// the preamble (uniform/varying/attribute at top level), and the program is
// actually compiled by the Renderer before a pack is trusted.
// Rendering stays deterministic: a bad pack always degrades to the built-in
// LCD shader, never to a black screen.

const PACK_MAX_GLSL = 16384;
const PACK_MAX_NAME = 64;
// Identifiers the preamble declares; a pack redeclaring them would fail to
// compile anyway, but rejecting early gives a readable error.
const PACK_RESERVED = /\b(uniform|varying|attribute)\b/;

// Parse + validate pack JSON text → { name, glsl, uniforms } or { error }.
function parseShaderPack(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) { return { error: `not valid JSON: ${e.message}` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'pack must be a JSON object' };
  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  if (!name) return { error: 'pack needs a "name"' };
  if (name.length > PACK_MAX_NAME) return { error: 'name too long' };
  if (typeof doc.glsl !== 'string' || !doc.glsl.trim()) return { error: 'pack needs a "glsl" body' };
  if (doc.glsl.length > PACK_MAX_GLSL) return { error: `glsl body too large (max ${PACK_MAX_GLSL} chars)` };
  // The body must write the output colour, or the screen stays black.
  if (!/gl_FragColor\s*=/.test(doc.glsl)) return { error: 'glsl body must assign gl_FragColor' };
  // Top-level precision/varying redeclarations break the link; catch early.
  const head = doc.glsl.slice(0, 400);
  if (PACK_RESERVED.test(head)) {
    return { error: 'pack glsl must not declare uniform/varying — the preamble provides them' };
  }
  const uniforms = {};
  if (doc.uniforms !== undefined) {
    if (!doc.uniforms || typeof doc.uniforms !== 'object' || Array.isArray(doc.uniforms)) {
      return { error: '"uniforms" must be an object of numbers' };
    }
    for (const [k, v] of Object.entries(doc.uniforms)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `uniform "${k}" must be a finite number` };
      uniforms[k] = v;
    }
  }
  return { name, glsl: doc.glsl, uniforms };
}

// Clamp pack uniform overrides into the renderer's knob ranges. Unknown keys
// are ignored; known keys map onto the standard uniforms (curv/grid/subpx/scan).
function packUniformOverrides(pack) {
  const out = {};
  if (!pack || !pack.uniforms) return out;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  if ('curv' in pack.uniforms) out.curv = clamp01(pack.uniforms.curv);
  if ('grid' in pack.uniforms) out.grid = clamp01(pack.uniforms.grid);
  if ('subpx' in pack.uniforms) out.subpx = clamp01(pack.uniforms.subpx);
  if ('scan' in pack.uniforms) out.scan = clamp01(pack.uniforms.scan);
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseShaderPack, packUniformOverrides, PACK_MAX_GLSL, PACK_MAX_NAME };
}
