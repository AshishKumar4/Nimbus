/**
 * git/wave-bench.ts — how fast the session takes a clone's writes, with N producers.
 *
 * NIMBUS_DEBUG only (POST /api/_test/w7-bench). Each producer is a Dynamic
 * Worker running the clone's own wave writer (platform wave-writer.ts) over
 * synthetic files, publishing through SupervisorRPC.writeBatchStream exactly
 * as a clone's facet does, so the measured path is the production one:
 * producer → SupervisorRPC → session → SQLite. Contents are random, so
 * content addressing stores every byte. The answer is the files/s and MB/s
 * the session sustained, and what the producers waited on.
 */
/**
 * Where a producer's waves go, to tell the costs on the way apart:
 * - supervisor: SupervisorRPC.writeBatchStream, as a clone's facet (two hops);
 * - vfs: straight to the session's VFS.writeStream (one hop);
 * - vfs-bytes: the encoded wave as one RPC argument, no stream (one hop);
 * - drain: the session reads the stream and writes nothing;
 * - drain-writing: the session reads it, committing one small row per read.
 */
export type WaveBenchSinkMode = 'supervisor' | 'vfs' | 'vfs-bytes' | 'drain' | 'drain-writing';
/** The session side of the bench's direct modes. */
export interface WaveBenchSession {
    writeStream(stream: ReadableStream<Uint8Array>): Promise<unknown>;
    sql: SqlStorage;
}
export interface WaveBenchOptions {
    /** The process whose credential the producers write as. */
    pid: number;
    sink: WaveBenchSinkMode;
    /** VFS directory the producers write below (p0, p1, …). */
    root: string;
    producers: number;
    /** Files per producer. */
    files: number;
    /** File sizes, cycled. */
    sizes: number[];
    /** One-file waves each producer sends first, flushed one at a time: the per-wave round trip. */
    pings?: number;
}
/**
 * One wave as its producer saw it: sent, first and last pulled by the
 * transport, answered. (A Durable Object's clock stands still while it
 * computes, so the session cannot time its side of a wave.)
 */
export interface WaveBenchWave {
    sentAt: number;
    firstPullAt: number;
    lastPullAt: number;
    pulls: number;
    bytes: number;
    answeredAt: number;
    /** The longest the transport went without pulling from this wave's stream. */
    maxGapMs: number;
}
export interface WaveBenchProducer {
    /** Mean wall of a one-file wave, sent and published alone. */
    pingMs: number;
    /** Its median, 95th percentile and slowest. */
    pingP50Ms: number;
    pingP95Ms: number;
    pingMaxMs: number;
    timeline: WaveBenchWave[];
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
export declare function runWaveBench(ctx: DurableObjectState, env: unknown, options: WaveBenchOptions, session: WaveBenchSession): Promise<WaveBenchResult>;
//# sourceMappingURL=wave-bench.d.ts.map