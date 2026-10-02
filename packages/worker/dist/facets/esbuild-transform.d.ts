import { EsbuildService, type EsbuildTransformHost, type EsbuildBuildHost } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { EsbuildCliArgs, EsbuildCliOutput } from '@nimbus-sh/core/runtime/esbuild-cli.js';
import type { WorkerCode } from '@nimbus-sh/fabric/vendor/types.js';
import type { NamespaceFs } from '@nimbus-sh/core/runtime/process-files.js';
export declare const ESBUILD_FACET_WORKER_ID: string;
/**
 * Slim Worker Loader module whose DO class owns the esbuild wasm.
 * `wasmModule` is the host Worker's own compiled esbuild module
 * (runtime/host-wasm.ts), shared with the facet rather than compiled again.
 * `jsFnBody` is the staged adapter (fetchEsbuildJsFnBody), compiled into a
 * factory at startup, the one moment code may be generated from a string;
 * each call of the factory is a separate esbuild, and takes the `WebAssembly`
 * namespace its adapter instantiates through (`newEsbuild(webAssembly)`,
 * the global one unless given). `cliRunner` is the staged runner of the
 * `esbuild` command (fetchEsbuildCliRunner).
 */
export declare function esbuildFacetWorkerCode(wasmModule: WebAssembly.Module, jsFnBody: string, cliRunner: string, transformRuntime: string): WorkerCode;
/**
 * Where the transform facet sends a module that ran Oxc out of native stack
 * (oxcTransformHost): the esbuild facet, whose Go stacks grow. One call per
 * batch; the caller answers a failed call as transient.
 */
export declare function esbuildStackFallbackHost(ctx: DurableObjectState, env: unknown): EsbuildTransformHost;
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
 * What a transform from supervisorEsbuildService's host is a function of:
 * the transform facet's code (OXC_FACET_WORKER_ID) and, for a module too deep
 * for it, the esbuild facet's (ESBUILD_FACET_WORKER_ID, which carries the
 * esbuild version). The launch's transform store keys results by it, so a new
 * build of either engine misses every stored result.
 */
export declare const TRANSFORM_HOST_ID: string;
/**
 * The transforms and builds a Durable Object's supervisor shares: transforms
 * run in its transform facet (oxc-transform.ts), builds in its esbuild
 * facet, and build() reads `vfs` from here. TRANSFORM_HOST_ID is the host's
 * identity, which the launch's transform store keys its results by.
 */
export declare function supervisorEsbuildService(ctx: DurableObjectState, env: unknown, vfs: NamespaceFs): EsbuildService;
//# sourceMappingURL=esbuild-transform.d.ts.map