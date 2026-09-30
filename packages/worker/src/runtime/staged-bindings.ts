/**
 * staged-bindings.ts — the staged threadless napi-rs bindings.
 *
 * rolldown, satteri and the Astro compiler ship their N-API bindings as
 * platform `.node` shards plus one wasm build for wasm32-wasip1-threads; a
 * Worker isolate can run neither. scripts/napi-wasm/build.mjs builds each for
 * plain wasm32-wasip1 (emnapi's non-threaded N-API, Nimbus's WASI filesystem
 * codec, and for rolldown a tokio current-thread runtime the loader pumps from
 * the event loop), and scripts/bundle-napi-wasm.mjs stages them under
 * public/_assets/napi-wasm/ with every file's SHA-256 pinned.
 *
 * A node process whose closure requires any of them carries the shared loader
 * (ESM), the shared wasi trampoline, and each binding it requires: by value in
 * a one-shot, by kernel-owned VFS path in a resident process, where a
 * multi-megabyte member held inline would stay in the coordinator's heap for
 * the process's life. The generated main module registers each binding on
 * `globalThis.__nimbusStagedBindings` under every package name its owner
 * requires it by, and node-shims answers that `require` from there (see
 * __loadStagedBinding in node-shims.ts).
 *
 * Every byte is verified against its pinned digest on both cache tiers
 * before it is compiled or evaluated, as for the opencode artifact.
 */

import {
  NAPI_WASM_BUILD_ID,
  NAPI_WASM_LOADER,
  NAPI_WASM_TRAMPOLINE,
  STAGED_BINDING_ARTIFACTS,
  type NapiWasmAsset,
  type StagedBindingArtifact,
} from '../napi-wasm-artifacts.generated.js';
import { fetchStagedBytes, type StagedSourceEnv } from './staged-source.js';

export { NAPI_WASM_LOADER, NAPI_WASM_TRAMPOLINE, type NapiWasmAsset };

/** Module-map names of the members every launch with a staged binding carries. */
export const STAGED_BINDING_LOADER_MODULE = 'nimbus-napi-wasm-loader.js';
export const STAGED_BINDING_TRAMPOLINE_MODULE = 'nimbus-napi-wasm-trampoline.wasm';

export interface StagedBinding extends StagedBindingArtifact {
  /** The binding's module-map name in a node facet. */
  readonly moduleName: string;
  /**
   * Where a resident process's boot spec names the binding. Kernel-owned and
   * versioned: written once per session, read by path when a facet loads. A
   * copy at full size (`wasm.bytes`) is a complete one: the write only grows
   * the file from offset zero.
   */
  readonly vfsPath: string;
  /**
   * Whether a program's closure requires the binding: its owner's generated
   * napi-rs loader names each wasm package in a string literal (its WASI
   * candidate), so a closure that holds the owner holds that literal.
   */
  readonly specifier: RegExp;
}

const quoted = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export const STAGED_BINDINGS: readonly StagedBinding[] = STAGED_BINDING_ARTIFACTS.map((artifact) => ({
  ...artifact,
  moduleName: `nimbus-staged-${artifact.name}.wasm`,
  vfsPath: `/var/lib/nimbus/staged/${artifact.name}/${artifact.version}/${artifact.name}.wasm`,
  specifier: new RegExp(`["'](?:${artifact.requiredAs.map(quoted).join('|')})["']`),
}));

/** The staged binding named `name`; a name no build produced is a programming error. */
export function stagedBinding(name: string): StagedBinding {
  const binding = STAGED_BINDINGS.find((b) => b.name === name);
  if (!binding) throw new Error(`Nimbus: no staged napi binding named ${name}`);
  return binding;
}

/** Names of the staged bindings a closure requires, in table order. */
export function stagedBindingsRequiredBy(cells: Iterable<readonly [string, unknown]>): string[] {
  const required = new Set<string>();
  for (const [path, cell] of cells) {
    if (typeof cell !== 'string') continue;
    if (!(path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))) continue;
    for (const binding of STAGED_BINDINGS) {
      if (!required.has(binding.name) && binding.specifier.test(cell)) required.add(binding.name);
    }
    if (required.size === STAGED_BINDINGS.length) break;
  }
  return STAGED_BINDINGS.filter((b) => required.has(b.name)).map((b) => b.name);
}

/** Fetch one staged file, verified against its pinned digest. */
export function fetchStagedBindingAsset(env: StagedSourceEnv, asset: NapiWasmAsset): Promise<ArrayBuffer> {
  const { path, sha256 } = asset;
  return fetchStagedBytes(env, {
    path,
    l2Key: `https://nimbus-cache.invalid${path}?build=${NAPI_WASM_BUILD_ID}`,
    sha256,
    poisonedCache: 'reject',
    missingBinding: `Nimbus: staged napi bindings require an env.ASSETS binding (serves ${path})`,
    fetchFailed: (res) =>
      `staged napi binding asset fetch failed: ${res.status} ${res.statusText} for ${path}: ` +
      'the deploy is missing the staged artifact (scripts/bundle-napi-wasm.mjs)',
    integrityFailed: (digest, from) =>
      `staged napi binding asset integrity check failed for ${path}: expected ${sha256}, got ${digest} (${from}); ` +
      'the staged artifact is corrupt or out of sync; rerun scripts/bundle-napi-wasm.mjs and redeploy',
  });
}

/**
 * The main-module block that registers `names`. It imports the shared loader
 * and trampoline and each binding, and hands node-shims one factory per
 * binding, registered under every package name it is required by; nothing is
 * instantiated until the program actually requires it.
 */
export function stagedBindingsFacetImport(names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return '';
  const lines = [
    `import { createNapiWasmBinding as __nimbusCreateNapiWasmBinding } from ${JSON.stringify(STAGED_BINDING_LOADER_MODULE)};`,
    `import __nimbusNapiWasmTrampoline from ${JSON.stringify(STAGED_BINDING_TRAMPOLINE_MODULE)};`,
    `const __nimbusStagedBindingRegistry = (globalThis.__nimbusStagedBindings ??= new Map());`,
  ];
  names.forEach((name, i) => {
    const binding = stagedBinding(name);
    const module = `__nimbusStagedBinding${i}`;
    lines.push(
      `import ${module} from ${JSON.stringify(binding.moduleName)};`,
      `{`,
      `  const entry = {`,
      `    owner: ${JSON.stringify(binding.owner)},`,
      `    version: ${JSON.stringify(binding.version)},`,
      `    create: (host) => __nimbusCreateNapiWasmBinding({ ...host, binding: ${module}, trampoline: __nimbusNapiWasmTrampoline, memoryPages: ${binding.memoryPages}, name: ${JSON.stringify(binding.name)} }),`,
      `  };`,
      ...binding.requiredAs.map((id) => `  __nimbusStagedBindingRegistry.set(${JSON.stringify(id)}, entry);`),
      `}`,
    );
  });
  return lines.join('\n');
}
