/**
 * git/wave-bench.ts — how fast the session takes a clone's writes, with N producers.
 *
 * NIMBUS_DEBUG only (POST /api/_test/w7-bench). Each producer is a Dynamic
 * Worker running the clone's own wave writer (git/wave-writer.ts) over
 * synthetic files, publishing through SupervisorRPC.writeBatchStream exactly
 * as a clone's facet does, so the measured path is the production one:
 * producer → SupervisorRPC → session → SQLite. Contents are random, so
 * content addressing stores every byte. The answer is the files/s and MB/s
 * the session sustained, and what the producers waited on.
 */
export interface WaveBenchOptions {
    /** The process whose credential the producers write as. */
    pid: number;
    /** VFS directory the producers write below (p0, p1, …). */
    root: string;
    producers: number;
    /** Files per producer. */
    files: number;
    /** File sizes, cycled. */
    sizes: number[];
}
export interface WaveBenchProducer {
    files: number;
    bytes: number;
    wallMs: number;
    waves: number;
    rpcWallMs: number;
    maxRpcWallMs: number;
    producerWaitMs: number;
}
export interface WaveBenchResult {
    producers: number;
    files: number;
    bytes: number;
    wallMs: number;
    filesPerSecond: number;
    mbPerSecond: number;
    perProducer: WaveBenchProducer[];
}
export declare function runWaveBench(ctx: DurableObjectState, env: unknown, options: WaveBenchOptions): Promise<WaveBenchResult>;
//# sourceMappingURL=wave-bench.d.ts.map