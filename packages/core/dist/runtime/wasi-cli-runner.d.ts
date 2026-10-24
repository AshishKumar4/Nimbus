/**
 * wasi-cli-runner.ts — a plain WASI command (jq, make) as a command
 * (WASI_CLI_RUNNER).
 *
 * Each invocation is one WASI process in a facet: the entrypoint's own
 * installed file (`bin/<name>`) as the image, the session root as its only
 * preopen, the caller's credential, and the caller's working directory, which
 * the image changes to before main (nimbus_proc.startup_dir, nimbus-cwd.c),
 * so a relative path and an absolute one mean what they mean in the shell.
 * Like git (git-runner.ts), it is a process of its own (runtime-stdio.ts):
 * its output goes to the session byte for byte as it writes it, the caller's
 * input is pumped to it, and a child it starts (make's recipe lines) is an
 * ordinary session process, started through the session's child-process
 * route (wasi/processes.ts). A run that ended clean leaves its facet warm for
 * the next run of the same image.
 */
import { type RuntimeManifest } from './runtime-manifest.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import { type FacetHost } from './facet-host.js';
import { type NimbusFilesystemAuthority } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
/** An installed command's handler; its warm facets are kept per handler. */
export type WasiCliRunnerFactory = (manifest: RuntimeManifest, installRoot: string, binName: string) => Command;
export declare function makeWasiCliRunnerFactory(deps: {
    facets: FacetHost;
    filesystem: NimbusFilesystemAuthority;
    processes: SessionProcessSupervisor;
    /** The session the processes run in: its warm facets are its own (warm-facets.ts). */
    session: string;
}): WasiCliRunnerFactory;
export declare const WASI_CLI_RUNNER_PREAMBLE: string;
//# sourceMappingURL=wasi-cli-runner.d.ts.map