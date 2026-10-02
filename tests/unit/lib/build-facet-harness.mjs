// The build facet as production loads it, evaluated in this process.
//
// `buildFacetWorkerCode` over the staged parts (the napi-rs loader, the wasi
// trampoline, the threadless rolldown binding and the facet's runtime, read
// from public/_assets and verified like a deploy's) is the facet module; the
// harness binds its module-map imports to the same members and counts the
// rolldown instances it creates. `durableObject` is a Durable Object as
// build-facet.ts sees it (`env.LOADER`, `ctx.facets`).

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFacetWorkerCode } from '../../../packages/worker/src/facets/build-facet.ts';
import { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, STAGED_BINDING_ARTIFACTS } from '../../../packages/worker/src/napi-wasm-artifacts.generated.ts';
import { ROLLDOWN_FACET_ASSET_PATH, ROLLDOWN_FACET_SHA256 } from '../../../packages/worker/src/rolldown-facet-artifact.generated.ts';

const staged = (asset) => {
  const bytes = readFileSync(new URL(`../../../packages/worker/public${asset.path}`, import.meta.url));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) throw new Error(`build-facet-harness: ${asset.path} is not the staged artifact (${digest})`);
  return bytes;
};
const rolldownArtifact = STAGED_BINDING_ARTIFACTS.find((b) => b.name === 'rolldown');
export const parts = {
  loader: staged(NAPI_WASM_LOADER).toString('utf8'),
  trampoline: staged(NAPI_WASM_TRAMPOLINE),
  rolldown: staged(rolldownArtifact.wasm),
  runtime: staged({ path: ROLLDOWN_FACET_ASSET_PATH, sha256: ROLLDOWN_FACET_SHA256 }).toString('utf8'),
};

/** Every rolldown memory the facet's binding created, and its size now. */
export const memories = [];
const NativeMemory = WebAssembly.Memory;

let copy = 0;
/** A fresh evaluation of the facet module: its own binding, created by its first build. */
export async function freshFacetClass() {
  const code = buildFacetWorkerCode(parts);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'build-facet-'));
  const loaderFile = join(dir, 'napi-wasm-loader.mjs');
  const runtimeFile = join(dir, 'rolldown-runtime.mjs');
  writeFileSync(loaderFile, code.modules['napi-wasm-loader.js']);
  writeFileSync(runtimeFile, code.modules['rolldown-runtime.js']);
  globalThis.__buildFacetImports = {
    DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
    rolldownWasm: await WebAssembly.compile(code.modules['rolldown.wasm'].wasm),
    trampolineWasm: await WebAssembly.compile(code.modules['trampoline.wasm'].wasm),
  };
  const source = code.modules['worker.js']
    .replace('import { DurableObject } from "cloudflare:workers";', 'const { DurableObject, rolldownWasm, trampolineWasm } = globalThis.__buildFacetImports;')
    .replace('import { createNapiWasmBinding } from "napi-wasm-loader.js";', `import { createNapiWasmBinding } from ${JSON.stringify(loaderFile)};`)
    .replace('import rolldownWasm from "rolldown.wasm";', '')
    .replace('import trampolineWasm from "trampoline.wasm";', '')
    .replace('import("rolldown-runtime.js")', `import(${JSON.stringify(runtimeFile)})`)
    .concat(`\n// copy ${++copy}`);
  if (/^import .* from "(cloudflare:|napi|rolldown|trampoline)/m.test(source)) throw new Error('build-facet-harness: a module-map import is still unbound');
  const facetFile = join(dir, 'worker.mjs');
  writeFileSync(facetFile, source);
  WebAssembly.Memory = class extends NativeMemory { constructor(d) { super(d); memories.push(this); } };
  try {
    return { BuildFacet: (await import(facetFile)).BuildFacet, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } finally {
    WebAssembly.Memory = NativeMemory;
  }
}

/** A Durable Object as build-facet.ts sees it; `counts` says what it was asked for. */
export function durableObject(BuildFacet) {
  const counts = { loaderGets: 0, facetInstances: 0 };
  const facets = new Map();
  const ctx = {
    id: { toString: () => 'build-facet-do' },
    facets: {
      get(name, load) {
        if (!facets.has(name)) facets.set(name, load().then(({ class: FacetClass }) => { counts.facetInstances++; return new FacetClass({}, {}); }));
        const instance = facets.get(name);
        return {
          build: async (options, plugin) => {
            // While the facet runs, its own memories are counted: the binding's is created on the first build.
            WebAssembly.Memory = class extends NativeMemory { constructor(d) { super(d); memories.push(this); } };
            try {
              return structuredClone(await (await instance).build(structuredClone(options), plugin));
            } finally {
              WebAssembly.Memory = NativeMemory;
            }
          },
        };
      },
    },
  };
  const env = {
    ASSETS: { async fetch() { throw new Error('the worker is handed out by LOADER.get below'); } },
    LOADER: { async get() { counts.loaderGets++; return { getDurableObjectClass: () => BuildFacet }; } },
  };
  return { ctx, env, counts };
}

export function releaseBuildFacetHarness() {
  delete globalThis.__buildFacetImports;
  WebAssembly.Memory = NativeMemory;
}
