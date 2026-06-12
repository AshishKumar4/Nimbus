/**
 * OnDemandBundleGate — memory-bounded admission control for on-demand
 * /@modules/ bundling.
 *
 * Why this exists
 * ───────────────
 * The dev server bundles user packages on demand by building a file
 * "slice" in the supervisor heap (up to SLICE_CAP_BYTES ≈ 28 MiB) and
 * shipping it to a facet isolate over RPC. The facet RPC round-trip is
 * the dominant wall time; the supervisor just holds the slice array
 * alive until the clone completes. A fresh React app first-load requests
 * many distinct /@modules/ concurrently, so the naive path either:
 *   - builds all slices at once → peak heap = N × 28 MiB → supervisor
 *     OOM on a shared DO isolate (the install-time pre-bundler proved
 *     concurrency=2 of max slices crashes a Mossaic-scale isolate), or
 *   - serializes everything behind one slot → multi-second first load.
 *
 * This gate threads the needle: it bounds the TOTAL slice BYTES resident
 * at once (not a count), so many SMALL slices' RPC round-trips overlap
 * while a single LARGE slice still serializes the rest — peak resident
 * slice bytes never exceed `budgetBytes`, which is set to one slice cap.
 *
 * How it bounds peak heap
 * ───────────────────────
 *   - Only ONE slice is ever mid-BUILD (a build lock): the slice array
 *     does not exist until built, so we can't reserve its real size up
 *     front. Serializing the (fast, synchronous) build means at most one
 *     un-accounted slice exists at any instant.
 *   - The moment a build finishes, the caller `admit(realBytes)`s: that
 *     reserves the slice's actual size against the byte budget (blocking
 *     if the budget is full) and only THEN releases the build lock for
 *     the next builder.
 *   - Reserved bytes are released when the caller's work (the facet
 *     submit) settles.
 *
 * Invariant: at any instant, Σ(reserved bytes of in-flight submits) +
 * (one building slice, already counted the moment it admits) ≤
 * budgetBytes. With budgetBytes = SLICE_CAP_BYTES the peak matches the
 * single-slot serialization it replaces — no heap regression — while
 * small slices proceed concurrently.
 */
export declare class OnDemandBundleGate {
    private readonly budgetBytes;
    private buildLock;
    private reservedBytes;
    /** FIFO queue of callers blocked on byte-budget headroom. */
    private byteWaiters;
    constructor(budgetBytes: number);
    /**
     * Run a build-then-submit job under the gate.
     *
     * `job` receives an `admit(bytes)` callback it MUST call exactly once,
     * after its slice is built and its real byte size is known, before the
     * long-running submit. `admit` reserves the bytes and releases the
     * build lock so the next job can start building. Jobs that bail before
     * building a slice (early return / error) simply never call `admit`;
     * the build lock is released when `job` settles either way.
     */
    run<T>(job: (admit: (bytes: number) => Promise<void>) => Promise<T>): Promise<T>;
    private acquireBytes;
    private releaseBytes;
    /** Test/diagnostic snapshot. */
    get inFlightBytes(): number;
}
//# sourceMappingURL=on-demand-bundle-gate.d.ts.map