#!/usr/bin/env bun
// one-shot-peer/placement — a session's one-shots run on its warm peer, and
// while they run there the session answers (fabric one-shot-peer.ts).
//
// Each kind runs paired within one session, in the session (its peer
// forgotten first, so the run is placed here) and on the warm peer, order
// alternating by round:
//   - where each run ran (the session's placement record), its exit and
//     output the same on both;
//   - its wall, and the session's thread held during it (the worst latency of
//     a request to the session every 100 ms).
// Then what the user waits for during a python one-shot importing ten stdlib
// modules, in the session and on the peer: a second terminal's echo, a
// request to a running server, an editor save. On the peer each waits less
// than in the session (medians over the rounds). And three such one-shots at
// once, in the session and on the peer.
import { BASE, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, fetchPort, requestHeaders, sleep } from '../_driver.mjs';
import { peer, placement, warmFor, mark, hostsSince, diagLatency, watched, median } from './_peer.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('one-shot-peer/placement');
const ROUNDS = 6;
const PY_IMPORTS = 'import email.parser, http.client, json, decimal, asyncio, unittest, xml.dom.minidom, sqlite3, argparse, logging; print(1)';
const KINDS = [
  { kind: 'python print', line: 'python3 -c "print(1)"', tags: ['cpython-runner@3'] },
  { kind: 'python imports', line: `python3 -c "${PY_IMPORTS}"`, tags: ['cpython-runner@3'] },
  { kind: 'ruby requires', line: `ruby -e "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1"`, tags: ['ruby-runner'] },
  { kind: 'clang', line: 'clang x.c -o x', tags: ['clang-runner-clang', 'clang-runner-wasm-ld'] },
  { kind: 'tsc noEmit', line: 'cd ~/tsp && tsc -p . --noEmit; echo tsc=$?; cd ~', tags: ['tsrs'] },
];
const PORT = 4391;
const SERVER = `require('http').createServer((req, res) => res.end('ok ' + req.url)).listen(${PORT});\n`;
const TS_FILES = Array.from({ length: 12 }, (_, i) => [`src/m${i}.ts`,
  `export interface Shape${i} { id: number; name: string }\nexport const all${i}: Shape${i}[] = Array.from({ length: 50 }, (_, k) => ({ id: k, name: 'm${i}-' + k }));\n`]);
