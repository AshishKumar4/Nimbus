import type { ProcessRegistry } from './ProcessRegistry.js';
/**
 * A background job: its `%N` number, its command line and its process. The
 * process table (ProcessRegistry) is the truth of whether it runs or is
 * stopped; the job records only how it ended, once it has.
 */
export interface Job {
    readonly id: number;
    readonly command: string;
    readonly promise: Promise<number>;
    readonly abortController: AbortController;
    readonly pid: number;
    /** Running or stopped as its process is; done once it has ended. */
    readonly status: 'running' | 'done' | 'stopped';
    /** How it ended; null while it runs. */
    readonly exitCode: number | null;
}
export declare function resolveJobSpec<T extends {
    id: number;
    command: string;
}>(spec: string, jobs: readonly T[]): T | 'ambiguous' | undefined;
/**
 * A shell's jobs, by number: a view over the process table, where each job
 * is a process. A subshell's table starts as a copy of its parent's; the
 * job records are shared, which is safe because what changes about a job
 * (its state) is its process's, and how it ended is set once.
 */
export declare class JobTable {
    private readonly processes;
    private jobs;
    private waited;
    constructor(processes: ProcessRegistry);
    /** Run `promise` as a background job: a process in the table, numbered as bash numbers jobs. Its pid and number. */
    start(options: {
        command: string;
        cwd: string;
        env: Record<string, string>;
        promise: Promise<number>;
        abortController: AbortController;
    }): {
        pid: number;
        id: number;
    };
    list(): Job[];
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