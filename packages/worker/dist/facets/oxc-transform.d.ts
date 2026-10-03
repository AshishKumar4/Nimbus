import { type EsbuildTransformHost } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
export declare const OXC_FACET_WORKER_ID: string;
/**
 * Slim Worker Loader module whose DO class owns the Oxc wasm. `wasm` is the
 * staged module's verified bytes, compiled by the loader at startup; `runtime`
 * is the facet's staged runtime script.
 */
export declare function oxcFacetWorkerCode(wasm: ArrayBuffer, runtime: string): WorkerCode;
/**
 * The transform host a Durable Object's transforms run on: its transform
 * facet, a slice per call. Transforms are pure, so a slice whose call failed
 * (the facet reset, the connection dropped) is sent once more, to a freshly
 * minted stub; an overloaded facet is not asked again. A slice that still
 * fails answers each of its requests with a transient error, which is no
 * verdict on the source, and the other slices keep their answers.
 *
 * A module whose outcome says Oxc ran out of native stack on it
 * (`stackExhausted`, set by the driver from the RangeError, never read off
 * message text) goes to `stackFallback`, the esbuild facet in production:
 * every such module, in calls of at most STACK_FALLBACK_MODULES, each with a
 * deadline, each module logged. Its answer stands; the modules of a call that
 * fails or misses its deadline answer transient. Without a fallback the
 * exhaustion stands.
 */
export declare function oxcTransformHost(ctx: DurableObjectState, env: unknown, stackFallback?: EsbuildTransformHost, { fallbackDeadlineMs }?: {
    fallbackDeadlineMs?: number;
}): EsbuildTransformHost;
//# sourceMappingURL=oxc-transform.d.ts.map