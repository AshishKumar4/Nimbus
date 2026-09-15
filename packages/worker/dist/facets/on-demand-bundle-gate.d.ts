/**
 * OnDemandBundleGate — FIFO admission for on-demand /@modules/ bundling.
 *
 * A cold module build allocates its file slice (up to ON_DEMAND_SLICE_CAP_BYTES,
 * ~28 MiB) in the supervisor heap BEFORE anything about its size is known, so
 * admission must be decided before the job body runs — a byte budget checked
 * after the build only accounts for memory that already exists. The on-demand
 * IsolatePool has a single slot, so building slices speculatively in parallel
 * adds resident bytes without adding any execution overlap. The gate therefore
 * runs one job at a time, start to settle: the slice, the facet RPC, and the
 * response construction for job N+1 do not begin until job N has released
 * everything it held. Bounded peak = one slice.
 */
export declare class OnDemandBundleGate {
    private tail;
    /** Run `job` after every previously queued job has settled. */
    run<T>(job: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=on-demand-bundle-gate.d.ts.map