#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): what a peer for one-shots costs
// and what a held session thread costs its user.
//   - peer: a python one-shot on a fresh peer (its first call), on the same
//     peer warm, and on it again after 60 s and 150 s idle; and the burn's
//     pure CPU in the session's Loader worker against a peer's.
//   - user: during a python import-heavy one-shot in the session or on a warm
//     peer, what a second terminal's echo, a request to a running server and an
//     editor save (POST /api/write-file) each wait.
import { mintSession, deleteSession, Terminal, sleep, fetchPort, requestHeaders, BASE } from '../../_driver.mjs';
import { out, heredoc, PY_IMPORTS, setHost, burn, watched, sampleStats } from './_d1-lib.mjs';

const ROUNDS = 5;
const PY_PRINT = 'python3 -c "print(1)"';
const PY_HEAVY = `python3 -c "${PY_IMPORTS}"`;
const PORT = 4391;
const SERVER = `require('http').createServer((req, res) => res.end('ok ' + req.url)).listen(${PORT});\n`;

const sid = await mintSession();
const t = new Terminal(sid);
// A second terminal is a named one: the session's own refuses a second socket (verdict 20261021T104436-fce5ef9081af).
const t2 = new Terminal(sid, { terminal: 'observer' });
// A fresh throwaway refused the first terminal once (verdict 20261021T102902-2d0334103516).
async function connect(terminal) {
  for (let attempt = 1; ; attempt++) {
    try { return await terminal.connect(); } catch (error) { if (attempt === 3) throw error; await sleep(2000); }
  }
}
try {
  await connect(t);
  await t.waitForPrompt(60_000);
  for (const line of ['nimbus install python', heredoc('srv.js', SERVER), 'node --watch srv.js']) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }
  for (let ready = null, until = Date.now() + 30_000; ready?.status !== 200;) {
    if (Date.now() > until) throw new Error(`server never answered: ${ready?.status}`);
    ready = await fetchPort(sid, PORT, 'ready').catch(() => null);
    if (ready?.status !== 200) await sleep(200);
  }
  await connect(t2);
  await t2.waitForPrompt(60_000);
  const run = async (line) => {
    const w = await watched(sid, () => t.run(line, 600_000));
    return { startedAt: w.startedAt, ms: w.ms, exit: w.value.exitCode, ...sampleStats(w.samples) };
  };
  await setHost(sid, null);
  await run(PY_PRINT);

  // The peer's cost: first call on a fresh peer, then warm, then after idle.
  for (let f = 1; f <= 3; f++) {
    await setHost(sid, `fresh${f}`);
    out({ kind: 'peer', what: 'fresh', f, ...(await run(PY_PRINT)) });
    for (let w = 1; w <= 3; w++) out({ kind: 'peer', what: 'warm', f, w, ...(await run(PY_PRINT)) });
    await setHost(sid, null);
    out({ kind: 'peer', what: 'session', f, ...(await run(PY_PRINT)) });
  }
  await setHost(sid, 'idle');
  out({ kind: 'peer', what: 'fresh', f: 'idle', ...(await run(PY_PRINT)) });
  out({ kind: 'peer', what: 'warm', f: 'idle', ...(await run(PY_PRINT)) });
  for (const idleS of [60, 150]) {
    await sleep(idleS * 1000);
    out({ kind: 'peer', what: `after ${idleS} s idle`, f: 'idle', ...(await run(PY_PRINT)) });
    out({ kind: 'peer', what: 'warm', f: 'idle', ...(await run(PY_PRINT)) });
  }

  // What the user waits for while a python import-heavy one-shot runs.
  const save = async () => {
    const started = Date.now();
    const r = await fetch(`${BASE}/s/${sid}/api/write-file`, {
      method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid),
      body: JSON.stringify({ path: '/home/user/saved.txt', content: `saved ${started}\n` }), signal: AbortSignal.timeout(60_000),
    });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`save ${r.status}`);
    return Date.now() - started;
  };
  const OBSERVERS = {
    echo: async () => { const started = Date.now(); const r = await t2.run('echo x', 60_000); if (r.exitCode !== 0) throw new Error('echo'); return Date.now() - started; },
    preview: async () => { const r = await fetchPort(sid, PORT, 'x'); if (r.status !== 200) throw new Error(`preview ${r.status}`); return r.elapsed; },
    save,
  };
  await setHost(sid, 'user');
  await run(PY_HEAVY);
  for (const [name, observe] of Object.entries(OBSERVERS)) {
    const idle = [];
    for (let k = 0; k < 10; k++) { idle.push(await observe()); await sleep(100); }
    out({ kind: 'user-idle', observer: name, ...sampleStats(idle) });
    for (let i = 1; i <= ROUNDS; i++) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
        await setHost(sid, host === 'peer' ? 'user' : null);
        const w = await watched(sid, () => t.run(PY_HEAVY, 600_000), observe);
        out({ kind: 'user', observer: name, host, i, startedAt: w.startedAt, ms: w.ms, exit: w.value.exitCode, ...sampleStats(w.samples) });
      }
    }
  }

  // Pure CPU: the burn in the session's Loader worker against a peer's, paired.
  await setHost(sid, null);
  for (const via of ['do', 'peer']) await burn(sid, via, 1);
  const base = (await watched(sid, () => burn(sid, 'inline', 1))).ms;
  const probe = (await watched(sid, () => burn(sid, 'inline', 2e8))).ms;
  const N = Math.round(2e8 * 1000 / Math.max(1, probe - base));
  out({ kind: 'calibrate', base, probe, N });
  for (let i = 1; i <= ROUNDS; i++) {
    for (const via of i % 2 ? ['do', 'peer'] : ['peer', 'do']) {
      for (const n of [1, N]) {
        const w = await watched(sid, () => burn(sid, via, n));
        out({ kind: 'burn', via, n, i, startedAt: w.startedAt, ms: w.ms, sessionMs: w.value.ms, ...sampleStats(w.samples) });
      }
    }
  }
  out({ kind: 'peer-stats', ...(await setHost(sid, 'user', true)) });
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await setHost(sid, null).catch(() => {});
  await t2.close().catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
