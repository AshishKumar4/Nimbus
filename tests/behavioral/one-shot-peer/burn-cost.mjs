#!/usr/bin/env bun
// Experiment (not for landing): a one-shot's fixed cost on the peer and its
// compute speed there, against the session, paired: a pure burn as a warm
// one-shot facet, with no preamble and with the WASI preamble (~600 KB), at
// n=1 (the call's own cost) and n=2e7.
import { mintSession, deleteSession, BASE, requestHeaders, sleep } from '../_driver.mjs';
import { placement } from './_peer.mjs';

const out = (record) => console.log(JSON.stringify(record));
const sid = await mintSession();
const burn = async (forget, preamble, n) => {
  const started = Date.now();
  const r = await fetch(`${BASE}/api/embedder/${sid}/one-shot-peer`, { method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid),
    body: JSON.stringify({ action: 'burn', forget, preamble, n }), signal: AbortSignal.timeout(120_000) });
  const body = await r.json();
  if (!r.ok) throw new Error(`burn: ${r.status} ${JSON.stringify(body)}`);
  return { ...body, clientMs: Date.now() - started };
};
const warm = async (preamble) => {
  const until = Date.now() + 35_000;
  while (!Object.keys((await placement(sid))?.warm ?? {}).some((k) => k.startsWith(`burn-probe-${preamble}\n`))) {
    if (Date.now() > until) throw new Error(`not warm: ${JSON.stringify(await placement(sid))}`);
    await sleep(200);
  }
};
try {
  for (const preamble of ['none', 'wasi']) {
    await burn(true, preamble, 1);
    await burn(true, preamble, 1);
    for (let i = 1; i <= 6; i++) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
        for (const n of [1, 2e7]) {
          if (host === 'peer') await warm(preamble);
          const r = await burn(host === 'session', preamble, n);
          const ranOn = (await placement(sid))?.calls?.at(-1)?.host;
          out({ preamble, round: i, host, n, ranOn, ms: r.ms, clientMs: r.clientMs });
        }
      }
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await deleteSession(sid).catch(() => {});
}
