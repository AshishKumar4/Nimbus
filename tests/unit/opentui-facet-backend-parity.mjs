#!/usr/bin/env bun
// Parity test for the facet-injected OpenTUI backend. OPENTUI_BACKEND_FACET_SRC
// is single-sourced from the TS OpenTUIWasmBackend via .toString() (plus its
// module-scope helpers); this test evaluates that facet source — exactly as the
// opencode runner injects it into the worker — constructs the backend over the
// staged Stage A artifact, and drives the backend contract through it. If the
// serialized form ever fails to reproduce the TS class's behavior (a broken
// .toString(), a missing helper, a renamed dependency), this fails loudly.
// Mirrors tests/unit/package-abi-policy.mjs (preamble-vs-source parity).

import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  OPENTUI_BACKEND_FACET_SRC,
} from '../../packages/worker/src/runtime/opentui-facet-backend.ts';
import { OPENTUI_WASM_ENTRY } from '../../packages/worker/src/opentui-wasm-artifact.generated.ts';
import { ZIG_FFI_SYMBOLS } from './opentui-zig-symbols.mjs';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/worker',
);
const module = new WebAssembly.Module(
  readFileSync(path.join(workerRoot, 'public', OPENTUI_WASM_ENTRY.slice(1))),
);

// Evaluate the facet source the way the runner does: the WASI preamble + the
// serialized backend class become module locals. Export the class + WASI host
// helpers so we can construct exactly as generateOpenTUIBackendBootCode() does.
// Bundled-shape guards. This test loads UN-bundled TS, but in the deployed
// worker esbuild (keepNames) compiles the serialized helpers/class to reference
// `__name` and emits the class as `var X = class _X {…}` (so `.toString()` is a
// bare class expression). The injected source must therefore (a) declare the
// `__name`/`__defProp` helpers and (b) bind the class to `OpenTUIWasmBackend`
// explicitly — otherwise the facet dies with `__name is not defined` /
// `OpenTUIWasmBackend is not defined` only once deployed. Guard both here.
assert.match(OPENTUI_BACKEND_FACET_SRC, /\bconst __name =/, 'facet src must declare the esbuild __name helper');
assert.match(OPENTUI_BACKEND_FACET_SRC, /\bconst OpenTUIWasmBackend =/, 'facet src must bind the class to OpenTUIWasmBackend explicitly (esbuild renames the class expression)');

const facetModuleSrc = `${OPENTUI_BACKEND_FACET_SRC}
export { OpenTUIWasmBackend, __wasiMakeImports, __wasiInitFS };`;
const facetPath = path.join(os.tmpdir(), `opentui-facet-parity-${process.pid}.mjs`);
writeFileSync(facetPath, facetModuleSrc);
let facet;
try {
  facet = await import(pathToFileURL(facetPath).href);
} finally {
  rmSync(facetPath, { force: true });
}

assert.equal(typeof facet.OpenTUIWasmBackend, 'function', 'facet source did not yield OpenTUIWasmBackend');
console.log('opentui-facet-backend-parity — facet source evaluated; OpenTUIWasmBackend reconstructed');

// Construct exactly as the runner boot code does (module + WASI host + env).
const backend = facet.OpenTUIWasmBackend.create({
  module,
  wasi: { makeImports: (o) => facet.__wasiMakeImports(o), initFS: (o) => facet.__wasiInitFS(o) },
  env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});

// ── Parity 1: dlopen resolves the full 279-symbol surface ────────────────────
const lib = backend.dlopen('opentui.wasm', ZIG_FFI_SYMBOLS);
const names = Object.keys(ZIG_FFI_SYMBOLS);
for (const name of names) {
  assert.equal(typeof lib.symbols[name], 'function', `facet backend failed to resolve '${name}'`);
}
const s = lib.symbols;
console.log(`  [1] facet backend dlopen resolved all ${names.length} symbols`);

// ── Parity 2: arena copy-in + live view round-trip (marshaling behaves) ───────
const encoder = new TextEncoder();
const whiteFg = new Uint16Array([65535, 65535, 65535, 65535]);
const renderer = s.createRenderer(80, 24, 1 /* memory */, 1 /* local */, null);
assert.notEqual(Number(renderer), 0, 'facet backend createRenderer failed');
const frame = s.getNextBuffer(renderer);
const text = encoder.encode('hello facet');
s.bufferDrawText(frame, text, text.length, 2, 1, backend.ptr(whiteFg.buffer), 0, 0);

const size = 80 * 24;
const charView = backend.liveView(Uint32Array, s.bufferGetCharPtr(frame), size);
let drawn = '';
for (let i = 0; i < size; i++) {
  const cp = charView[i] & 0x1fffff;
  if (cp >= 32) drawn += String.fromCodePoint(cp);
}
drawn = drawn.replace(/ +/g, ' ').trim();
assert.ok(drawn.includes('hello facet'), `facet backend draw/liveView lost data: ${JSON.stringify(drawn)}`);
console.log('  [2] facet backend arena copy-in + liveView round-tripped the drawn text');

// ── Parity 3: span-feed render produces ANSI through the 3 token callbacks ────
const streamEvents = [];
const streamCb = lib.createCallback(
  (streamPtr, eventId, arg0, arg1) => streamEvents.push({ eventId, arg0, arg1 }),
  { args: ['ptr', 'u32', 'ptr', 'u64'], returns: 'void' },
);
const feed = s.createNativeSpanFeed(null);
s.streamSetCallback(feed, streamCb.ptr);
assert.equal(Number(s.attachNativeSpanFeed(feed)), 0);
const feedRenderer = s.createRenderer(40, 10, 0 /* span-feed */, 1, feed);
const feedFrame = s.getNextBuffer(feedRenderer);
s.bufferDrawText(feedFrame, text, text.length, 0, 0, backend.ptr(whiteFg.buffer), 0, 0);
assert.equal(Number(s.render(feedRenderer, 1)), 0);
const decoder = new TextDecoder();
const ansi = streamEvents
  .filter((e) => e.eventId === 2 /* ChunkAdded */)
  .map((c) => decoder.decode(backend.toArrayBuffer(c.arg0, 0, Number(c.arg1))))
  .join('');
assert.ok(ansi.includes('\x1b['), 'facet backend span feed produced no ANSI escapes');
assert.ok(ansi.includes('hello facet'), 'facet backend span feed missing the drawn text');
lib.close();
console.log(`  [3] facet backend span-feed render produced ${ansi.length} ANSI bytes with the drawn text`);

console.log('opentui-facet-backend-parity OK: the .toString()-serialized facet backend ' +
  'matches the TS OpenTUIWasmBackend behavior (dlopen, arena, liveView, callbacks, render)');
