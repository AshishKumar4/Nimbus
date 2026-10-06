import { type ReplayFailure } from './stop-replay-contracts.js';
/** Bounded recording and incremental digest; never delay response headers. */
export declare class ReplayBodyRecord {
    private pieces;
    private a;
    private b;
    private chunks;
    over: boolean;
    add(bytes: Uint8Array): void;
    finish(): {
        body: Uint8Array;
        digest: string;
        chunks: number[];
    } | {
        tooLarge: true;
    };
}
/** The same error shape is delivered live and on replay, including its cause. */
export declare function recordFailure(error: unknown): ReplayFailure;
export declare function failureOf(record: ReplayFailure): Error;
//# sourceMappingURL=stop-replay-body.d.ts.map