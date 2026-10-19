// Heap-correctness sub-driver: small helpers around /api/_diag/memory.
//
// These probes are white-box on purpose — they assert against the
// supervisor's reported heap state, not user-facing behaviour. The
// regular black-box driver lives at tests/behavioral/_driver.mjs and
// the heap-correctness probes import its public bits + add this file.

import { BASE, requestHeaders, sleep } from '../_driver.mjs';

export async function diagMemory(sid, signal) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`, { cache: 'no-store', headers: requestHeaders({}, sid), signal });
  if (!r.ok) throw Object.assign(new Error(`diagMemory ${sid}: HTTP ${r.status}`), { status: r.status });
  return r.json();
}

/**
 * Samples `sid`'s /api/_diag/memory into `take` until the returned stop is
 * awaited: one read at a time, `everyMs` apart. A read refused 503 (the
 * session's queue too old: "Durable Object is overloaded") waits twice as
 * long as the last before the next, up to 4 s, since a read sent at once
 * would only add to that queue. Stop resolves to how many reads were refused.
 */
export function sampleDiagMemory(sid, take, { everyMs = 250 } = {}) {
  let sampling = true;
  let refused = 0;
  const loop = (async () => {
    let pause = everyMs;
    while (sampling) {
      try {
        take(await diagMemory(sid));
        pause = everyMs;
      } catch (error) {
        if (error.status === 503) refused += 1;
        pause = error.status === 503 ? Math.min(pause * 2, 4_000) : everyMs;
      }
      await sleep(pause);
    }
  })();
  return async () => {
    sampling = false;
    await loop;
    return refused;
  };
}

/** Pretty-print bytes for log lines. */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
