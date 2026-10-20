/**
 * tsrs.ts — Nimbus's `tsc`: tsrs, the Rust port of the TypeScript compiler,
 * built to wasm (@tsrs/wasm, pinned and staged by scripts/bundle-tsrs-wasm.mjs).
 *
 * It answers `tsc` and `tsrs` when no node_modules/.bin from the cwd up
 * does (shell/npm-bin-entrypoints.ts), so a project's own TypeScript runs as
 * the project pinned it. A TypeScript whose compiler is a native binary
 * (typescript 7, npm tsrs) cannot run here, so tsrs runs in its place and
 * says which compiler it is.
 */
import { MEMORY_LIMIT_GROWTH_BYTES, withMemoryLimit } from '@nimbus-sh/core/runtime/wasm-memory.js';
import { WASI_RESIDENT_STORE_BYTES } from '@nimbus-sh/platform/limits.js';
import { TSRS_TYPESCRIPT_VERSION, TSRS_VERSION, TSRS_WASM_ASSET_PATH, TSRS_WASM_BYTES, TSRS_WASM_SHA256 } from '../tsrs-wasm-artifact.generated.js';
import { fetchStagedBytes, stagedAsset } from './staged-source.js';
/**
 * tsc and tsrs as Nimbus's own programs (shell/npm-bin-entrypoints.ts): tsrs
 * when no node_modules/.bin answers the name, and in place of an installed
 * compiler that is a native binary, saying so first. `tsrs(binName)` is the
 * session's tsrs command.
 */
export function tsrsPrograms(tsrs) {
    return {
        names: new Set(['tsc', 'tsrs']),
        absent: tsrs,
        inPlaceOf(name, installed) {
            const notice = nativeCompilerNotice(name, installed);
            if (notice === null)
                return undefined;
            return async (ctx) => {
                ctx.stderr.write(notice);
                return await tsrs(name)(ctx);
            };
        },
    };
}
const TSRS_WASM_ASSET = stagedAsset({
    label: 'tsrs wasm', path: TSRS_WASM_ASSET_PATH, l2Key: `https://nimbus-cache.invalid${TSRS_WASM_ASSET_PATH}`,
    sha256: TSRS_WASM_SHA256, contentType: 'application/wasm',
    requiredBy: 'tsc', stagedBy: 'scripts/bundle-tsrs-wasm.mjs',
});
/**
 * The most linear memory tsrs may grow to: past it, its allocator fails and
 * the run ends as tsc's crash (exit 5, "out of memory"), its writes settled;
 * without it, the worker is killed and what it last wrote may be lost.
 *
 * What a Loader worker can hold, less what else a tsrs worker holds: its
 * resident store at most WASI_RESIDENT_STORE_BYTES, and 28 MiB of its own
 * (module code, heap, buffers). Both measured on throwaway Previews
 * (2026-10-20): a worker dies at about 254 MiB in all (file-engine
 * measurements), and a reused tsrs worker whose store held next to nothing
 * died as its linear memory grew past 225-226 MiB (n=4), so 28 MiB is its
 * own. Rounded down to a 16 MiB step: 192 MiB with today's 32 MiB store. A
 * react-ts build peaks at 134 MiB, a 310-file check at 111.
 */
const MiB = 1024 * 1024;
const TSRS_MEMORY_LIMIT_BYTES = Math.floor((254 * MiB - 28 * MiB - WASI_RESIDENT_STORE_BYTES) / (16 * MiB)) * 16 * MiB;
/** tsrs.wasm, read from `env`'s ASSETS (and verified against its pin) when a worker is built for it, its memory bounded. */
export function tsrsImage(env) {
    const assets = { ASSETS: Reflect.get(Object(env), 'ASSETS') };
    return {
        path: TSRS_WASM_ASSET_PATH,
        identity: `sha256:${TSRS_WASM_SHA256}:max-memory-${TSRS_MEMORY_LIMIT_BYTES}`,
        size: TSRS_WASM_BYTES + MEMORY_LIMIT_GROWTH_BYTES,
        // The fetched bytes and the bounded copy made from them.
        peak: 2 * TSRS_WASM_BYTES + MEMORY_LIMIT_GROWTH_BYTES,
        read: async () => withMemoryLimit(new Uint8Array(await fetchStagedBytes(assets, TSRS_WASM_ASSET)), TSRS_MEMORY_LIMIT_BYTES),
    };
}
/** The platform packages whose binary a TypeScript compiler's launcher runs: typescript 7's and npm tsrs's. */
const NATIVE_COMPILER_SHARDS = { typescript: '@typescript/typescript-', tsrs: '@tsrs/' };
/**
 * What tsrs says before it runs in place of an installed compiler that is a
 * native binary (`installed`, the package of the bin that answered), or null
 * when the installed one is not.
 */
function nativeCompilerNotice(bin, installed) {
    const shard = installed.name === undefined ? undefined : NATIVE_COMPILER_SHARDS[installed.name];
    if (shard === undefined || !Object.keys(installed.optionalDependencies ?? {}).some((name) => name.startsWith(shard)))
        return null;
    const named = installed.version === undefined ? installed.name : `${installed.name} ${installed.version}`;
    return `${bin}: ${named} here is a native compiler, which cannot run in Nimbus; `
        + `running tsrs ${TSRS_VERSION} (TypeScript ${TSRS_TYPESCRIPT_VERSION}) instead\n`;
}
