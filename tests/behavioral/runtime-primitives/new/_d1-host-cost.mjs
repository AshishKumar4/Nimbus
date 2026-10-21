#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): what a Python or Ruby script
// costs per host. Each arm runs in two sessions of its own (its A/A), and the
// sessions take turns, a round at a time:
//   oneshot     the program as `-c`/`-e`: a Loader one-shot;
//   resident    the same as a script: today's resident;
//   light       the script in a facet with no durable owner, image, journal row or slot;
//   light-heap  the same with no write journal in its facet's SQLite.
// Then three at once, in each host. Each run prints one JSON line; the
// session's CPU and memory are joined from the platform's telemetry after.
import { mintSession, deleteSession, Terminal, sleep } from '../../_driver.mjs';

const ROUNDS = Number(process.env.D1_ROUNDS ?? 15);
const TRIO_ROUNDS = Number(process.env.D1_TRIO_ROUNDS ?? 5);
const out = (record) => console.log(JSON.stringify(record));
const heredoc = (path, body) => `cat > ${path} <<'NIMBUS_EOF'\n${body}NIMBUS_EOF`;

// The programs the file-engine measurements timed (M, b).
const PY = 'import email.parser, http.client, json, decimal, asyncio, unittest, xml.dom.minidom, sqlite3, argparse, logging; print(1)';
const RB = "require 'json'; require 'set'; require 'time'; require 'fileutils'; require 'optparse'; puts 1";
const LINES = {
  python: { oneshot: `python3 -c "${PY}"`, script: 'python3 imports.py' },
  ruby: { oneshot: `ruby -e "${RB}"`, script: 'ruby requires.rb' },
};
const ENV = { oneshot: '', resident: '', light: 'NIMBUS_MEASURE_D1=light ', 'light-heap': 'NIMBUS_MEASURE_D1=light-heap ' };
const lineOf = (runtime, arm) => ENV[arm] + (arm === 'oneshot' ? LINES[runtime].oneshot : LINES[runtime].script);
const ARMS = ['oneshot', 'resident', 'light', 'light-heap'];

const sessions = [];
try {
  for (const arm of ARMS) {
    for (const copy of [1, 2]) {
      const sid = await mintSession();
      const t = new Terminal(sid);
      await t.connect();
      await t.waitForPrompt(60_000);
      for (const line of ['nimbus install python', 'nimbus install ruby', heredoc('imports.py', PY + '\n'), heredoc('requires.rb', RB + '\n')]) {
        const r = await t.run(line, 600_000);
        if (r.exitCode !== 0) throw new Error(`${sid} setup failed: ${line.slice(0, 40)}: ${r.output.slice(-300)}`);
      }
      sessions.push({ arm, copy, sid, t });
      out({ kind: 'session', arm, copy, sid });
    }
  }
  // Cold: each session's first run of each program, then the rounds.
  const timed = async (s, runtime, line, kind, i) => {
    const start = new Date().toISOString();
    const r = await s.t.run(line, 600_000);
    const end = new Date().toISOString();
    out({ kind, arm: s.arm, copy: s.copy, runtime, i, sid: s.sid, start, end, ms: r.elapsed, exit: r.exitCode, ok: /^1\r?$/m.test(r.output) || kind === 'trio' });
    return r;
  };
  for (const runtime of ['python', 'ruby']) {
    for (const s of sessions) await timed(s, runtime, lineOf(runtime, s.arm), 'cold', 0);
    for (let i = 1; i <= ROUNDS; i++) {
      // The order turns a round at a time, so no arm always goes first.
      const order = sessions.map((_, k) => sessions[(k + i) % sessions.length]);
      for (const s of order) await timed(s, runtime, lineOf(runtime, s.arm), 'warm', i);
    }
  }
  // Three at once, in each host (copy 1 of each arm).
  for (const runtime of ['python', 'ruby']) {
    for (let i = 1; i <= TRIO_ROUNDS; i++) {
      for (const s of sessions.filter((x) => x.copy === 1)) {
        const one = lineOf(runtime, s.arm);
        await timed(s, runtime, `${one} > /dev/null & ${one} > /dev/null & ${one} > /dev/null & wait`, 'trio', i);
      }
    }
  }
  // Let the residents' last traces reach the telemetry.
  await sleep(5000);
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  for (const s of sessions) {
    await s.t.close().catch(() => {});
    await deleteSession(s.sid).catch(() => {});
  }
}
