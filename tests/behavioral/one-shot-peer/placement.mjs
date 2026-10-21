#!/usr/bin/env bun
// one-shot-peer/placement — a session's one-shots run on its warm peer, and
// while they run there the session answers (fabric one-shot-peer.ts).
//
// A second terminal stays attached, so the session's thread is wanted and a
// one-shot may go to the peer (one-shot-peer.ts #threadWanted). Each kind runs
// paired within one session, in the session (its peer forgotten first, so
// the run is placed here) and on the warm peer, order alternating by round:
//   - where each run ran (the session's placement record), its exit and
//     output the same on both;
//   - its wall, and the session's thread held during it (the worst latency of
//     a request to the session every 100 ms).
// Then what the user waits for during a python one-shot importing ten stdlib
// modules, in the session and on the peer: a second terminal's echo, a
// request to a running server, an editor save. On the peer each waits less
// than in the session (medians over the rounds). And three such one-shots at
// once, in the session and on the peer. Then, the second terminal closed and
// no port listening, the session idle: a one-shot runs in the session, and a
// terminal that attaches during it waits for it (what (b) accepts, recorded).
import { BASE, makeAsserter, mintSession, deleteSession, Terminal, heredocCommand, fetchPort, requestHeaders, sleep } from '../_driver.mjs';
import { peer, placement, warmFor, mark, hostsSince, diagLatency, watched, median, holdLive } from './_peer.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('one-shot-peer/placement');
const ROUNDS = 6;
const PY_IMPORTS = 'import email.parser, http.client, json, decimal, asyncio, unittest, xml.dom.minidom, sqlite3, argparse, logging; print(1)';
// Each kind with what it prints when it worked; clang's program is run after it, outside the measured run.
const KINDS = [
  { kind: 'python print', line: 'python3 -c "print(1)"', tags: ['cpython-runner@3'], expect: '1' },
  { kind: 'python imports', line: `python3 -c "${PY_IMPORTS}"`, tags: ['cpython-runner@3'], expect: '1' },
  { kind: 'ruby requires', line: `ruby -e "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1"`, tags: ['ruby-runner'], expect: '1' },
  { kind: 'clang', line: 'rm -f x && clang x.c -o x', tags: ['clang-runner-clang', 'clang-runner-wasm-ld'], then: { line: './x', expect: '42' } },
  { kind: 'tsc noEmit', line: 'cd ~/tsp && tsc -p . --noEmit; echo tsc=$?; cd ~', tags: ['tsrs'], expect: 'tsc=0' },
];
/** What a run printed, a line each, without the command's echo and the next prompt. */
const printed = (output) => output.split('\n').slice(1).map((line) => line.trim()).filter((line) => line !== '' && !line.endsWith('$'));
const PORT = 4391;
// It ends itself on a request to /exit: the probe's idle phase stops it so.
const SERVER = `require('http').createServer((req, res) => { res.end('ok ' + req.url); if (req.url === '/exit') setTimeout(() => process.exit(0), 50); }).listen(${PORT});\n`;
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
  return { host, kind, ms: w.ms, worst: w.worst, exit: w.value.exitCode, printed: printed(w.value.output), ranOn: await hostsSince(sid, marked) };
}

