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
/**
 * tsc and tsrs as Nimbus's own programs (shell/npm-bin-entrypoints.ts): tsrs
 * when no node_modules/.bin answers the name, and in place of an installed
 * compiler that is a native binary, saying so first. `tsrs(binName)` is the
 * session's tsrs command.
 */
export declare function tsrsPrograms(tsrs: (binName: string) => Command): OwnPrograms;
/** tsrs.wasm, read from `env`'s ASSETS (and verified against its pin) when a worker is built for it. */
export declare function tsrsImage(env: unknown): FacetImage;
//# sourceMappingURL=tsrs.d.ts.map