export type WaitResult<T> = {
    type: 'done';
    value: T;
} | {
    type: 'aborted';
} | {
    type: 'timeout';
};
export declare function waitForSignalOrTimeout<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<WaitResult<T>>;
export declare function waitForAbort(signal: AbortSignal): Promise<void>;
export declare function waitForAbortOrTimeout(signal: AbortSignal, timeoutMs: number): Promise<'aborted' | 'timeout'>;
//# sourceMappingURL=signal.d.ts.map