/**
 * session/diag.ts — heap probe + W5 OOM-ring persistence helpers.
 *
 * Why a sibling module: heap-sampling state (peak RSS, sample count)
 * is per-DO-instance but doesn't belong in the DO class itself —
 * it's pure data + one ctx-side persistence helper, kept here so the
 * class file stays small and the diag is testable without a workerd
 * harness.
 *
 * Surfaces:
 *   - readNodeMem() — process.memoryUsage() if available; null otherwise.
 *   - readPerfMem() — performance.memory if available; null otherwise.
 *   - sampleMemory(host) — read + update peak trackers (no I/O, microseconds).
 *   - rehydrateRingFromStorage(host, ctx) — load OOM ring snapshot at boot.
 *   - persistRing(host, ctx) — async put with redundant-write skip.
 *
 * Per DEFECT-D1: ctx is taken as a separate explicit arg.
 */
/**
 * Minimal host shape. Per plan §IX.1 b': fields drop `private` on the class.
 */
export interface DiagHost {
    _diagPeakRss: number;
    _diagPeakHeapUsed: number;
    _diagPeakAt: number;
    _diagSampleCount: number;
    _w5LastPersistAt: number;
    _w5LastPersistRingSize: number;
}
export declare function readNodeMem(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
} | null;
export declare function readPerfMem(): {
    jsHeapSizeLimit: number;
    totalJSHeapSize: number;
    usedJSHeapSize: number;
} | null;
/**
 * Sample current heap and update peak trackers. Idempotent on call
 * count beyond `_diagSampleCount`. Safe to call from any code path
 * (request handler, install/bundle progress callbacks) — does NO
 * I/O, NO async work, returns immediately. Cost: one process.memoryUsage()
 * which is microseconds.
 */
export declare function sampleMemory(host: DiagHost): void;
/**
 * W5 Lever 5: rehydrate the OOM ring from storage (best-effort).
 * Survives DO hibernation; lets cf-tail-style forensics include
 * pre-hibernate failures. Fail-soft on garbage / missing.
 */
export declare function rehydrateRingFromStorage(_host: DiagHost, ctx: any): Promise<void>;
/**
 * Snapshot the ring + persist to ctx.storage. Async; callers should
 * pass the returned promise to ctx.waitUntil so close-handler return
 * doesn't race the put. Skips redundant writes.
 */
export declare function persistRing(host: DiagHost, ctx: any): Promise<void> | null;
//# sourceMappingURL=diag.d.ts.map