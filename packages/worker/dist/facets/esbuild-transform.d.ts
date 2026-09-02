import { type EsbuildTransformOptions, type TransformResult } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { DurableObject } from 'cloudflare:workers';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
export declare const ESBUILD_TRANSFORM_WORKER_ID: string;
export type EsbuildTransformFacetRpc = DurableObject & {
    transform(code: string, options: EsbuildTransformOptions): Promise<TransformResult>;
};
/** Slim Worker Loader module whose DO class owns the esbuild wasm heap. */
export declare function esbuildTransformWorkerCode(wasmBytes: ArrayBuffer): WorkerCode;
//# sourceMappingURL=esbuild-transform.d.ts.map