import { EsbuildService, type EsbuildTransformHost } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { type EsbuildCliArgs, type EsbuildCliOutput } from '@nimbus-sh/core/runtime/esbuild-cli.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
export declare const ESBUILD_FACET_WORKER_ID: string;
/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), spliced in so the
 * facet evaluates it at startup, the one moment it may.
 */
export declare function esbuildFacetWorkerCode(wasmBytes: ArrayBuffer, jsFnBody: string): WorkerCode;
/** The transform host a Durable Object's esbuild runs its transforms on: its esbuild facet. */
export declare function esbuildTransformHost(ctx: DurableObjectState, env: unknown): EsbuildTransformHost;
/**
 * Runs one `esbuild` command in the Durable Object's esbuild facet, as
 * process `pid`: its files go through a supervisor capability minted for that
 * pid, the one IsolatePool mints for a facet, and its stdout and stderr come
 * back through `output` as esbuild writes them. Resolves to its exit status.
 */
export declare function runEsbuildCli(ctx: DurableObjectState, env: unknown, pid: number, args: EsbuildCliArgs, output: EsbuildCliOutput): Promise<number>;
/**
 * The esbuild a Durable Object's supervisor shares: build() runs in its
 * isolate over `vfs`, every transform in its esbuild facet.
 */
export declare function supervisorEsbuildService(ctx: DurableObjectState, env: unknown, vfs: CredentialedVfs): EsbuildService;
//# sourceMappingURL=esbuild-transform.d.ts.map