export declare function fanoutBenchTask(item: {
    id: number;
    sleepMs: number;
}, env: object): Promise<{
    id: number;
    startMs: number;
    endMs: number;
    loaderEnvKeys: string[];
}>;
export declare function serialBenchTask(item: {
    id: number;
    sleepMs: number;
}): Promise<number>;
//# sourceMappingURL=bench-tasks.d.ts.map