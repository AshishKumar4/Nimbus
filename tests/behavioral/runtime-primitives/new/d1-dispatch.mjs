#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): where a dynamic Worker's CPU
// runs, and which one-shots hold the session's thread today.
//   - burn: the same synchronous work (apps/probe NimbusSession._rpcD1Burn) run
//     inline in the session, in a Loader worker the session calls, in one a
//     stateless invocation calls, in a facet, in another session's Loader
//     worker, and in one a request through the edge calls; at n=1 (the
//     dispatch's own cost) and at n=N (about a second of work).
//   - kinds: today's one-shots of every runtime, run in the terminal.
// Each call is watched from outside by a request to the session every 100 ms
// while it runs; a held thread answers late.
import { mintSession, deleteSession, Terminal, sleep, requestHeaders, BASE } from '../../_driver.mjs';

const ROUNDS = Number(process.env.D1_ROUNDS ?? 8);
const out = (record) => console.log(JSON.stringify(record));
const heredoc = (path, body) => `cat > ${path} <<'NIMBUS_EOF'\n${body}NIMBUS_EOF`;
const VIAS = ['inline', 'do', 'stateless', 'facet', 'peer', 'edge'];
const PY = 'import email.parser, http.client, json, decimal, asyncio, unittest, xml.dom.minidom, sqlite3, argparse, logging; print(1)';
const RB = "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1";
const KINDS = {
  'node print': 'node -e "console.log(1)"',
  'node burn': 'node -e "let h=0;for(let i=0;i<2e8;i++)h=Math.imul(h^i,16777619);console.log(h)"',
  'tsc noEmit': 'cd ~/tsp && tsc -p . --noEmit; cd ~',
  'git status': 'cd ~/repo && git status --short | wc -l; cd ~',
  'clang': 'clang x.c -o x',
  'python oneshot': `python3 -c "${PY}"`,
  'ruby oneshot': `ruby -e "${RB}"`,
};
const TS_FILES = Array.from({ length: 12 }, (_, i) => [`src/m${i}.ts`,
  `export interface Shape${i} { id: number; name: string; tags: readonly string[] }\n` +
  `export function make${i}(id: number): Shape${i} { return { id, name: 'm${i}-' + id, tags: [String(id)] }; }\n` +
  `export const all${i}: Shape${i}[] = Array.from({ length: 50 }, (_, k) => make${i}(k));\n`]);
const CSRC = '#include <stdio.h>\n#include <string.h>\nint main(void) { char b[64]; snprintf(b, sizeof b, "%d", 42); puts(b); return (int)strlen(b) - 2; }\n';

async function diag(sid) {
  const started = Date.now();
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(60_000) });
  if (r.ok) await r.arrayBuffer();
  return Date.now() - started;
}

async function burn(sid, via, n) {
  const r = await fetch(`${BASE}/api/embedder/${sid}/d1-burn`, {
    method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid), body: JSON.stringify({ via, n }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`burn ${via} ${n}: ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Runs `call`, polling the session meanwhile; the poll latencies say how long its thread was held. */
async function watched(sid, call) {
  let running = true;
  const polls = [];
  const poller = (async () => {
    while (running) {
      polls.push(await diag(sid).catch(() => -1));
      await sleep(100);
    }
  })();
  const startedAt = Date.now();
  try {
    const value = await call();
    return { value, startedAt, ms: Date.now() - startedAt, polls };
  } finally {
    running = false;
    await poller;
  }
}
const pollStats = (polls) => {
  const sorted = [...polls].sort((a, b) => a - b);
  return { polls: polls.length, pollMaxMs: sorted.at(-1) ?? 0, pollMedianMs: sorted[Math.floor(sorted.length / 2)] ?? null };
};

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const via of VIAS) out({ kind: 'burn-warmup', via, ...(await burn(sid, via, 1).catch((e) => ({ error: String(e.message ?? e) }))) });
  // N from the inline burn's own wall (a clock in the isolate stands still while it computes).
  const base = (await watched(sid, () => burn(sid, 'inline', 1))).ms;
  const probe = (await watched(sid, () => burn(sid, 'inline', 2e8))).ms;
  const N = Math.round(2e8 * 1000 / Math.max(1, probe - base));
  out({ kind: 'calibrate', base, probe, N });
  for (let i = 1; i <= ROUNDS; i++) {
    for (let k = 0; k < VIAS.length; k++) {
      const via = VIAS[(k + i) % VIAS.length];
      for (const n of [1, N]) {
        const w = await watched(sid, () => burn(sid, via, n).catch((e) => ({ error: String(e.message ?? e).slice(0, 300) })));
        out({ kind: 'burn', via, n, i, startedAt: w.startedAt, ms: w.ms, sessionMs: w.value.ms ?? null, error: w.value.error, ...pollStats(w.polls) });
      }
    }
  }

  const setup = [
    'nimbus install python', 'nimbus install ruby', 'nimbus install clang',
    heredoc('x.c', CSRC),
    'mkdir -p ~/tsp/src',
    heredoc('tsp/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }) + '\n'),
    ...TS_FILES.map(([path, body]) => heredoc(`tsp/${path}`, body)),
    'mkdir -p ~/repo && cd ~/repo && git init -q && for i in $(seq 1 200); do echo "line $i" > f$i.txt; done && git add -A && git -c user.email=p@x -c user.name=p commit -qm one && for i in $(seq 1 20); do echo more >> f$i.txt; done; cd ~',
  ];
  for (const line of setup) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }
  for (const [kind, line] of Object.entries(KINDS)) {
    const w = await watched(sid, () => t.run(line, 600_000));
    out({ kind: 'cold', arm: kind, ms: w.ms, exit: w.value.exitCode, tail: w.value.output.slice(-160), ...pollStats(w.polls) });
  }
  const kinds = Object.entries(KINDS);
  for (let i = 1; i <= ROUNDS; i++) {
    for (let k = 0; k < kinds.length; k++) {
      const [kind, line] = kinds[(k + i) % kinds.length];
      const w = await watched(sid, () => t.run(line, 600_000));
      out({ kind: 'warm', arm: kind, i, startedAt: w.startedAt, ms: w.ms, exit: w.value.exitCode, ...pollStats(w.polls) });
    }
  }
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
