export interface Job {
    id: number;
    command: string;
    promise: Promise<number>;
    abortController: AbortController;
    status: 'running' | 'done' | 'stopped';
    exitCode: number | null;
    /** The job's process, when it has one in the registry. */
    pid?: number;
}
export declare function resolveJobSpec<T extends {
    id: number;
    command: string;
}>(spec: string, jobs: readonly T[]): T | 'ambiguous' | undefined;
export declare class JobTable {
    private jobs;
    private waited;
    add(command: string, promise: Promise<number>, abortController: AbortController, pid?: number): number;
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