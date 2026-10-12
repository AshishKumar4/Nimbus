/** The real Git guest entry, compiled without importing its host/bootstrap graph. */
import type { FacetBindings } from './facet-host.js';
import type { WasiCred } from './wasi/types.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';

export interface GitFacetArgs {
  argv: string[];
  env: Record<string, string>;
  cred: WasiCred;
  /** The session pid git runs as: the parent of the children it starts. */
  pid: number;
  /** Its output goes to the session as it is written (SupervisorRPC stdout/stderr), not back in the result. */
  live: boolean;
}

export interface GitFacetResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  error?: string;
  /** git's filesystem calls and who answered them (wasi/resident-filesystem.ts). */
  fsStats?: ResidentFilesystemStats | null;
  /** Whether another git may run in this facet (__wasiReusable: no syscall in it was abandoned). */
  reusable?: boolean;
  /** The facet's clock (which moves only across I/O) where the run entered, git was instantiated, and git exited. */
  clock?: { entered: number; instantiated: number; exited: number };
}

/** Runs in the facet: hands the compiled image and the capability to the preamble's __gitRun. */
export async function gitFacetCall(args: GitFacetArgs, facetEnv: FacetBindings): Promise<GitFacetResult> {
  const modules = Reflect.get(globalThis, '__NIMBUS_WASM') as Record<string, unknown> | undefined;
  const gitMod = modules?.['git.wasm'];
  const run = Reflect.get(globalThis, '__gitRun') as ((a: unknown) => Promise<GitFacetResult>) | undefined;
  if (!gitMod || typeof run !== 'function') {
    return { exitCode: 127, stdout: new Uint8Array(0), stderr: new Uint8Array(0), error: 'git-runner: the facet has no git image or no __gitRun' };
  }
  return await run({ ...args, gitMod, supervisor: facetEnv?.SUPERVISOR });
}
