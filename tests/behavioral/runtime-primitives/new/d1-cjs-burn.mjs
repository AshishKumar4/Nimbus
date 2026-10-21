#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): a plain Loader worker's burn
// (2e8 rounds of Math.imul, a global read each round) in an ES module against
// the same burn in a CommonJS module of its map, paired, 6 rounds.
import { mintSession, deleteSession } from '../../_driver.mjs';
import { out, burn } from './_d1-lib.mjs';

const sid = await mintSession();
try {
  for (const via of ['do', 'do-cjs']) out({ kind: 'warmup', via, ...(await burn(sid, via, 1)) });
  for (let i = 0; i < 6; i++) {
    for (const via of i % 2 ? ['do', 'do-cjs'] : ['do-cjs', 'do']) {
      const started = Date.now();
      const r = await burn(sid, via, 2e7);
      out({ kind: 'burn', via, i, ms: Date.now() - started, result: r.result });
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await deleteSession(sid).catch(() => {});
}
