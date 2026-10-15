/**
 * WASI's clocks (preview1 clockid), as every host that runs a guest answers
 * them (bash/preamble.ts, the worker's runtime/wasi/preamble.ts): REALTIME
 * is the wall clock; MONOTONIC and the two CPU-time clocks are the monotonic
 * one, so a guest that asks for monotonic never gets wall time back. Any
 * other id names no clock: clock_time_get, clock_res_get and a poll's clock
 * subscription each answer it EINVAL.
 */

export const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1, CLOCK_PROCESS_CPUTIME = 2, CLOCK_THREAD_CPUTIME = 3;

const isClock = (id: number | undefined): boolean =>
  id === CLOCK_REALTIME || id === CLOCK_MONOTONIC || id === CLOCK_PROCESS_CPUTIME || id === CLOCK_THREAD_CPUTIME;

export function realtimeNs(): bigint { return BigInt(Date.now()) * 1000000n; }

export function monotonicNs(): bigint {
  const ms = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  return BigInt(Math.floor(ms * 1000)) * 1000n;
}

/** Clock `id`'s reading now, in nanoseconds; null for an id that names no clock (or none). */
export function clockNs(id: number | undefined): bigint | null {
  if (!isClock(id)) return null;
  return id === CLOCK_REALTIME ? realtimeNs() : monotonicNs();
}

/** Clock `id`'s resolution, in nanoseconds; null for an id that names no clock. */
export function clockResolutionNs(id: number): bigint | null {
  if (!isClock(id)) return null;
  return id === CLOCK_REALTIME ? 1000000n : 1000n;
}
