/**
 * bash-runner — real GNU bash 5.2.37 (wasm32-wasi, asyncified) in a
 * dedicated facet.
 *
 * bash CANNOT run through the stock JSPI wasm-runner: the binary is
 * asyncify-instrumented (fork/setjmp/blocking-pipe unwinds) and needs
 * 15 `nimbus_proc` imports plus MULTIPLE instances per facet (fork).
 * This runner embeds the proven multi-instance fork/pipe/exec/setjmp
 * scheduler (packages/worker/wasm/bash/run-bash-fork.mjs — the local
 * acid-test driver, itself a port of the PROVEN-LIVE fork M1/M2/M3
 * mechanisms) as a facet preamble.
 *
 * Architecture (mirrors ruby-runner's facet dispatch):
 *  - bash.async.wasm + the coreutil exec targets ship through the facet
 *    host, which compiles them and exposes them on
 *    globalThis.__NIMBUS_WASM.
 *  - The preamble defines __bashBoot / __bashFeed. Boot instantiates
 *    bash, pumps the scheduler until the process tree exits or the
 *    root parks on a terminal stdin read; each feed delivers stdin
 *    bytes and pumps again. Facet state persists across submits on
 *    the warm isolate (same mechanism as __rubyInstance caching).
 *  - stdout/stderr accumulate per pump slice and stream back to the
 *    CommandContext; VFS writes come back as a WasiFsDiff on exit.
 */
import type { RuntimeManifest } from './runtime-manifest.js';
import { type ExecutionFs } from '../shell/execution-fs.js';
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
     * Abort the step in flight and settle when it has. Present only where the
     * facet host can carry a fetch signal through to the isolate — a local
     * host shares the caller's thread, where nothing preemptible exists to
     * interrupt, so the property is absent rather than a no-op.
     */
    interrupt?(): Promise<void>;
    close(): Promise<void>;
}
export declare function createBashFacetSession(deps: {
    facets: FacetHost;
    /** Installed runtime blobs, read through the host lease that owns them. */
    artifacts: ExecutionFs;
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