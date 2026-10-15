/**
 * WASI's clocks (preview1 clockid), as every host that runs a guest answers
 * them (bash/preamble.ts, the worker's runtime/wasi/preamble.ts): REALTIME
 * is the wall clock; MONOTONIC and the two CPU-time clocks are the monotonic
 * one, so a guest that asks for monotonic never gets wall time back. Any
 * other id names no clock: clock_time_get, clock_res_get and a poll's clock
 * subscription each answer it EINVAL.
 */
export declare const CLOCK_REALTIME = 0;
export declare function realtimeNs(): bigint;
export declare function monotonicNs(): bigint;
/** Clock `id`'s reading now, in nanoseconds; null for an id that names no clock (or none). */
export declare function clockNs(id: number | undefined): bigint | null;
/** Clock `id`'s resolution, in nanoseconds; null for an id that names no clock. */
export declare function clockResolutionNs(id: number): bigint | null;
//# sourceMappingURL=clock.d.ts.map