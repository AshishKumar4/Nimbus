import type { EsbuildBuildHost } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import { type StagedSourceEnv } from '../runtime/staged-source.js';
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
 * The build host a Durable Object's builds run on: its build facet, which runs
 * rolldown. The plugin, and with it every file read, stays with the caller.
 */
export declare function rolldownBuildHost(ctx: DurableObjectState, env: unknown): EsbuildBuildHost;
//# sourceMappingURL=build-facet.d.ts.map