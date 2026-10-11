import type { ChildExit } from '../commands/types.js';
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
/** A process a write to a closed pipe ended, as SIGPIPE ends one. */
export declare const KILLED_BY_SIGPIPE: ChildExit;
export declare function signalDisposition(signal: string): SignalDisposition | undefined;
export declare function signalAbortReason(signal?: string): SignalAbortReason;
/**
 * The stop a session's destroy gives the work it runs
 * (SessionProcessSupervisor.kill): SIGKILL's, as this one value, so work that
 * must not write into the storage the destroy wipes (a clone's cleanup and
 * its record) knows it by identity.
 */
export declare const SESSION_DESTROYED: SignalAbortReason;
export declare function exitCodeForAbortSignal(signal: AbortSignal, fallback?: number): number;
//# sourceMappingURL=signals.d.ts.map