'use strict';
// Tests for the built-in shader packs: every shipped pack must parse through
// the real .pbg-fx validator and carry sane uniform overrides — a pack that
// ships broken would reject at select time and silently keep the old shader.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseShaderPack, packUniformOverrides } = require('../src/ui/shader-pack');
const { BUILTIN_SHADER_PACKS } = require('../src/ui/builtin-packs');

test('every built-in pack parses as a valid .pbg-fx pack', () => {
  assert.ok(BUILTIN_SHADER_PACKS.length >= 3);
  for (const p of BUILTIN_SHADER_PACKS) {
    const parsed = parseShaderPack(JSON.stringify(p.json));
    assert.ok(!parsed.error, `${p.name}: ${parsed.error}`);
    assert.strictEqual(parsed.name, p.json.name);
    assert.match(parsed.glsl, /gl_FragColor\s*=/);
  }
});

test('built-in pack names are unique (select options key off name)', () => {
  const names = BUILTIN_SHADER_PACKS.map((p) => p.name);
  assert.strictEqual(new Set(names).size, names.length);
});

test('built-in pack uniforms clamp into the renderer knob ranges', () => {
  for (const p of BUILTIN_SHADER_PACKS) {
    const ov = packUniformOverrides(p.json);
    for (const v of Object.values(ov)) {
      assert.ok(v >= 0 && v <= 1, `${p.name}: uniform ${v} out of range`);
    }
  }
});

test('the CRT pack really does request scanlines + grid overrides', () => {
  const crt = BUILTIN_SHADER_PACKS.find((p) => /CRT/.test(p.name));
  assert.ok(crt);
  const ov = packUniformOverrides(crt.json);
  assert.ok(ov.scan > 0.5, 'CRT needs strong scanlines');
  assert.ok(ov.grid > 0);
});

test('packs never declare preamble uniforms (rejected by the validator otherwise)', () => {
  for (const p of BUILTIN_SHADER_PACKS) {
    assert.doesNotMatch(p.json.glsl.slice(0, 400), /\b(uniform|varying|attribute)\b/);
  }
});
