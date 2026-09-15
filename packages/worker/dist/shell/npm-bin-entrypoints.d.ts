import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { FacetManager } from '../facets/manager.js';
type Output = {
    write(data: string): void;
};
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
/**
 * Whether this invocation stays resident. Only the keyed long-running facet
 * exposes a re-resolvable route stub, so getting this wrong for a server means
 * its port is never reachable — it runs in the one-shot facet until the facet
 * lifetime expires and reports the limit it hit.
 *
 * A server-shaped CLI serves by default; the exception is the subcommand that
 * ends. `build` is that verb, and it means the same thing in every one of
 * these CLIs: produce an artifact, exit. `preview` does not end — it binds a
 * port and serves the built output, exactly as `dev` binds one and serves the
 * source.
 *
 * The exclusion stays narrow because the two errors are not symmetric. A
 * missed server costs a dead port for one facet lifetime; a resident process
 * that exits 0 is never reaped (`handedOffToLongRunningFacet` above), so it
 * stays `running` in `ps` for the life of the session. Only verbs that
 * certainly terminate belong here.
 */
export declare function looksLongRunningNpmBin(binName: string, argv: string[]): boolean;
export {};
//# sourceMappingURL=npm-bin-entrypoints.d.ts.map