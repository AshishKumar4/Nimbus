/**
 * streams.ts — Node.js-compatible stream classes for Nimbus v2.0.
 *
 * These are generated as raw JS strings (like node-shims.ts) and
 * embedded in the dynamic worker code. They implement the Node
 * stream contract: Readable, Writable, Transform, Duplex, PassThrough,
 * pipeline(), and finished().
 *
 * Backpressure: write() returns false when the internal buffer exceeds
 * highWaterMark, and emits 'drain' when the buffer is flushed.
 */
export declare function generateStreamsCode(): string;
//# sourceMappingURL=streams.d.ts.map