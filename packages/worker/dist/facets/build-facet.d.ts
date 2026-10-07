import type { EsbuildBuildHost } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { type StagedSourceEnv } from '../runtime/staged-source.js';
import type { PrebundleResult, PrebundleSpec } from '@nimbus-sh/core/runtime/prebundle-slice.js';
export declare const BUILD_FACET_WORKER_ID: string;
/** The staged parts of the build facet, each verified against its pinned digest. */
export interface BuildFacetParts {
    loader: string;
    trampoline: ArrayBuffer;
    rolldown: ArrayBuffer;
    runtime: string;
}
export declare function fetchBuildFacetParts(env: StagedSourceEnv): Promise<BuildFacetParts>;
/** The build facet's Worker Loader module: the class that owns rolldown, and its staged parts. */
export declare function buildFacetWorkerCode(parts: BuildFacetParts): WorkerCode;
/**
 * Loads the Durable Object's build facet ahead of its first build: the staged
 * parts fetched and verified, the binding instantiated and rolldown's
 * JavaScript evaluated, which a fresh session's first build would otherwise
 * wait on (a 13 MiB binding), while `wrangler dev` reads its config. (A
 * warm-up as `vite build` starts measured no gain: that build's first
 * seconds go to resolving through the VFS plugin.) Best effort: a failed
 * warm-up only drops the stub, as a failed call does.
 */
export declare function prewarmBuildFacet(ctx: DurableObjectState, env: unknown): void;
/**
 * The build host a Durable Object's builds run on: its build facet, which runs
 * rolldown. The plugin, and with it every file read, stays with the caller.
 *
 * A build whose binding died under it (`crashed`: a trap, or a module nested
 * past the stack) retires that generation: the next build mints a fresh
 * isolate. The build itself, and every other one that was in flight on that
 * binding, goes to `fallback` (the esbuild facet in production), each logged;
 * without one, its failure says what happened.
 */
export declare function rolldownBuildHost(ctx: DurableObjectState, env: unknown, fallback?: EsbuildBuildHost): EsbuildBuildHost;
/** A pre-bundle whose build facet was reset under it twice: the call and its one retry. */
export declare class BuildFacetResetError extends Error {
    readonly specifier: string;
    readonly reason: string;
    constructor(specifier: string, reason: string);
}
/**
 * Pre-bundles one npm specifier from its slice in the Durable Object's build
 * facet (core runtime/prebundle-slice.ts on rolldown): the slice crosses
 * once, with the call, and the bundle comes back. A failed pre-bundle is a
 * result (`ok: false`), as is one whose binding died under it, which also
 * retires that generation.
 *
 * A call that throws (the facet's isolate reset under it: past its memory,
 * or its host gone) drops the stub, and the pre-bundle, which is pure, runs
 * once more on a fresh facet, logged. A second throw is a
 * BuildFacetResetError naming the package and why; a facet that never
 * loaded is the load's own error, not retried.
 */
export declare function buildFacetPrebundler(ctx: DurableObjectState, env: unknown): (spec: PrebundleSpec) => Promise<PrebundleResult>;
/**
 * Loads the Durable Object's build facet and waits for it: the staged parts
 * fetched and verified, the binding instantiated. What prewarmBuildFacet
 * starts, for a caller that wants the load behind it before it allocates
 * (a pre-bundle's slice). Rejects as the load does.
 */
export declare function loadBuildFacet(ctx: DurableObjectState, env: unknown): Promise<void>;
//# sourceMappingURL=build-facet.d.ts.map