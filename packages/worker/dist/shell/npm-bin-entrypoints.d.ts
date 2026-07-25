import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { FacetManager } from '../facets/manager.js';
type Output = {
    write(data: string): void;
};
/**
 * How long a bin invocation may take before the shell stops waiting for it.
 *
 * The program itself is already bounded: FACET_TIMEOUT_MS kills a one-shot
 * facet and the session reports exit 124 with a reason. Nothing bounds the
 * supervisor-side work AROUND that run — the prefetch-bundle walk, the ESM
 * transform, staging a bundled artifact, the loader hop — and nothing bounds
 * the staged-artifact dispatch at all. A dispatch that never settles leaves
 * `running` stuck true on this connection's shell: every later keystroke is
 * swallowed, no prompt returns, and nothing says why. A terminal that goes
 * silent forever is worse than a command that fails.
 *
 * So the invocation gets the program's lifetime twice over: the program keeps
 * its full FACET_TIMEOUT_MS and the supervisor-side work gets the same again.
 * Derived rather than chosen, so it cannot drift from the bound it exists to
 * sit outside. Measured against a deployed Worker, the heaviest bins we run
 * sit far inside it: `pi --version` (a 17.4 MiB module map, the largest
 * observed) returns in 16s, and every staged-opencode one-shot in 2-4s.
 */
export declare const BIN_DISPATCH_TIMEOUT_MS: number;
export type BinDispatchOutcome<T> = {
    expired: false;
    value: T;
} | {
    expired: true;
};
/**
 * Await a bin dispatch under a bound. Reports expiry instead of hanging.
 *
 * The abandoned work keeps running — there is nothing to cancel it with, and a
 * facet that eventually finishes still lands its own exit and its write-back.
 * It just no longer holds the shell open, and it can never surface as an
 * unhandled rejection once we have stopped listening.
 */
export declare function awaitBinDispatch<T>(work: Promise<T>, budgetMs: number): Promise<BinDispatchOutcome<T>>;
type RegistryLike = {
    resolve(name: string): Promise<unknown> | unknown;
};
type RuntimeCommandHint = {
    installSpec: string;
} | null;
export declare function installNpmBinFallbackResolver(registry: RegistryLike, deps: {
    vfs: CredentialedVfs;
    getCwd(): string;
    processes: SessionProcessSupervisor;
    getFacetManager(): FacetManager;
    terminal?: Output | null;
    notifyTerminalEvent(event: {
        type: 'spawn' | 'exit';
        pid: number;
        command: string;
        longRunning?: boolean;
        attachedTty?: boolean;
        code?: number;
    }): void;
    runtimeCommandHint(name: string): Promise<RuntimeCommandHint>;
    emitShellExecDone(pid: number, command: string, exitCode: number, durationMs: number): void;
}): void;
/**
 * How a staged-artifact (opencode) invocation runs. opencode's TUI + in-process
 * server exceed the fixed 128 MiB isolate cap when co-resident, so the OS runs
 * the interactive TUI as a MULTI-ISOLATE process pair: a headless `opencode
 * serve` facet + an `opencode attach` client facet, each in its own isolate with
 * its own 128 MiB cap, joined by the session loopback port registry.
 *
 *   - 'dual'     bare `opencode` (interactive TUI): transparently split into a
 *                resident serve facet + an attached-TTY attach facet.
 *   - 'server'   `opencode serve` / `opencode web`: a headless long-running HTTP
 *                server → resident keyed+routeable facet (never grabs the TTY).
 *   - 'attached' `opencode attach <url>`: the interactive TUI client → resident
 *                attached-TTY facet.
 *   - 'oneshot'  everything else (`run`, `models`, `--version`/`--help`, the
 *                Nimbus tree-sitter diagnostic): fresh isolate, buffered result.
 */
export type StagedArtifactDisposition = 'dual' | 'server' | 'attached' | 'oneshot';
export declare function classifyStagedArtifact(artifact: string, argv: string[]): StagedArtifactDisposition;
export {};
//# sourceMappingURL=npm-bin-entrypoints.d.ts.map