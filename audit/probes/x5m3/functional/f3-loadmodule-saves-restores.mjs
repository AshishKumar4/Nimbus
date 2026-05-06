#!/usr/bin/env bun
// X.5-M3 functional probe #3: __loadModule must thread globalThis.__currentModulePath
// AROUND the precompiled / fallback eval, save+restoring across recursion.
//
// We can't easily run __loadModule in isolation (it depends on a dozen runner
// globals), so this is a source-text shape probe: confirm the prologue/epilogue
// exist and bracket the eval block correctly.

import { ok, group, summary } from '../../w6/_tap.mjs';
import { getShimSource } from './_eval-shims.mjs';

const src = getShimSource();

// Locate __loadModule body.
const loadModIdx = src.indexOf('function __loadModule(resolvedPath)');
ok('__loadModule defined', loadModIdx >= 0);

if (loadModIdx < 0) summary('f3-loadmodule-saves-restores');

// Slice from start to end-of-function (roughly: until next top-level `function `
// or `// ═` boundary).
const sliceStart = loadModIdx;
const nextFn = src.indexOf('\nfunction ', sliceStart + 1);
const nextSect = src.indexOf('\n// ═', sliceStart + 1);
const sliceEnd = Math.min(
  nextFn > 0 ? nextFn : src.length,
  nextSect > 0 ? nextSect : src.length,
);
const body = src.slice(sliceStart, sliceEnd);

group('__loadModule prologue: save + assign __currentModulePath', () => {
  ok('saves prior __currentModulePath into a local',
    /__prevModulePath\s*=\s*globalThis\.__currentModulePath/.test(body));
  ok('assigns globalThis.__currentModulePath = resolvedPath',
    /globalThis\.__currentModulePath\s*=\s*resolvedPath/.test(body));
});

group('__loadModule epilogue: restore in finally', () => {
  ok('finally block restores __currentModulePath',
    /finally\s*{\s*[^}]*globalThis\.__currentModulePath\s*=\s*__prevModulePath/.test(body));
});

group('save+restore brackets the precompiled invocation', () => {
  // The save must precede `precompiled(` and the restore must follow it.
  const saveIdx = body.search(/__prevModulePath\s*=\s*globalThis\.__currentModulePath/);
  const precompIdx = body.indexOf('precompiled(');
  const restoreIdx = body.search(/globalThis\.__currentModulePath\s*=\s*__prevModulePath/);
  ok('save is before precompiled call', saveIdx >= 0 && saveIdx < precompIdx);
  ok('restore is after precompiled call', restoreIdx > precompIdx);
});

group('save+restore also brackets the new Function fallback', () => {
  const saveIdx = body.search(/__prevModulePath\s*=\s*globalThis\.__currentModulePath/);
  // X.5-S: the runtime fallback was migrated from the literal
  //   new Function("exports","require","module","__filename","__dirname", code)
  // to the conditional-param-rename helper __mkCompiledFn(code) — see
  // node-shims.ts §"X.5-S: __mkCompiledFn". The save+restore invariant
  // (this probe) is unchanged; only the symbol it brackets changed.
  // Match either form so this probe survives both pre- and post-X.5-S.
  const newFnIdx = body.search(
    /(new Function\("exports", "require", "module", "__filename", "__dirname", code\)|__mkCompiledFn\(code\))/,
  );
  const restoreIdx = body.search(/globalThis\.__currentModulePath\s*=\s*__prevModulePath/);
  ok('save is before new Function fallback', saveIdx >= 0 && saveIdx < newFnIdx);
  ok('restore is after new Function fallback', restoreIdx > newFnIdx);
});

summary('f3-loadmodule-saves-restores');
