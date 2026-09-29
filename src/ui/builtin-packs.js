'use strict';
// PocketGB — built-in shader packs.
// Curated looks in the `.pbg-fx` format (see shader-pack.js), shipped so the
// shader pipeline is usable without authoring GLSL: the effects overlay lists
// these by name and applies them through the same parse → compile → apply
// path as file packs, so every validation rule and uniform override works
// identically. Data only — selection UI lives in app.js.
//
// GLSL notes: bodies are appended after the renderer's preamble (uTex/uOutPx/
// uCells/uCurv/uGrid/uSubpx/uScan + vCellUV/vTexelUV, also as macros) and must
// assign gl_FragColor from a cell-center texel sample. uOutPx.y may exceed
// the picture height (vTexelUV.y > 1) when the optional input strip is
// present — packs clamp and letterbox that region themselves.
const BUILTIN_SHADER_PACKS = [
  {
    name: 'CRT — warm amber',
    json: {
      name: 'CRT — warm amber',
      uniforms: { scan: 0.9, grid: 0.25, subpx: 0.2 },
      glsl: [
        'vec2 tuv = vec2(vTexelUV.x, min(vTexelUV.y, 1.0));',
        'vec3 col = texture2D(uTex, tuv).rgb;',
        'float luma = dot(col, vec3(0.299, 0.587, 0.114));',
        'vec3 amber = vec3(1.0, 0.72, 0.28) * luma;',
        'col = mix(col, amber, 0.85);',
        'float row = mod(floor(vCellUV.y * uCells.y), 2.0);',
        'col *= 1.0 - uScan * row * 0.45;',
        'col *= 1.0 - uGrid * 0.2;',
        'gl_FragColor = vec4(col, 1.0);',
      ].join('\n'),
    },
  },
  {
    name: 'Dot matrix — game.com green',
    json: {
      name: 'Dot matrix — game.com green',
      uniforms: { grid: 0.85, subpx: 0.0 },
      glsl: [
        'vec2 tuv = vec2(vTexelUV.x, min(vTexelUV.y, 1.0));',
        'vec3 col = texture2D(uTex, tuv).rgb;',
        'float luma = dot(col, vec3(0.299, 0.587, 0.114));',
        'vec3 g = vec3(0.55, 0.85, 0.45) * (0.15 + 0.85 * luma);',
        'vec2 f = fract(vCellUV) - 0.5;',
        'float dot_ = 1.0 - smoothstep(0.32, 0.5, max(abs(f.x), abs(f.y)));',
        'gl_FragColor = vec4(g * (0.35 + 0.65 * dot_), 1.0);',
      ].join('\n'),
    },
  },
  {
    name: 'VHS — softened composite',
    json: {
      name: 'VHS — softened composite',
      uniforms: { scan: 0.35, grid: 0.0, subpx: 0.0 },
      glsl: [
        'vec2 tuv = vec2(vTexelUV.x, min(vTexelUV.y, 1.0));',
        'vec3 col = texture2D(uTex, tuv).rgb;',
        'vec3 right = texture2D(uTex, vec2(min(tuv.x + 1.0 / uCells.x, 1.0), tuv.y)).rgb;',
        'vec3 down = texture2D(uTex, vec2(tuv.x, min(tuv.y + 1.0 / uCells.y, 1.0))).rgb;',
        'col = (col * 2.0 + right + down) * 0.25;', // cheap chroma-ish smear
        'float wob = sin(tuv.y * 320.0) * 0.0035;',
        'col *= 1.0 + wob;',
        'float row = mod(floor(vCellUV.y * uCells.y), 2.0);',
        'col *= 1.0 - uScan * row * 0.3;',
        'gl_FragColor = vec4(col, 1.0);',
      ].join('\n'),
    },
  },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BUILTIN_SHADER_PACKS };
}
if (typeof window !== 'undefined') {
  window.PocketBuiltinPacks = { BUILTIN_SHADER_PACKS };
}
