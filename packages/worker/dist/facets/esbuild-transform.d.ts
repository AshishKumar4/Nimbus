import { EsbuildService, type EsbuildTransformHost, type EsbuildTransformOutcome, type EsbuildTransformRequest } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
export declare const ESBUILD_TRANSFORM_WORKER_ID: string;
export type EsbuildTransformFacetRpc = DurableObject & {
    transformMany(requests: EsbuildTransformRequest[]): Promise<EsbuildTransformOutcome[]>;
};
/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm heap.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), spliced in so
 * the facet evaluates it at startup, the one moment it may.
 */
export declare function esbuildTransformWorkerCode(wasmBytes: ArrayBuffer, jsFnBody: string): WorkerCode;
/**
 * The transform host a Durable Object's esbuild runs its transforms on: a
 * loader-backed facet of that object which owns the esbuild wasm heap, so
 * the object's own isolate never instantiates it. Needs `env.LOADER`,
 * `env.ASSETS` and `ctx.facets`, and nothing of any host.
 */
export declare function esbuildTransformHost(ctx: DurableObjectState, env: unknown): EsbuildTransformHost;
/**
 * The esbuild a Durable Object's supervisor shares: build() runs in its
 * isolate over `vfs`, every transform in its transform facet.
 */
export declare function supervisorEsbuildService(ctx: DurableObjectState, env: unknown, vfs: CredentialedVfs): EsbuildService;
//# sourceMappingURL=esbuild-transform.d.ts.map