#!/usr/bin/env bun
// A kept esbuild keeps nothing of what it transformed.
//
// The transform facet serves a session's transforms from one esbuild
// (keepEsbuild), which a Vite preview's traffic never takes past the memory
// that would retire it; and esbuild's adapter holds every call's promise, and
// so its result, for as long as its instance lives. 120 transforms of a 190
// KiB module through keepEsbuild and startObservedEsbuild, with the real
// esbuild, must leave the JS heap less than a quarter of their output bigger
// once it is collected (held, their results were 19.2 of 23.1 MiB).
//
// Bun's heap statistics report freed string memory lazily, so the measurement
// runs under Node, where a forced collection settles the heap.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (typeof Bun !== 'undefined') {
  const node = spawnSync('node', ['--expose-gc', '--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(node.status ?? 1);
}

const { keepEsbuild, startObservedEsbuild } = await import('../../packages/core/src/runtime/keep-esbuild.ts');
const { ESBUILD_JS_ASSET_PATH } = await import('../../packages/worker/src/esbuild-wasm-bundle.generated.ts');

const MiB = 1024 * 1024;
// esbuild's browser adapter runs Go on `self`, as workerd has it; Node has not.
globalThis.self ??= globalThis;
const corePackage = new URL('../../packages/core/package.json', import.meta.url);
const adapter = new Function('WebAssembly', await readFile(new URL(`../../packages/worker/public${ESBUILD_JS_ASSET_PATH}`, import.meta.url), 'utf8'));
const newEsbuild = (webAssembly = WebAssembly) => adapter(webAssembly);
const wasmModule = await WebAssembly.compile(await readFile(createRequire(corePackage).resolve('esbuild-wasm/esbuild.wasm')));
const withEsbuild = keepEsbuild(() => startObservedEsbuild(newEsbuild, wasmModule), 1024 * MiB);

const module = Array.from({ length: 1800 }, (_, i) => `export function f${i}(a, b) { const t = { x: a, y: b, z: [${i}, a + b] }; return t.x * ${i} + t.y + t.z[1]; }\n`).join('');
const transform = (tag) => withEsbuild((esbuild) => esbuild.transform(`${module}// ${tag}\n`, { loader: 'js' }));
async function collect() {
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalThis.gc();
  }
}

// What the instance keeps once (its buffers, its compiled code) grows first.
for (let i = 0; i < 20; i++) await transform(`warm ${i}`);
await collect();
const before = process.memoryUsage().heapUsed;
let output = 0;
for (let i = 0; i < 120; i++) output += (await transform(i)).code.length;
await collect();
const retained = process.memoryUsage().heapUsed - before;

assert.ok(output > 20 * MiB, `the transforms put out ${(output / MiB).toFixed(1)} MiB`);
assert.ok(retained < output / 4,
  `the kept esbuild left ${(retained / MiB).toFixed(1)} MiB of ${(output / MiB).toFixed(1)} MiB of output on the heap`);
console.log(`keep-esbuild-heap OK: ${(output / MiB).toFixed(1)} MiB of output left ${(retained / MiB).toFixed(1)} MiB on the heap`);
