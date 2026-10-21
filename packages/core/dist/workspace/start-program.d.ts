/**
 * A program started by its argv through the workspace's child broker (Kinu
 * ask 67): the start contract (runtime/program-start.ts) a mount's exec
 * delegate meets, met by a session. It is placed by its cwd as every start
 * is (ask 66), runs as the child of a process of its own, and is the
 * broker's child in every other way: its stdin a byte queue a write waits
 * on, its output read as its reader takes it, its signals the broker's.
 */
import type { ChildProcessManager } from '../runtime/child-process-manager.js';
import type { Program, StartedSessionProgram } from '../runtime/program-start.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { VfsCred } from '../runtime/os-contracts.js';
export interface ProgramHost {
    readonly children: ChildProcessManager;
    readonly processes: SessionProcessSupervisor;
    readonly cred: Readonly<VfsCred>;
}
/**
 * `program` started (ExecDelegate.start's contract): resolved once it runs,
 * rejected with Node's spawn error (`code`, `errno`, `syscall: 'spawn
 * <file>'`, `path`) when it could not start, ECANCELED when `cancel`
 * aborted while it was pending (whatever had started is killed first).
 */
export declare function startProgram(host: ProgramHost, program: Program, cancel: AbortSignal): Promise<StartedSessionProgram>;
//# sourceMappingURL=start-program.d.ts.map