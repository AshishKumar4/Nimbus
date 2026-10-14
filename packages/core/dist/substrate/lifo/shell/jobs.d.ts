import type { SessionProcessSupervisor } from '../../../runtime/session-process-supervisor.js';
import type { CommandIdentity } from './interpreter.js';
/**
 * The session's process table as a shell uses it: its jobs are processes
 * there, under the process that started them, and the work of its lines is
 * counted and held there.
 */
export type ShellProcesses = Pick<SessionProcessSupervisor, 'spawn' | 'exit' | 'kill' | 'whenEnded' | 'holdWork' | 'beginWork' | 'cred' | 'setUmask'>;
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
    /** Running, stopped by a stop signal, or done once its process has ended. */
    readonly status: 'running' | 'done' | 'stopped';
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
     * Deliver `signal` (a parsed name, never `0`) to `job`, one of this
     * table's: a terminating one ends its process, which stops its work; a
     * stop or continue sets or clears its stop mark.
     */
    signal(job: Job, signal: string): void;
    fork(): JobTable;
    byPid(pid: number): Job | undefined;
    get(id: number): Job | undefined;
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