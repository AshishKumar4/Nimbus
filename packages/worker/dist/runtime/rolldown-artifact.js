/**
 * rolldown-artifact.ts — the staged single-threaded rolldown binding.
 *
 * rolldown's N-API binding ships as platform `.node` shards plus one wasm
 * build for wasm32-wasip1-threads; a Worker isolate can run neither.
 * scripts/rolldown/build-binding.mjs builds the same binding for plain
 * wasm32-wasip1 (tokio on a current-thread runtime the loader pumps from the
 * event loop, emnapi's non-threaded N-API, Nimbus's WASI filesystem codec),
 * and scripts/bundle-rolldown.mjs stages it under
 * public/_assets/rolldown/<version>/ with every file's SHA-256 pinned.
 *
 * A node process whose closure requires the binding carries three module-map
 * members: the loader (ESM), the wasi trampoline, and the binding itself —
 * by value in a one-shot, by kernel-owned VFS path in a resident process,
 * where a 13 MB member held inline would stay in the coordinator's heap for
 * the process's life. The generated main module registers them on
 * `globalThis.__nimbusStagedBindings`, and node-shims answers the binding's
 * `require` from there (see __loadStagedBinding in node-shims.ts).
 *
 * Every byte is verified against its pinned digest on both cache tiers
 * before it is compiled or evaluated, as for the opencode artifact.
 */
import { ROLLDOWN_ARTIFACT_BUILD_ID, ROLLDOWN_ARTIFACT_VERSION, ROLLDOWN_BINDING_PATH, ROLLDOWN_BINDING_SHA256, ROLLDOWN_LOADER_PATH, ROLLDOWN_LOADER_SHA256, ROLLDOWN_TRAMPOLINE_PATH, ROLLDOWN_TRAMPOLINE_SHA256, } from '../rolldown-artifact.generated.js';
import { fetchStagedBytes } from './staged-source.js';
/** The package name rolldown's JavaScript requires its wasm binding by. */
export const ROLLDOWN_BINDING_PACKAGE = '@rolldown/binding-wasm32-wasi';
/** Module-map names the three members ride under in a node facet. */
export const ROLLDOWN_BINDING_MODULE = 'nimbus-rolldown-binding.wasm';
export const ROLLDOWN_TRAMPOLINE_MODULE = 'nimbus-rolldown-trampoline.wasm';
export const ROLLDOWN_LOADER_MODULE = 'nimbus-rolldown-loader.js';
/**
 * Where a resident process's boot spec names the binding. Kernel-owned and
 * versioned: written once per session, read by path when a facet loads. A
 * copy at full size (ROLLDOWN_BINDING_BYTES) is a complete one: the write
 * only grows the file from offset zero.
 */
export const ROLLDOWN_BINDING_VFS_PATH = `/var/lib/nimbus/staged/rolldown/${ROLLDOWN_ARTIFACT_VERSION}/rolldown-binding.wasm`;
/**
 * Whether a program's closure requires the binding: rolldown's generated
 * loader names the wasm package in a string literal (its WASI candidate), so
 * a closure that holds rolldown holds that literal.
 */
export const ROLLDOWN_BINDING_SPECIFIER_RE = /["']@rolldown\/binding-wasm32-wasi["']/;
export const ROLLDOWN_BINDING_ASSET = { path: ROLLDOWN_BINDING_PATH, sha256: ROLLDOWN_BINDING_SHA256 };
export const ROLLDOWN_TRAMPOLINE_ASSET = { path: ROLLDOWN_TRAMPOLINE_PATH, sha256: ROLLDOWN_TRAMPOLINE_SHA256 };
export const ROLLDOWN_LOADER_ASSET = { path: ROLLDOWN_LOADER_PATH, sha256: ROLLDOWN_LOADER_SHA256 };
/** Fetch one staged file, verified against its pinned digest. */
export function fetchRolldownAsset(env, asset) {
    const { path, sha256 } = asset;
    return fetchStagedBytes(env, {
        path,
        l2Key: `https://nimbus-cache.invalid${path}?build=${ROLLDOWN_ARTIFACT_BUILD_ID}`,
        sha256,
        poisonedCache: 'reject',
        missingBinding: `Nimbus: rolldown's staged binding requires an env.ASSETS binding (serves ${path})`,
        fetchFailed: (res) => `rolldown binding asset fetch failed: ${res.status} ${res.statusText} for ${path} — ` +
            'the deploy is missing the staged artifact (scripts/bundle-rolldown.mjs)',
        integrityFailed: (digest, from) => `rolldown binding asset integrity check failed for ${path}: expected ${sha256}, got ${digest} (${from}) — ` +
            'the staged artifact is corrupt or out of sync; rerun scripts/bundle-rolldown.mjs and redeploy',
    });
}
/**
 * The main-module block that registers the staged binding. It imports the
 * three members and hands node-shims a factory; nothing is instantiated until
 * the program actually requires the binding.
 */
export const ROLLDOWN_FACET_IMPORT = [
    `import __nimbusRolldownBindingWasm from ${JSON.stringify(ROLLDOWN_BINDING_MODULE)};`,
    `import __nimbusRolldownTrampolineWasm from ${JSON.stringify(ROLLDOWN_TRAMPOLINE_MODULE)};`,
    `import { createRolldownBinding as __nimbusCreateRolldownBinding } from ${JSON.stringify(ROLLDOWN_LOADER_MODULE)};`,
    `(globalThis.__nimbusStagedBindings ??= new Map()).set(${JSON.stringify(ROLLDOWN_BINDING_PACKAGE)}, {`,
    `  owner: "rolldown",`,
    `  version: ${JSON.stringify(ROLLDOWN_ARTIFACT_VERSION)},`,
    `  create: (host) => __nimbusCreateRolldownBinding({ ...host, binding: __nimbusRolldownBindingWasm, trampoline: __nimbusRolldownTrampolineWasm }),`,
    `});`,
].join('\n');
