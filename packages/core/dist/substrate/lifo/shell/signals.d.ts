export type SignalDisposition = 'ignore' | 'stop' | 'continue' | 'terminate';
export type SignalAbortReason = {
    kind: 'signal';
    signal: string;
    exitCode: number;
};
export declare function parseSignalName(raw: string): string | null;
export declare function formatSignalList(): string;
export declare function signalOperand(raw: string): string | null;
export declare function exitCodeForSignal(signal?: string): number;
export declare function signalDisposition(signal: string): SignalDisposition | undefined;
export declare function signalAbortReason(signal?: string): SignalAbortReason;
export declare function exitCodeForAbortSignal(signal: AbortSignal, fallback?: number): number;
//# sourceMappingURL=signals.d.ts.map