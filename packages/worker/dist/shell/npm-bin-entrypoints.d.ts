import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
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
    vfs: SqliteVFS;
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