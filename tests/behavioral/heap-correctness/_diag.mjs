// Heap-correctness sub-driver: small helpers around /api/_diag/memory.
//
// These probes are white-box on purpose — they assert against the
// supervisor's reported heap state, not user-facing behaviour. The
// regular black-box driver lives at tests/behavioral/_driver.mjs and
// the heap-correctness probes import its public bits + add this file.

import { BASE } from '../_driver.mjs';

export async function diagMemory(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`diagMemory ${sid}: HTTP ${r.status}`);
  return r.json();
}

/** Pretty-print bytes for log lines. */
export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
