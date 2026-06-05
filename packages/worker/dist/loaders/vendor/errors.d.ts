export declare class ParallelError extends Error {
    constructor(message: string);
}
export declare class SerializationError extends ParallelError {
    constructor(message: string);
}
export declare class ExecutionError extends ParallelError {
    readonly remoteMessage: string;
    readonly remoteStack?: string;
    constructor(message: string, remoteStack?: string);
}
export declare class TimeoutError extends ParallelError {
    readonly deadlineMs: number;
    constructor(deadlineMs: number);
}
export declare class RetryExhaustedError extends ParallelError {
    readonly lastError: Error;
    readonly attempts: number;
    constructor(attempts: number, lastError: Error);
}
export declare class BindingError extends ParallelError {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map