#!/usr/bin/env bun
// Experiment (not for landing): the burn (2e7 rounds of Math.imul) in a Loader worker, written as an ES module,
// a CommonJS module, the CommonJS text wrapped by new Function as an ES module loads, and wrapped by an indirect
// eval; 6 rounds, order rotating. A variant that cannot load says why.
import { BASE, requestHeaders, mintSession, deleteSession } from '../../_driver.mjs';

const out = (record) => console.log(JSON.stringify(record));
const VARIANTS = ['esm', 'cjs', 'fn', 'eval'];
const sid = await mintSession();
const burn = async (variant, n) => {
  const started = Date.now();
  const r = await fetch(`${BASE}/api/embedder/${sid}/cjs-burn`, { method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid), body: JSON.stringify({ variant, n }), signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 400), clientMs: Date.now() - started };
};
try {
  for (const variant of VARIANTS) out({ kind: 'warmup', variant, ...(await burn(variant, 1)) });
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < VARIANTS.length; k++) {
      const variant = VARIANTS[(k + i) % VARIANTS.length];
      out({ kind: 'burn', variant, i, ...(await burn(variant, 2e7)) });
    }
  }
} finally {
  await deleteSession(sid).catch(() => {});
}
