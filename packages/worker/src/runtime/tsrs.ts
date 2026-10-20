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

import type { FacetImage } from '@nimbus-sh/core/runtime/facet-host.js';
import type { Command } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { OwnPrograms } from '../shell/npm-bin-entrypoints.js';
import { TSRS_TYPESCRIPT_VERSION, TSRS_VERSION, TSRS_WASM_ASSET_PATH, TSRS_WASM_BYTES, TSRS_WASM_SHA256 } from '../tsrs-wasm-artifact.generated.js';
import { fetchStagedBytes, stagedAsset, type StagedSourceEnv } from './staged-source.js';

/**
 * tsc and tsrs as Nimbus's own programs (shell/npm-bin-entrypoints.ts): tsrs
 * when no node_modules/.bin answers the name, and in place of an installed
 * compiler that is a native binary, saying so first. `tsrs(binName)` is the
 * session's tsrs command.
 */
export function tsrsPrograms(tsrs: (binName: string) => Command): OwnPrograms {
  return {
    names: new Set(['tsc', 'tsrs']),
    resolve(name, installed) {
      if (installed === null) return tsrs(name);
      const notice = nativeCompilerNotice(name, installed);
      if (notice === null) return undefined;
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

/** tsrs.wasm, read (and verified against its pin) when a worker is built for it. */
export function tsrsImage(env: StagedSourceEnv): FacetImage {
  return {
    path: TSRS_WASM_ASSET_PATH,
    identity: `sha256:${TSRS_WASM_SHA256}`,
    size: TSRS_WASM_BYTES,
    peak: TSRS_WASM_BYTES,
    read: async () => new Uint8Array(await fetchStagedBytes(env, TSRS_WASM_ASSET)),
  };
}

/** The platform packages whose binary a TypeScript compiler's launcher runs: typescript 7's and npm tsrs's. */
const NATIVE_COMPILER_SHARDS: Readonly<Record<string, string>> = { typescript: '@typescript/typescript-', tsrs: '@tsrs/' };

/**
 * What tsrs says before it runs in place of an installed compiler that is a
 * native binary (`installed`, the package of the bin that answered), or null
 * when the installed one is not.
 */
function nativeCompilerNotice(
  bin: string,
  installed: { name?: string; version?: string; optionalDependencies?: Record<string, string> } | null,
): string | null {
  const shard = installed?.name === undefined ? undefined : NATIVE_COMPILER_SHARDS[installed.name];
  if (shard === undefined || !Object.keys(installed?.optionalDependencies ?? {}).some((name) => name.startsWith(shard))) return null;
  const named = installed!.version === undefined ? installed!.name : `${installed!.name} ${installed!.version}`;
  return `${bin}: ${named} here is a native compiler, which cannot run in Nimbus; `
    + `running tsrs ${TSRS_VERSION} (TypeScript ${TSRS_TYPESCRIPT_VERSION}) instead\n`;
}
