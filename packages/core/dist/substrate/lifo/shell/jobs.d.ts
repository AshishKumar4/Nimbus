import { type SessionProcessSupervisor } from '../../../runtime/session-process-supervisor.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import type { CommandIdentity } from './interpreter.js';
import type { HostSignalResult } from '../commands/system/kill.js';
/**
 * The session's process table as a shell uses it: its jobs are processes
 * there, under the process that started them, and the work of its lines is
 * counted and held there.
 */
export type ShellProcesses = Pick<SessionProcessSupervisor, 'spawn' | 'exit' | 'kill' | 'killAs' | 'maySignal' | 'whenEnded' | 'holdWork' | 'beginWork' | 'beginAwait' | 'cred' | 'setUmask' | 'signalForeground'>;
/**
 * A background job: its `%N` number, its command line and its process in
 * the session's table, which says when and how it ended.
 */
export interface Job {
    readonly id: number;
    readonly command: string;
    /** Its status, once its process has ended, however it ended. */
    readonly promise: Promise<number>;
    readonly pid: number;
    /** Running, or done once its process has ended: nothing stops a job (JobTable.signal). */
    readonly status: 'running' | 'done';
    /** How it ended; null while it runs. */
    readonly exitCode: number | null;
}
/** What a job's commands run as: its own process, whose work is counted, and the signal its work stops by. */
export interface JobProcess {
    readonly identity: CommandIdentity & {
        beginWork(): () => void;
    };
    readonly signal: AbortSignal;
}
export declare function resolveJobSpec<T extends {
    id: number;
    command: string;
}>(spec: string, jobs: readonly T[]): T | 'ambiguous' | undefined;
/**
 * A shell's jobs, by number: each one a process of the session's table. A
 * subshell's table starts as a copy of its parent's; the job records are
 * shared, which is safe because what changes about a job (its stop mark) is
 * the job's, wherever it is signalled from, and how it ended is set once.
 */
export declare class JobTable {
    private readonly processes;
    private jobs;
    private waited;
    constructor(processes: ShellProcesses);
    /**
     * Run `run` as a background job, numbered as bash numbers jobs: a process
     * of the table under `parent`, with its credential, as a fork makes one.
     * Its commands run as it; a kill of it stops its work, and it ends when
     * `run` settles.
     */
    start(options: {
        command: string;
        cwd: string;
        parent: Pick<CommandIdentity, 'pid' | 'cred'>;
    }, run: (job: JobProcess) => Promise<number>): Job;
    list(): Job[];
    /**
     * `job`'s status once it ends, process `waiter` (the shell `wait` or `fg`
     * runs as) awaiting it meanwhile, as the session counts an await
     * (SessionProcessSupervisor.beginAwait): a shell doing nothing but wait on
     * its job is told as such.
     */
    awaitEnd(job: Job, waiter: number): Promise<number>;
    /**
     * Deliver `signal` (a parsed name; `0` delivers nothing) to `job`, one of
     * this table's, from `caller`, as kill reports it: a terminating one ends
     * its process, which stops its work; a continue or an ignored one does
     * nothing to a job that runs. A stop is `unsupported`: nothing can pause a
     * job's work (a command is not preempted), as nothing can pause a hosted
     * process's. `not-permitted` when kill(2)'s rule refuses `caller`: the
     * kill's own check (SessionProcessSupervisor.killAs), or for a signal that
     * ends nothing, the same rule asked alone (maySignal).
     */
    signal(job: Job, signal: string, caller: Readonly<VfsCred>): HostSignalResult;
    fork(): JobTable;
    byPid(pid: number): Job | undefined;
    get(id: number): Job | undefined;
    /**
     * What `wait` names, by jobspec or by pid: a job of this table, else one
     * it has waited for, whose status it still answers with (bash's).
     */
    waitTarget(spec: string): Job | 'ambiguous' | undefined;
    reap(job: Job): void;
    clearWaited(): void;
    remove(id: number): void;
    /**
     * Collect and remove finished jobs, returning their info for display.
     */
    collectDone(): Job[];
}
//# sourceMappingURL=jobs.d.ts.map