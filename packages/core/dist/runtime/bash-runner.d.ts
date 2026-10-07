import type { RuntimeManifest } from './runtime-manifest.js';
import { type ProcessView } from './process-files.js';
import type { FacetHost } from './facet-host.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import type { BashBootArgs, BashFeedArgs, BashSlice } from './bash/types.js';
import type { NimbusFilesystemAuthority, RuntimeFsBridge, VfsCred } from './os-contracts.js';
import type { FacetBindings } from './facet-host.js';
type BashRunnerFactory = (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
type BashStepArgs = BashBootArgs | BashFeedArgs;
/** The step the classic submit transport carries: args object in, slice out.
 *  Serialized verbatim into the facet — every name it touches must be
 *  reachable there (globals or its own literals). */
export declare function bashFacetStep(args: BashStepArgs, bindings: FacetBindings): Promise<unknown>;
/**
 * The same step reached through a Request, for hosts whose facet can carry
 * a fetch signal. Serialized verbatim like `bashFacetStep` — no closure
 * references — and the dispatch inside is the same `__bashStep` call; only
 * the transport wrapper differs (JSON in, Response out).
 */
export declare function bashRequestStep(request: Request, bindings: FacetBindings): Promise<Response>;
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
    cred: VfsCred;
    manifest: RuntimeManifest;
    installRoot: string;
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdinData?: string;
    stdinClosed: boolean;
    stdinTty: boolean;
    signal?: AbortSignal;
}): Promise<BashFacetSession>;
export declare function makeBashRunnerFactory(deps: {
    facets: FacetHost;
    filesystem: NimbusFilesystemAuthority;
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