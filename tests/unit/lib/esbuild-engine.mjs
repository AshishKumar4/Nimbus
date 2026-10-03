// esbuild-wasm 0.24.2, initialized in this process: the engine a test hands
// EsbuildService (EsbuildServiceOptions.engine) to run its builds and
// transforms in the test's own isolate as esbuild runs them. Nimbus itself
// never does: its builds and transforms go to facets.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const fromCore = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
let loaded = null;

/** The engine, loaded and initialized once per process. */
export function esbuildEngine() {
  loaded ??= (async () => {
    globalThis.self ??= globalThis;
    const esbuild = await import(fromCore.resolve('esbuild-wasm/esm/browser.js'));
    await esbuild.initialize({ wasmModule: await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm'))), worker: false });
    return esbuild;
  })();
  return loaded;
}

/** Stop the engine's Go runtime, so the process can exit. */
export async function stopEsbuildEngine() {
  if (loaded) (await loaded).stop();
}
