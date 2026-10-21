#!/usr/bin/env bun
// Experiment (not for landing): where a clang compile+link's time goes, in the
// session and on its peer, paired, 8 rounds. Per call, from three records:
// the session's placement (its wall for the call, either host), each side's
// own facet calls (the loader call's wall where the task ran), and the
// resident filesystem's waits on the session (NIMBUS_WASI_FS_STATS=1).
import { mintSession, deleteSession, Terminal, heredocCommand, BASE, requestHeaders } from '../_driver.mjs';
import { peer, placement, warmFor, mark } from './_peer.mjs';

const out = (record) => console.log(JSON.stringify(record));
const LINE = 'rm -f x && NIMBUS_WASI_FS_STATS=1 clang x.c -o x';
const TAGS = ['clang-runner-clang', 'clang-runner-wasm-ld'];
const sid = await mintSession();
const t = new Terminal(sid);
const sessionFacetCalls = async () => {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`, { headers: requestHeaders({}, sid) });
  return (await r.json()).launch?.facetCalls ?? [];
};
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of ['nimbus install clang', heredocCommand('x.c', '#include <stdio.h>\nint main(void) { printf("%d\\n", 6 * 7); return 0; }\n')]) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${r.output.slice(-300)}`);
  }
  await peer(sid, 'forget');
  await t.run(LINE, 600_000);
  for (let i = 1; i <= 8; i++) {
    for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
      if (host === 'session') await peer(sid, 'forget');
      else for (const tag of TAGS) await warmFor(sid, tag);
      const marked = await mark(sid);
      const started = Date.now();
      const r = await t.run(LINE, 600_000);
      const ms = Date.now() - started;
      const calls = ((await placement(sid))?.calls ?? []).filter((c) => c.at > marked).map((c) => ({ tag: c.tag, host: c.host, ms: c.ms }));
      const steps = [...r.output.matchAll(/\[wasi-fs\] (\S+) wallMs=(\d+) (\{.*\}|null)/g)].map((m) => ({ step: m[1], wallMs: Number(m[2]), waitMs: JSON.parse(m[3])?.waitMs, sessionCalls: JSON.parse(m[3])?.sessionCalls }));
      const peerRecord = host === 'peer' ? await peer(sid, 'facet-calls') : null;
      const facetCalls = host === 'peer' ? peerRecord.calls.slice(-2) : (await sessionFacetCalls()).filter((c) => c.tag.startsWith('clang-runner')).slice(-2);
      out({ round: i, host, ms, exit: r.exitCode, calls, steps, facetCalls, spans: peerRecord?.spans.slice(-2) ?? null });
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.stack ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
