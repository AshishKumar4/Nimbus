/**
 * esbuild-cli/types.ts — what crosses the boundary between the session and
 * the isolate that runs one `esbuild` command, and the global its runner
 * installs there.
 */
import type { WasiSupervisorStub } from '../wasi/types.js';

/** One invocation of the esbuild CLI, as the calling process sees it. */
export interface EsbuildCliArgs {
  /** esbuild's own arguments, without the program name. */
  argv: string[];
  /** The caller's working directory, absolute. */
  cwd: string;
  /** The environment variables esbuild reads. */
  env: Record<string, string>;
  uid: number;
  gid: number;
  groups: number[];
  umask: number;
  /** Bytes esbuild reads when it is given no entry point; null reads as EOF. */
  stdin: Uint8Array | null;
}

/**
 * The command's stdout (1) and stderr (2), in the order the program writes
 * them. The runner awaits each call before it sends the next.
 */
export type EsbuildCliOutput = (fd: 1 | 2, bytes: Uint8Array) => Promise<void>;

/** The subset of Go's `wasm_exec.js` runtime the preamble drives. */
export interface GoProgram {
  argv: string[];
  env: Record<string, string>;
  exit: (code: number) => void;
  readonly exited: boolean;
  readonly importObject: WebAssembly.Imports;
  readonly _scheduledTimeouts: Map<number, number>;
  run(instance: WebAssembly.Instance): Promise<void>;
}

/**
 * Go's `wasm_exec.js`, evaluated against the global object and `fs` it is
 * handed rather than the facet's own, so each run gets its own filesystem.
 */
export type GoRuntimeFactory = (global: object, fs: object) => new () => GoProgram;

declare global {
  /** Runs the CLI once and resolves to its exit status. */
  var __esbuildCliRun: (
    args: EsbuildCliArgs,
    supervisor: WasiSupervisorStub,
    output: EsbuildCliOutput,
    module: WebAssembly.Module,
  ) => Promise<number>;
}