try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t2.connect();
  await t2.waitForPrompt(60_000);
  const releaseT2 = holdLive(t2);
  for (const line of ['nimbus install python', 'nimbus install ruby', 'nimbus install clang', heredocCommand('x.c', CSRC), 'mkdir -p ~/tsp/src',
    heredocCommand('tsp/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', noEmit: true }, include: ['src'] })),
    ...TS_FILES.map(([path, body]) => heredocCommand(`tsp/${path}`, body)), heredocCommand('srv.js', SERVER)]) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 60)}: ${r.output.slice(-300)}`);
  }

  // Each kind, paired. The first run of each warms the session's own worker.
  for (const { kind, line, tags, expect, then } of KINDS) {
    await runOn('session', kind, line, tags);
    for (let i = 1; i <= ROUNDS; i++) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
        const r = await runOn(host, kind, line, tags);
        const after = then ? printed((await t.run(then.line, 60_000)).output) : null;
        out({ round: i, ...r, after });
      }
    }
    const runs = records.filter((r) => r.kind === kind && r.round !== undefined);
    a.check(`${kind}: each run ran where it was placed`, runs.every((r) => r.ranOn.length > 0 && r.ranOn.every((h) => h === r.host)), JSON.stringify(runs.map((r) => [r.host, r.ranOn])));
    a.check(`${kind}: it worked on both hosts (exit 0, ${expect ?? `then ${then.line} printed ${then.expect}`})`,
      runs.every((r) => r.exit === 0 && (expect === undefined ? r.after?.at(-1) === then.expect : r.printed.at(-1) === expect)),
      JSON.stringify(runs.map((r) => [r.host, r.exit, r.printed.slice(-3), r.after])));
  }

  // What the user waits for during a python one-shot importing ten stdlib modules.
  await t.run('node srv.js &', 60_000);
  for (let ready = null, until = Date.now() + 30_000; ready?.status !== 200;) {
    if (Date.now() > until) throw new Error(`server never answered: ${ready?.status}`);
    ready = await fetchPort(sid, PORT, 'ready').catch(() => null);
    if (ready?.status !== 200) await sleep(200);
  }
  // Each observer checks its own answer: the echoed word, the server's body, the saved bytes (read back after the rounds).
  let lastSaved = null;
  const OBSERVERS = {
    echo: async () => {
      const started = Date.now();
      const r = await t2.run('echo observed', 60_000);
      if (r.exitCode !== 0 || !printed(r.output).includes('observed')) throw new Error(`echo: ${r.output.slice(-200)}`);
      return Date.now() - started;
    },
    preview: async () => {
      const r = await fetchPort(sid, PORT, 'x');
      if (r.status !== 200 || r.body !== 'ok /x') throw new Error(`preview ${r.status} ${r.body.slice(0, 80)}`);
      return r.elapsed;
    },
    save: async () => {
      const started = Date.now();
      const content = `saved ${started}\n`;
      const r = await fetch(`${BASE}/s/${sid}/api/write-file`, { method: 'POST', headers: requestHeaders({ 'content-type': 'application/json' }, sid),
        body: JSON.stringify({ path: '/home/user/saved.txt', content }), signal: AbortSignal.timeout(60_000) });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`save ${r.status}`);
      lastSaved = content.trim();
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
        if (observer === 'save') {
          // What this round's saves wrote, read back outside its timing: the last of them.
          const saved = printed((await t.run('cat /home/user/saved.txt', 30_000)).output);
          a.check(`save round ${i} (${host}): the file holds its last save`, lastSaved !== null && saved.includes(lastSaved), JSON.stringify({ lastSaved, saved }));
        }
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
      // Three processes' output interleaves on one terminal ("111", "1" then "11"): count the 1s.
      const ones = printed(w.value.output).filter((line) => /^1+$/.test(line)).join('').length;
      a.check(`three at once, round ${i}: all three ran where placed (${host}) and each printed its 1`,
        ranOn.length === 3 && ranOn.every((h) => h === host) && ones === 3 && w.value.exitCode === 0, JSON.stringify({ ranOn, printed: printed(w.value.output) }));
    }
  }

  // Idle: the second terminal closed, the server stopped.
  await fetchPort(sid, PORT, 'exit').catch(() => null);
  releaseT2();
  await t2.close();
  for (let until = Date.now() + 30_000; ;) {
    const status = await fetchPort(sid, PORT, 'gone').then((r) => r.status).catch(() => 0);
    if (status !== 200) break;
    if (Date.now() > until) throw new Error(`the server never stopped: ${(await t.run('ps', 30_000)).output.split('\n').filter((line) => /node/.test(line)).join('\n')}`);
    await sleep(500);
  }
  // Each source alone, the others absent: the run goes to the warm peer, and says which wanted the thread.
  // (The first run of each warms the peer: wanted and cold, it runs in the session.)
  const PY_PRINT = 'python3 -c "print(1)"';
  const runAndPlace = async (line) => {
    const marked = await mark(sid);
    const r = await t.run(line, 600_000);
    return { r, calls: ((await placement(sid))?.calls ?? []).filter((call) => call.at > marked) };
  };
  const idle = await runAndPlace(heavy.line);
  a.check('idle, a one-shot runs in the session and says nothing wanted the thread',
    idle.r.exitCode === 0 && printed(idle.r.output).includes('1') && idle.calls.length > 0 && idle.calls.every((call) => call.host === 'session' && call.wants.length === 0),
    JSON.stringify(idle.calls));
  const SOURCES = {
    terminal: {
      start: async () => {
        const other = new Terminal(sid, { terminal: 'source' });
        await other.connect();
        await other.waitForPrompt(60_000);
        const release = holdLive(other);
        return () => { release(); return other.close(); };
      },
    },
    process: { start: async () => { await t.run('sleep 600 & echo $! > sleeper.pid', 60_000); return () => t.run('kill "$(cat sleeper.pid)"; true', 60_000); } },
  };
  // A save that comes during an idle session's run waits for it: the cost this placement accepts, recorded.
  const idleSaves = await watched(() => runAndPlace(heavy.line), OBSERVERS.save);
  const idleSaved = printed((await t.run('cat /home/user/saved.txt', 30_000)).output);
  out({ idleSave: true, worstMs: idleSaves.worst, samples: idleSaves.samples, placed: idleSaves.value.calls.map((call) => ({ host: call.host, wants: call.wants })) });
  a.check(`a save during an idle session's run waits for it (worst ${idleSaves.worst} ms): the run stays in the session, the save lands`,
    idleSaves.value.r.exitCode === 0 && printed(idleSaves.value.r.output).includes('1')
      && idleSaves.value.calls.length > 0 && idleSaves.value.calls.every((call) => call.host === 'session' && call.wants.length === 0)
      && lastSaved !== null && idleSaved.includes(lastSaved),
    JSON.stringify({ worst: idleSaves.worst, printed: printed(idleSaves.value.r.output), calls: idleSaves.value.calls, lastSaved, idleSaved }));
  for (const [source, { start }] of Object.entries(SOURCES)) {
    const stop = await start();
    await t.run(PY_PRINT, 600_000);
    await warmFor(sid, 'cpython-runner@3');
    const placed = await runAndPlace(PY_PRINT);
    await stop();
    out({ source, placed: placed.calls.map((call) => ({ host: call.host, wants: call.wants })) });
    a.check(`${source} alone wants the thread: the run goes to the warm peer and says so`,
      placed.r.exitCode === 0 && printed(placed.r.output).includes('1') && placed.calls.length > 0
        && placed.calls.every((call) => call.host === 'peer' && call.wants.length === 1 && call.wants[0] === source),
      JSON.stringify(placed.calls));
  }
  await peer(sid, 'forget');
  // Mid-run: a terminal attaches while an idle run is still running, and its echo waits for the run.
  // The run says it started before its imports, the work that holds the thread.
  const marked = await mark(sid);
  const late = new Terminal(sid, { terminal: 'late' });
  t.reset();
  // The marker is spelled in two pieces, so the command's own echo never matches it.
  t.cmd(`python3 -c "print('STAR' + 'TED', flush=True); ${PY_IMPORTS}"`);
  const submission = t.submission;
  // The terminal's view since reset, its escapes stripped (waitFor's argument): the raw stream carries them.
  await t.waitFor((view) => printed(view).includes('STARTED'), 60_000, 'the run to start');
  const attachedDuringRun = submission.end === null;
  const attachStarted = Date.now();
  await late.connect();
  await late.waitForPrompt(60_000);
  const echo = await late.run('echo late', 60_000);
  const lateWait = Date.now() - attachStarted;
  let ended = '';
  await t.waitFor((view) => { ended = view; return submission.end !== null; }, 600_000, 'the run to end');
  const midOutput = printed(ended);
  const midOn = ((await placement(sid))?.calls ?? []).filter((call) => call.at > marked);
  out({ midRun: true, lateWaitMs: lateWait, attachedDuringRun, exit: submission.exitCode, placed: midOn.map((call) => ({ host: call.host, wants: call.wants })) });
  a.check(`a terminal that attaches mid-run waits for the run (${lateWait} ms to attach and echo): the run stays where it started`,
    attachedDuringRun && submission.exitCode === 0 && midOutput.includes('1') && echo.exitCode === 0 && printed(echo.output).includes('late')
      && midOn.length > 0 && midOn.every((call) => call.host === 'session' && call.wants.length === 0),
    JSON.stringify({ lateWait, attachedDuringRun, exit: submission.exitCode, midOutput, midOn }));
  await late.close();
} catch (error) {
  a.check('the probe ran to its end', false, String(error?.stack ?? error).slice(0, 2000));
} finally {
  await t2.close().catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const { fail } = a.summary();
process.exit(fail > 0 ? 1 : 0);
