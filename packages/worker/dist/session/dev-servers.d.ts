/**
 * session/dev-servers.ts — a dev server the session runs itself, recorded so
 * that a new incarnation of the session runs it again.
 *
 * `vite`, `vite preview`, real Vite and `wrangler dev` serve from the session:
 * each server lives in the session's memory, or in a facet the session holds,
 * behind one long-running process. A session's object is re-created routinely
 * (an idle one within about two minutes, measured) and by an instance reset,
 * and the server is gone with it. So while that process runs, its spawn is
 * recorded here, synced: the command line, argv, cwd, credential and exec id
 * it was started with, the environment its command was given, the root it
 * serves and the ports it serves on. The process's end, however it comes,
 * releases the record, and nothing else does. A new incarnation runs each
 * recorded command again once (restoreDevServers), as a restarted service
 * runs: the same line under a process with the same spawn, which the command
 * adopts, so it reads its configuration afresh and serves as it did. The
 * restore knows no program; it runs what was recorded.
 *
 * A command's environment is recorded as the command was given it, as the
 * resident launch journal records a recipe's (facets/manager.ts): a launch
 * overlay ($PORT, $NIMBUS_APP under a reservation) is applied only to facet
 * launches, so it is never in it.
 */
import { type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { type ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace/nimbus-workspace.js';
import type { DevServerRestoreFailure } from './helpers.js';
import { type PortCapabilityHost } from './port-capability.js';
import type { ProcessEnvHooks } from './process-env.js';
/** How a dev server's process is spawned: the command line it runs, and the process's argv, cwd, credential and exec id. */
export interface DevServerSpawn {
    command: string;
    argv: string[];
    cwd: string;
    cred: VfsCred;
    execId?: string;
}
/** The command a dev server is started by: its process, and the pid a caller handed it to adopt. */
export type DevServerCommandContext = Pick<CommandContext, 'pid' | 'cred' | 'args' | 'cwd'> & {
    __nimbusBinSpawn?: {
        skipSpawn?: boolean;
        callerPid?: number;
    };
};
/** Where a dev server process's record is kept. */
export interface DevServerHost {
    readonly ctx: {
        readonly storage: DurableObjectStorage;
    };
    readonly processes: SessionProcessSupervisor;
    readonly portRegistry: PortRegistry;
    /** Who gives a restored dev server its environment back: its record holds none (session/process-env.ts). */
    readonly processEnv: ProcessEnvHooks;
}
/** The spawn `entry` was made with. */
export declare function spawnOf(entry: ProcessEntry): DevServerSpawn;
/**
 * How the dev server the command `name` starts runs: as the process its
 * caller handed it (bin-spawn: a script's wrapper, an SDK launch, a restore),
 * else as a child of the command with the command's line, argv and cwd.
 */
export declare function devServerSpawn(processes: SessionProcessSupervisor, name: string, ctx: DevServerCommandContext): {
    spawn: DevServerSpawn;
    handed: ProcessEntry | undefined;
};
/**
 * A dev server lives as long as its process `pid`: the process's end, however
 * it comes, runs `stop`, and until then the session holds the server as the
 * process's work (a kill reaches it, and a caller that handed the process to
 * the command sees it still served).
 */
export declare function bindDevServer(processes: SessionProcessSupervisor, pid: number, stop: () => void): void;
/**
 * The dev server's process (devServerSpawn), bound to it (bindDevServer): the
 * one handed it, now long-running, or a new child of the command; null when
 * the one handed it has already ended.
 */
export declare function devServerProcess(processes: SessionProcessSupervisor, name: string, ctx: DevServerCommandContext, stop: () => void): {
    entry: ProcessEntry;
    adopted: boolean;
} | null;
/**
 * Wait for the restore of the previous incarnation's dev servers before a
 * command starts or stops one, so the user's action comes after it rather
 * than being undone by it. A command the restore itself runs does not wait.
 */
export declare function afterDevServerRestore(host: {
    restoreDevServers(): Promise<readonly DevServerRestoreFailure[]>;
}, processes: SessionProcessSupervisor, ctx: DevServerCommandContext): Promise<void>;
/**
 * Record how the dev server behind `pid` was spawned and the ports it serves
 * now, until `pid` ends; its command's environment goes to the host, if it
 * keeps environments, never into the record. Synced, so a reset right after
 * it still finds it; a process that ended meanwhile leaves none.
 */
export declare function recordDevServer(host: DevServerHost, pid: number, spawn: DevServerSpawn & {
    env: Readonly<Record<string, string>>;
    root: string;
}): Promise<void>;
/** What restoring the session's dev servers needs: its shell, to run each command again. */
export interface DevServerRestoreHost extends DevServerHost {
    readonly ctx: DevServerHost['ctx'] & PortCapabilityHost['ctx'];
    readonly runtimeWorkspace: NimbusWorkspace | null;
    ensureRuntimeReady(): Promise<void>;
}
/**
 * Run again, once, each dev server a previous incarnation of the session
 * recorded; every caller waits on that one run. First each server's process
 * is spawned again, as the recorded one was (`respawned`), then each command
 * runs, one at a time, under its process. A server whose command fails is
 * not tried again: the failure is answered, and its process's log says why.
 */
export declare function restoreDevServers(host: DevServerRestoreHost): Promise<readonly DevServerRestoreFailure[]>;
/**
 * Once each dev server this incarnation restores has its process in the
 * table, before any of its commands runs: what a listing of what runs waits
 * for, so "not listed" means "not coming". A command the restore runs may
 * list too, and finds the wait over.
 */
export declare function devServersRespawned(host: DevServerRestoreHost): Promise<void>;
//# sourceMappingURL=dev-servers.d.ts.map