const CSRC = '#include <stdio.h>\nint main(void) { printf("%d\\n", 6 * 7); return 0; }\n';
const records = [];
const out = (record) => { records.push(record); console.log(JSON.stringify(record)); };

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
const t2 = new Terminal(sid, { terminal: 'observer' });
/** The tag a run's facet carries begins with one of `tags`; a warm one is keyed `${tag}\n…`. */
const tagOf = async (tags) => {
  for (const tag of tags) {
    try { await warmFor(sid, tag); } catch (error) { return { tag, error }; }
  }
  return { tag: tags[0] };
};
/** One run of `line`, placed on `host`: forgotten peer for the session, a warm one for the peer. */
async function runOn(host, kind, line, tags, observe = () => diagLatency(sid)) {
  if (host === 'session') await peer(sid, 'forget');
  else {
    const warm = await tagOf(tags);
    if (warm.error) throw warm.error;
  }
  const marked = await mark(sid);
  const w = await watched(() => t.run(line, 600_000), observe);
  return { host, kind, ms: w.ms, worst: w.worst, exit: w.value.exitCode, output: w.value.output.split('\n').slice(1).join('\n').trim(), ranOn: await hostsSince(sid, marked) };
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of ['nimbus install python', 'nimbus install ruby', 'nimbus install clang', heredocCommand('x.c', CSRC), 'mkdir -p ~/tsp/src',
    heredocCommand('tsp/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', noEmit: true }, include: ['src'] })),
    ...TS_FILES.map(([path, body]) => heredocCommand(`tsp/${path}`, body)), heredocCommand('srv.js', SERVER)]) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }

  // Each kind, paired. The first run of each warms the session's own worker.
  for (const { kind, line, tags } of KINDS) {
    await runOn('session', kind, line, tags);
    for (let i = 1; i <= ROUNDS; i++) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) out({ round: i, ...(await runOn(host, kind, line, tags)) });
    }
    const runs = records.filter((r) => r.kind === kind && r.round !== undefined);
    a.check(`${kind}: each run ran where it was placed`, runs.every((r) => r.ranOn.length > 0 && r.ranOn.every((h) => h === r.host)), JSON.stringify(runs.map((r) => [r.host, r.ranOn])));
    a.check(`${kind}: the same exit and output on both hosts`, runs.every((r) => r.exit === runs[0].exit && r.output === runs[0].output),
      JSON.stringify(runs.map((r) => [r.host, r.exit, r.output.slice(-80)])));
  }

  // What the user waits for during a python one-shot importing ten stdlib modules.
  await t2.connect();
  await t2.waitForPrompt(60_000);
  await t.run('node srv.js &', 60_000);
  for (let ready = null, until = Date.now() + 30_000; ready?.status !== 200;) {
    if (Date.now() > until) throw new Error(`server never answered: ${ready?.status}`);
    ready = await fetchPort(sid, PORT, 'ready').catch(() => null);
    if (ready?.status !== 200) await sleep(200);
  }
  const OBSERVERS = {
    echo: async () => { const started = Date.now(); const r = await t2.run('echo x', 60_000); if (r.exitCode !== 0) throw new Error('echo'); return Date.now() - started; },
    preview: async () => { const r = await fetchPort(sid, PORT, 'x'); if (r.status !== 200) throw new Error(`preview ${r.status}`); return r.elapsed; },
    save: async () => {
      const started = Date.now();
      const r = await fetch(`${BASE}/s/${sid}/api/write-file`, { method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid),
        body: JSON.stringify({ path: '/home/user/saved.txt', content: `saved ${started}\n` }), signal: AbortSignal.timeout(60_000) });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`save ${r.status}`);
      return Date.now() - started;
    },
  };
  const heavy = KINDS[1];
  for (const [observer, observe] of Object.entries(OBSERVERS)) {
    const waits = { session: [], peer: [] };
    for (let i = 1; i <= 5; i++) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
        const r = await runOn(host, heavy.kind, heavy.line, heavy.tags, observe);
        out({ observer, round: i, host, ms: r.ms, worst: r.worst, ranOn: r.ranOn });
        a.check(`${observer} round ${i}: ran where placed (${host})`, r.ranOn.length > 0 && r.ranOn.every((h) => h === host), JSON.stringify(r.ranOn));
        waits[host].push(r.worst);
      }
    }
    a.check(`${observer}: waits less while the run is on the peer (median of worst waits ${median(waits.peer)} ms, against ${median(waits.session)} ms in the session)`,
      median(waits.peer) < median(waits.session), JSON.stringify(waits));
  }

  // Three at once.
  const three = `${heavy.line} & ${heavy.line} & ${heavy.line} & wait`;
  await peer(sid, 'forget');
  await t.run(three, 600_000);
  for (let i = 1; i <= 3; i++) {
    for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
      if (host === 'session') await peer(sid, 'forget');
      else {
        const until = Date.now() + 35_000;
        while (Object.keys((await placement(sid))?.warm ?? {}).filter((key) => key.startsWith('cpython-runner@3\n')).length < 3) {
          if (Date.now() > until) throw new Error('the peer was not warm for three python workers within 35 s');
          await sleep(250);
        }
      }
      const marked = await mark(sid);
      const w = await watched(() => t.run(three, 600_000), () => diagLatency(sid));
      const ranOn = await hostsSince(sid, marked);
      out({ three: true, round: i, host, ms: w.ms, worst: w.worst, exit: w.value.exitCode, ranOn });
      a.check(`three at once, round ${i}: all three ran where placed (${host})`, ranOn.length === 3 && ranOn.every((h) => h === host), JSON.stringify(ranOn));
    }
  }
} catch (error) {
  a.check('the probe ran to its end', false, String(error?.stack ?? error).slice(0, 2000));
} finally {
  await t2.close().catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const { fail } = a.summary();
process.exit(fail > 0 ? 1 : 0);
