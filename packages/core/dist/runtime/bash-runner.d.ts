import type { RuntimeManifest } from './runtime-manifest.js';
import { type ProcessView } from './process-files.js';
import type { FacetHost } from './facet-host.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import type { BashSlice } from './bash/types.js';
import type { NimbusFilesystemAuthority, RuntimeFsBridge, VfsCred } from './os-contracts.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
type BashRunnerFactory = (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
export interface BashFacetSession {
    readonly initial: BashSlice;
    push(data: string, eof?: boolean): Promise<BashSlice>;
    /**
     * Abort the step in flight and settle when it has. Every facet host can:
     * the Worker Loader host through the request's signal, the local host
     * through its submit's (it ends the facet's realm). The session is over
     * after it.
     */
    interrupt(): Promise<void>;
    close(): Promise<void>;
}
export declare function createBashFacetSession(deps: {
    facets: FacetHost;
    /** Installed runtime blobs, read through the host lease that owns them. */
    artifacts: ProcessView;
    filesystem: RuntimeFsBridge;
    pid: number;
    processes?: SessionProcessSupervisor;
    cred: VfsCred;
    manifest: RuntimeManifest;
    installRoot: string;
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdinData?: string;
    stdinClosed: boolean;
    stdinTty: boolean;
    sharedInput?: boolean;
    outputControls?: import('./wasi/output-control.js').OutputControlFrame[];
    signal?: AbortSignal;
}): Promise<BashFacetSession>;
export declare function makeBashRunnerFactory(deps: {
    facets: FacetHost;
    filesystem: NimbusFilesystemAuthority;
    processes: SessionProcessSupervisor;
}): BashRunnerFactory;
/**
 * Source string injected as the facet `preamble`. The facet's scope evaluates
 * it verbatim so `__bashBoot` / `__bashFeed` are in scope when the user fn
 * runs. Self-contained — no closure captures, no imports.
 *
 * The scheduler itself lives in `bash/preamble.ts` as real TypeScript; the build
 * bundles it into `bash-runner.generated.ts`.
 */
export declare const BASH_RUNNER_PREAMBLE: string;
export {};
//# sourceMappingURL=bash-runner.d.ts.map