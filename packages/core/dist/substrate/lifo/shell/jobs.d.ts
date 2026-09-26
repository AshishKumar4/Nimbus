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
export declare class JobTable {
    private jobs;
    add(command: string, promise: Promise<number>, abortController: AbortController, pid?: number): number;
    list(): Job[];
    byPid(pid: number): Job | undefined;
    get(id: number): Job | undefined;
    remove(id: number): void;
    /**
     * Collect and remove finished jobs, returning their info for display.
     */
    collectDone(): Job[];
}
//# sourceMappingURL=jobs.d.ts.map