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
 *  - bash.async.wasm + the coreutil exec targets ride the LOADER
 *    modules map (compiled by workerd at module-load; exposed on
 *    globalThis.__NIMBUS_WASM).
 *  - The preamble defines __bashBoot / __bashFeed. Boot instantiates
 *    bash, pumps the scheduler until the process tree exits or the
 *    root parks on a terminal stdin read; each feed delivers stdin
 *    bytes and pumps again. Facet state persists across submits on
 *    the warm isolate (same mechanism as __rubyInstance caching).
 *  - stdout/stderr accumulate per pump slice and stream back to the
 *    CommandContext; VFS writes come back as a WasiFsDiff on exit.
 */
import type { RuntimeManifest } from './runtime-catalog.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import type { Command } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { BashSlice } from '@nimbus-sh/core/runtime/bash/types.js';
type BashRunnerFactory = (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
export interface BashFacetSession {
    readonly initial: BashSlice;
    push(data: string, eof?: boolean): Promise<BashSlice>;
    close(): Promise<void>;
}
export declare function createBashFacetSession(deps: {
    facetMgr: FacetManager;
    vfs: CredentialedVfs;
    manifest: RuntimeManifest;
    installRoot: string;
    argv: string[];
    env: Record<string, string>;
    cwd: string;
    stdinData?: string;
    stdinClosed: boolean;
    stdinTty: boolean;
    extraRoots?: string[];
}): Promise<BashFacetSession>;
export declare function makeBashRunnerFactory(deps: {
    facetMgr: FacetManager;
    vfs: SqliteVFS;
}): BashRunnerFactory;
/**
 * Source string injected as the loader-pool `preamble`. The facet's module init
 * evaluates it verbatim so `__bashBoot` / `__bashFeed` are in scope when the
 * user fn runs. Self-contained — no closure captures, no imports.
 *
 * The scheduler itself lives in `bash/preamble.ts` as real TypeScript; the build
 * bundles it into `bash-runner.generated.ts`.
 */
export declare const BASH_RUNNER_PREAMBLE: string;
export {};
//# sourceMappingURL=bash-runner.d.ts.map