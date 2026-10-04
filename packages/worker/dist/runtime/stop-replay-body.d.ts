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
//# sourceMappingURL=stop-replay-body.d.ts.map