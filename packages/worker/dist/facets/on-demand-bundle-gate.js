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
export class OnDemandBundleGate {
    budgetBytes;
    buildLock = Promise.resolve();
    reservedBytes = 0;
    /** FIFO queue of callers blocked on byte-budget headroom. */
    byteWaiters = [];
    constructor(budgetBytes) {
        this.budgetBytes = budgetBytes;
        if (budgetBytes <= 0)
            throw new Error('OnDemandBundleGate budgetBytes must be > 0');
    }
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
    async run(job) {
        // Acquire the build lock (serialize slice construction).
        const prev = this.buildLock;
        let releaseBuild;
        this.buildLock = new Promise((res) => { releaseBuild = res; });
        await prev;
        let admittedBytes = 0;
        let buildReleased = false;
        const releaseBuildOnce = () => {
            if (!buildReleased) {
                buildReleased = true;
                releaseBuild();
            }
        };
        const admit = async (bytes) => {
            const clamped = Math.max(0, Math.min(bytes, this.budgetBytes));
            await this.acquireBytes(clamped);
            admittedBytes = clamped;
            // Slice is now accounted against the budget — let the next slice build.
            releaseBuildOnce();
        };
        try {
            return await job(admit);
        }
        finally {
            // If the job never admitted (bailed pre-build), free the build lock now.
            releaseBuildOnce();
            if (admittedBytes > 0)
                this.releaseBytes(admittedBytes);
        }
    }
    acquireBytes(bytes) {
        // Admit when the reservation fits, OR when nothing is reserved (so a
        // single slice larger than the budget still makes progress instead of
        // deadlocking). FIFO: a waiter that doesn't fit blocks later waiters
        // even if they would, to avoid starving large slices.
        if (this.byteWaiters.length === 0 &&
            (this.reservedBytes + bytes <= this.budgetBytes || this.reservedBytes === 0)) {
            this.reservedBytes += bytes;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.byteWaiters.push({ bytes, resolve });
        });
    }
    releaseBytes(bytes) {
        this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
        // Wake head-of-line waiters that now fit. Strict FIFO: stop at the
        // first waiter that doesn't fit (unless nothing is reserved, in which
        // case admit it anyway so an oversized slice can't deadlock).
        while (this.byteWaiters.length > 0) {
            const head = this.byteWaiters[0];
            const fits = this.reservedBytes + head.bytes <= this.budgetBytes || this.reservedBytes === 0;
            if (!fits)
                break;
            this.byteWaiters.shift();
            this.reservedBytes += head.bytes;
            head.resolve();
        }
    }
    /** Test/diagnostic snapshot. */
    get inFlightBytes() { return this.reservedBytes; }
}
