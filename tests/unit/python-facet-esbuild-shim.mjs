#!/usr/bin/env bun
//
// Regression: the Pyodide facet preamble injects `installPythonFsSnapshot`
// via `.toString()`. Under wrangler's esbuild (`keepNames: true`) every named
// function/arrow is wrapped as `__name(fn, "fn")`, so the serialized body
// references `__name`/`__defProp` by bare identifier. Those bindings do NOT
// cross into the facet isolate, so without a re-declared shim the facet dies
// at module-init with "__name is not defined" and ALL python execution fails
// (observed live: `VFS mount failed: __name is not defined`).
//
// The un-bundled TS source contains no `__name`, so the existing
// python-snapshot-permissions test can never surface this — only the
// esbuild-bundled worker does. This test reproduces the keepNames wrapping
// with the real esbuild and proves buildPyodidePreamble ships a shim that
// makes the wrapped, serialized installer runnable.

import assert from 'node:assert/strict';
import esbuild from 'esbuild';

import {
  installPythonFsSnapshot,
  expandPythonEffectiveMode,
  buildPyodidePreamble,
} from '../../packages/worker/src/runtime/python-runner.ts';

// 1. Simulate the deployed worker: bundle both facet helpers through esbuild
//    exactly as wrangler does (keepNames on), then evaluate to obtain the real
//    BUNDLED function objects. Their `.toString()` is what the preamble embeds
//    at runtime — a body that references `__name` but carries no definition of
//    it (the helper lives in the outer supervisor bundle, out of facet scope).
const bundle = esbuild.transformSync(
  `${expandPythonEffectiveMode.toString()}\n` +
  `const __snap = ${installPythonFsSnapshot.toString()};\n` +
  `globalThis.__testBundle = { __snap, expandPythonEffectiveMode };`,
  { keepNames: true },
).code;
new Function(bundle)();
const bundledSnap = globalThis.__testBundle.__snap;
const bundledMode = globalThis.__testBundle.expandPythonEffectiveMode;
assert.match(bundledSnap.toString(), /__name\(/, 'bundled installer body must reference __name (the trap)');

// The exact source the preamble injects at runtime.
const injectedFns =
  `${bundledMode.toString()}\n` +
  `const installPythonFsSnapshot = ${bundledSnap.toString()};`;

// 2. Extract the shim the preamble actually emits, so the test tracks the real
//    fix rather than a hand-copied duplicate.
const preamble = buildPyodidePreamble('/* asm.js stub */', '', undefined, []);
const nameShim = /if \(typeof globalThis\.__name[\s\S]*?\n}/.exec(preamble)?.[0];
assert.ok(nameShim, 'buildPyodidePreamble must install a globalThis.__name shim');
// The shim must be idempotent — safe when pyodide asm.js already declares __name.
assert.match(nameShim, /typeof globalThis\.__name !== "function"/, 'shim must guard against redeclaration');

// A fake emscripten FS so calling the installer exercises the nested named
// arrows (`norm`, `decode`) that keepNames wraps with `__name` inside the body.
const callSrc =
  `installPythonFsSnapshot(` +
  `{ analyzePath: () => ({ exists: false }), unlink() {}, mkdirTree() {}, writeFile() {}, chmod() {} }, ` +
  `{ dirs: [], files: { 'a.txt': btoa('hi') }, modes: { 'a.txt': 4 } }, new Set());`;

// 3. RED: without the shim (and no pre-existing global __name), running the
//    injected installer throws exactly as observed live
//    ("VFS mount failed: __name is not defined").
delete globalThis.__name;
assert.throws(
  () => new Function(`${injectedFns}\n${callSrc}`)(),
  /__name is not defined/,
  'without the shim the facet must fail exactly as observed live',
);

// 4. GREEN: with the preamble's own shim prepended, it defines and runs.
delete globalThis.__name;
assert.doesNotThrow(
  () => new Function(`${nameShim}\n${injectedFns}\n${callSrc}`)(),
  'the preamble shim must make the esbuild-wrapped installer runnable',
);

// 5. Idempotent: a pre-existing global __name is left intact (no redeclaration).
const sentinel = (t, v) => t;
globalThis.__name = sentinel;
new Function(nameShim)();
assert.equal(globalThis.__name, sentinel, 'shim must not clobber an existing global __name');
delete globalThis.__name;

console.log('python-facet-esbuild-shim: PASS');
