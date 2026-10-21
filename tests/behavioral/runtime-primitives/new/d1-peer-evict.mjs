#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): how long a session's peer
// stays warm. After each idle gap, a python one-shot on the peer: a warm peer
// answers it in ~0.5-0.9 s, a cold one in ~2.4-3.1 s (verdict
// 20261021T111038-40692a3b802a). Then one more run, warm, before the next gap.
import { mintSession, deleteSession, Terminal, sleep } from '../../_driver.mjs';
import { out, setHost } from './_d1-lib.mjs';

const GAPS_S = [60, 75, 90, 105, 120, 135];
const PY_PRINT = 'python3 -c "print(1)"';

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  const setup = await t.run('nimbus install python', 600_000);
  if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.output.slice(-300)}`);
  await setHost(sid, 'evict');
  const run = async () => {
    const started = Date.now();
    const r = await t.run(PY_PRINT, 600_000);
    return { ms: Date.now() - started, exit: r.exitCode };
  };
  out({ kind: 'evict', gapS: 0, what: 'fresh', ...(await run()) });
  out({ kind: 'evict', gapS: 0, what: 'warm', ...(await run()) });
  for (const gapS of GAPS_S) {
    await sleep(gapS * 1000);
    out({ kind: 'evict', gapS, what: 'after idle', ...(await run()) });
    out({ kind: 'evict', gapS, what: 'warm', ...(await run()) });
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await setHost(sid, null).catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
