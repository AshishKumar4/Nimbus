#!/usr/bin/env bun
// Stage C wiring test for the OpenTUI wasm renderer. Proves that the @opentui/core
// bundle patch (scripts/opencode/bundle-patches.ts → nimbusPatchOpenTUI) reroutes
// the FFI render-library resolution to the Nimbus wasm backend instead of throwing
// "OpenTUI native FFI is not available" at module init:
//   1. all four @opentui/core init seams apply exactly once (fail-loud anchors)
//   2. with globalThis.__nimbusOpenTUIBackend set, the PATCHED bundle imports
//      without the init throw and resolveRenderLib() returns a real FFIRenderLib
//   3. that FFIRenderLib is fully backed by the wasm backend: createRenderer +
//      getNextBuffer + getBufferWidth/Height round-trip real data through the
//      patched loadBackend → getOpenTUILib → dlopen path (all 279 symbols).
//
// The patch targets @opentui/core SOURCE chunks, which live in the opencode
// build clone (not this repo). When that source is absent — a fresh checkout or
// CI without the clone — the test SKIPS with a clear message (the build host that
// produces the staged opencode dist always has it). Override the source dir with
// NIMBUS_OPENTUI_CORE_DIR.

import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  nimbusPatchOpenTUI,
  OPENTUI_FFI_CHUNK_MARKER,
} from '../../packages/worker/scripts/opencode/bundle-patches.ts';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { OpenTUIWasmBackend } from '../../packages/worker/src/runtime/opentui-wasm-backend.ts';
import { OPENTUI_WASM_ENTRY } from '../../packages/worker/src/opentui-wasm-artifact.generated.ts';

// ── locate the @opentui/core source dir carrying the FFI chunk ────────────────
function findOpenTUICoreDir() {
  if (process.env.NIMBUS_OPENTUI_CORE_DIR) return process.env.NIMBUS_OPENTUI_CORE_DIR;
  for (const root of ['/tmp/opencode-research/opencode', process.env.NIMBUS_OPENCODE_CLONE].filter(Boolean)) {
    if (!existsSync(root)) continue;
    let out = '';
    try {
      out = execSync(
        `find ${root} -path '*@opentui/core/index.js' -not -path '*core-*' 2>/dev/null | head -5`,
      ).toString();
    } catch {
      /* find may exit non-zero; ignore */
    }
    for (const main of out.split('\n').filter(Boolean)) {
      const dir = path.dirname(main);
      if (readdirSync(dir).some((f) => /^index(-[a-z0-9]+)?\.js$/.test(f) &&
        readFileSync(path.join(dir, f), 'utf8').includes(OPENTUI_FFI_CHUNK_MARKER))) {
        return dir;
      }
    }
  }
  return null;
}

const coreDir = findOpenTUICoreDir();
if (!coreDir) {
  console.log('opentui-bundle-wiring SKIP: no @opentui/core source found ' +
    '(needs the opencode build clone; set NIMBUS_OPENTUI_CORE_DIR to run)');
  process.exit(0);
}
console.log(`opentui-bundle-wiring — @opentui/core source: ${coreDir}`);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'opentui-bundle-wiring-'));
try {
  cpSync(coreDir, tmp, { recursive: true });

  // ── Check 1: the patch applies to every FFI chunk, fail-loud + exactly once ──
  let patchedChunks = 0;
  for (const f of readdirSync(tmp).filter((f) => /^index(-[a-z0-9]+)?\.js$/.test(f))) {
    const p = path.join(tmp, f);
    const src = readFileSync(p, 'utf8');
    if (!src.includes(OPENTUI_FFI_CHUNK_MARKER)) continue;
    const out = nimbusPatchOpenTUI(src, f); // throws if any anchor is missing/ambiguous
    assert.ok(out.length > src.length, `patch produced no growth for ${f}`);
    assert.ok(out.split('__nimbusOpenTUIBackend').length - 1 >= 4, `expected ≥4 registry seams in ${f}`);
    writeFileSync(p, out);
    patchedChunks++;
  }
  assert.equal(patchedChunks, 1, `expected exactly one @opentui FFI chunk, patched ${patchedChunks}`);
  console.log('  [1] @opentui/core FFI chunk patched — 4 init seams applied fail-loud');

  // ── build the wasm backend over the staged Stage A artifact + real WASI host ──
  const prePath = path.join(tmp, '__wasi-preamble.mjs');
  writeFileSync(prePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`);
  const { __wasiInitFS, __wasiMakeImports } = await import(pathToFileURL(prePath).href);
  const workerPublic = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../packages/worker/public',
  );
  const module = new WebAssembly.Module(readFileSync(workerPublic + OPENTUI_WASM_ENTRY));
  const backend = OpenTUIWasmBackend.create({
    module,
    wasi: { makeImports: __wasiMakeImports, initFS: __wasiInitFS },
    env: { TERM: 'xterm-256color' },
  });
  globalThis.__nimbusOpenTUIBackend = backend;

  // ── Check 2: the patched bundle imports (no init throw) + resolveRenderLib ────
  const otui = await import(pathToFileURL(path.join(tmp, 'index.js')).href);
  assert.equal(typeof otui.resolveRenderLib, 'function', 'resolveRenderLib not exported');
  const lib = otui.resolveRenderLib();
  assert.ok(lib, 'resolveRenderLib() returned nullish — backend not wired');
  assert.equal(lib.constructor?.name, 'FFIRenderLib', `expected FFIRenderLib, got ${lib.constructor?.name}`);
  console.log('  [2] patched bundle imported without the FFI-unavailable throw; resolveRenderLib() → FFIRenderLib');

  // ── Check 3: real backend calls round-trip through the patched getOpenTUILib ──
  // FFIRenderLib.opentui is the Library the PATCHED getOpenTUILib() returned —
  // i.e. our backend.dlopen of all 279 symbols. Drive a real call through it
  // (the render-shape proven in opentui-wasm-backend.mjs) to confirm the patched
  // resolution path doesn't just construct, it executes against the wasm core.
  // (FFIRenderLib's own createRenderer wrapper needs the full opencode renderer
  // setup — stdin/stdout/env — which is Stage D, not the wiring contract here.)
  const sym = lib.opentui.symbols;
  assert.ok(sym && typeof sym.createRenderer === 'function', 'patched getOpenTUILib did not resolve symbols');
  const renderer = sym.createRenderer(80, 24, 1 /* memory */, 1 /* local */, null);
  assert.notEqual(Number(renderer), 0, 'createRenderer through the patched lib symbols returned null');
  const frame = sym.getNextBuffer(renderer);
  assert.notEqual(Number(frame), 0, 'getNextBuffer through the patched lib symbols returned null');
  assert.equal(Number(sym.getBufferWidth(frame)), 80, 'buffer width did not round-trip through the backend');
  assert.equal(Number(sym.getBufferHeight(frame)), 24, 'buffer height did not round-trip through the backend');
  console.log('  [3] createRenderer/getNextBuffer/getBufferWidth round-tripped through the patched getOpenTUILib → backend (80×24)');

  console.log(
    `opentui-bundle-wiring OK: patched @opentui/core resolves its FFI render lib ` +
      `to the Nimbus wasm backend (FFIRenderLib, ${Object.getOwnPropertyNames(Object.getPrototypeOf(lib)).length} methods)`,
  );
} finally {
  delete globalThis.__nimbusOpenTUIBackend;
  rmSync(tmp, { recursive: true, force: true });
}
