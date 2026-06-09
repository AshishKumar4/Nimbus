export interface Job {
    id: number;
    command: string;
    promise: Promise<number>;
    abortController: AbortController;
    status: 'running' | 'done' | 'stopped';
    exitCode: number | null;
}
export declare class JobTable {
    private jobs;
    private nextId;
    add(command: string, promise: Promise<number>, abortController: AbortController): number;
    list(): Job[];
    get(id: number): Job | undefined;
    remove(id: number): void;
    /**
     * Collect and remove finished jobs, returning their info for display.
     */
    collectDone(): Job[];
}
//# sourceMappingURL=jobs.d.ts.map