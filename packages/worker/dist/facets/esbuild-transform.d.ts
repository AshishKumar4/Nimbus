import { EsbuildService, type EsbuildBuildHost, type EsbuildTransformHost } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { type EsbuildCliArgs, type EsbuildCliOutput } from '@nimbus-sh/core/runtime/esbuild-cli.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
export declare const ESBUILD_FACET_WORKER_ID: string;
/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), compiled into a
 * factory at startup, the one moment code may be generated from a string;
 * each call of the factory is a separate esbuild.
 */
export declare function esbuildFacetWorkerCode(wasmBytes: ArrayBuffer, jsFnBody: string): WorkerCode;
/**
 * The transform host a Durable Object's esbuild runs its transforms on: its
 * esbuild facet, a slice per call. Transforms are pure, so a slice whose call
 * failed (the facet reset, the connection dropped) is sent once more, to a
 * freshly minted stub; an overloaded facet is not asked again. A slice that
 * still fails answers each of its requests with a transient error, which is
 * no verdict on the source, and the other slices keep their answers.
 */
export declare function esbuildTransformHost(ctx: DurableObjectState, env: unknown): EsbuildTransformHost;
/**
 * The build host a Durable Object's esbuild runs its builds on: its esbuild
 * facet. The plugin, and with it every file read, stays with the caller.
 */
export declare function esbuildBuildHost(ctx: DurableObjectState, env: unknown): EsbuildBuildHost;
/**
 * Runs one `esbuild` command in the Durable Object's esbuild facet, as
 * process `pid`: its files go through a supervisor capability minted for that
 * pid, the one IsolatePool mints for a facet, and its stdout and stderr come
 * back through `output` as esbuild writes them. Resolves to its exit status.
 */
export declare function runEsbuildCli(ctx: DurableObjectState, env: unknown, pid: number, args: EsbuildCliArgs, output: EsbuildCliOutput): Promise<number>;
/**
 * The esbuild a Durable Object's supervisor shares: its transforms and its
 * builds run in its esbuild facet, and build() reads `vfs` from here.
 */
export declare function supervisorEsbuildService(ctx: DurableObjectState, env: unknown, vfs: CredentialedVfs): EsbuildService;
//# sourceMappingURL=esbuild-transform.d.ts.map