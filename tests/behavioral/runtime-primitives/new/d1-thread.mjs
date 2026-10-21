#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): whether a Python or Ruby
// script's run holds the session's thread, as a one-shot and as a resident.
// Each run is watched two ways:
//   - the session's own stall record (thread-stalls.ts, held across each
//     one-shot's submit and each resident's boot on this branch), read after;
//   - from outside, a request to the session every 100 ms while it runs,
//     each one's latency (a held thread answers late).
import { mintSession, deleteSession, Terminal, sleep, requestHeaders, BASE } from '../../_driver.mjs';

const ROUNDS = Number(process.env.D1_ROUNDS ?? 8);
const out = (record) => console.log(JSON.stringify(record));
const heredoc = (path, body) => `cat > ${path} <<'NIMBUS_EOF'\n${body}NIMBUS_EOF`;
const PY = 'import email.parser, http.client, json, decimal, asyncio, unittest, xml.dom.minidom, sqlite3, argparse, logging; print(1)';
const RB = "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1";
// Which of a python run's cost is its stdlib's: the same run with no imports,
// and a ruby one-shot (which holds no thread) reading the stdlib zip whole.
const ARMS = {
  'python oneshot': `python3 -c "${PY}"`,
  'python print': 'python3 -c "print(1)"',
  'python resident': 'python3 imports.py',
  'ruby oneshot': `ruby -e "${RB}"`,
  'ruby read zip': `ruby -e "puts File.binread(ENV['ZIP']).bytesize"`,
  'ruby resident': 'ruby requires.rb',
};

async function diag(sid) {
  const started = Date.now();
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/session`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(60_000) });
  const body = r.ok ? await r.json() : null;
  return { latencyMs: Date.now() - started, stalls: body?.launch?.stalls ?? body?.stalls ?? [] };
}

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  for (const line of ['nimbus install python', 'nimbus install ruby', heredoc('imports.py', PY + '\n'), heredoc('requires.rb', RB + '\n')]) {
    const r = await t.run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line.slice(0, 40)}: ${r.output.slice(-300)}`);
  }
  const zip = (await t.run("find / -name 'python313.zip' 2>/dev/null | head -1", 60_000)).output.split(/\r?\n/).find((l) => l.endsWith('python313.zip'));
  await t.run(`export ZIP=${zip}; ls -l ${zip}`, 30_000).then((r) => out({ kind: 'zip', path: zip, ls: r.output.slice(-200) }));
  const seen = new Set((await diag(sid)).stalls.map((s) => `${s.at}:${s.ms}`));
  const runOnce = async (arm, line, kind, i) => {
    let running = true;
    const polls = [];
    const poller = (async () => {
      while (running) {
        polls.push((await diag(sid).catch(() => ({ latencyMs: -1 }))).latencyMs);
        await sleep(100);
      }
    })();
    const start = Date.now();
    const r = await t.run(line, 600_000);
    const ms = Date.now() - start;
    running = false;
    await poller;
    const after = await diag(sid);
    const fresh = after.stalls.filter((s) => !seen.has(`${s.at}:${s.ms}`));
    for (const s of fresh) seen.add(`${s.at}:${s.ms}`);
    out({ kind, arm, i, ms, exit: r.exitCode, polls: polls.length, pollMaxMs: Math.max(0, ...polls), pollMedianMs: polls.sort((a, b) => a - b)[Math.floor(polls.length / 2)] ?? null,
      stalls: fresh.map((s) => ({ ms: s.ms, inFlight: s.inFlight })) });
  };
  for (const [arm, line] of Object.entries(ARMS)) await runOnce(arm, line, 'cold', 0);
  for (let i = 1; i <= ROUNDS; i++) {
    const arms = Object.entries(ARMS);
    for (let k = 0; k < arms.length; k++) {
      const [arm, line] = arms[(k + i) % arms.length];
      await runOnce(arm, line, 'warm', i);
    }
  }

} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
