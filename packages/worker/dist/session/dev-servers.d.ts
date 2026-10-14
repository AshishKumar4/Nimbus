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
/** The dev server's process (devServerSpawn): the one handed it, now long-running, or a new child of the command. */
export declare function devServerProcess(processes: SessionProcessSupervisor, name: string, ctx: DevServerCommandContext): {
    entry: ProcessEntry;
    adopted: boolean;
};
/**
 * Record how the dev server behind `pid` was spawned, with the environment
 * its command was given and the ports it serves now, until `pid` ends.
 * Synced, so a reset right after it still finds it; a process that ended
 * meanwhile leaves none.
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
 * recorded, one at a time; every caller waits on that one run. A server whose
 * command fails is not tried again: the failure is answered, and its
 * process's log says why.
 */
export declare function restoreDevServers(host: DevServerRestoreHost): Promise<readonly DevServerRestoreFailure[]>;
//# sourceMappingURL=dev-servers.d.ts.map