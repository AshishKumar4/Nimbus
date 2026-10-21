#!/usr/bin/env bun
// Experiment (D1 measurement, not for landing): what a Python or Ruby script
// costs per host, paired within a session. Two sessions, each running every
// arm each round, in an order that turns a round at a time:
//   oneshot-a, oneshot-b  the program as `-c`/`-e`, a Loader one-shot, twice: the A/A;
//   resident              the same as a script: today's resident;
//   light                 the script in a facet with no durable owner, image, journal row or slot.
// Then three at once, in each host. Each run prints one JSON line.
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
const lineOf = (runtime, arm) => (arm.startsWith('oneshot') ? LINES[runtime].oneshot
  : arm === 'light' ? `NIMBUS_MEASURE_D1=light ${LINES[runtime].script}` : LINES[runtime].script);
const ARMS = ['oneshot-a', 'oneshot-b', 'resident', 'light'];

/** A session's terminal, connected again if it closed. */
async function connect(s) {
  s.t = new Terminal(s.sid);
  await s.t.connect();
  await s.t.waitForPrompt(60_000);
}

const sessions = [];
try {
  for (const copy of [1, 2]) {
    const s = { copy, sid: await mintSession() };
    await connect(s);
    for (const line of ['nimbus install python', 'nimbus install ruby', heredoc('imports.py', PY + '\n'), heredoc('requires.rb', RB + '\n')]) {
      const r = await s.t.run(line, 600_000);
      if (r.exitCode !== 0) throw new Error(`${s.sid} setup failed: ${line.slice(0, 40)}: ${r.output.slice(-300)}`);
    }
    sessions.push(s);
    out({ kind: 'session', copy, sid: s.sid });
  }
  const timed = async (s, runtime, arm, line, kind, i) => {
    for (let attempt = 0; ; attempt++) {
      const start = new Date().toISOString();
      try {
        const r = await s.t.run(line, 600_000);
        const end = new Date().toISOString();
        out({ kind, arm, copy: s.copy, runtime, i, sid: s.sid, start, end, ms: r.elapsed, exit: r.exitCode, ok: kind === 'trio' ? r.exitCode === 0 : /^1\r?$/m.test(r.output) });
        return;
      } catch (error) {
        out({ kind: 'lost', arm, copy: s.copy, runtime, i, sid: s.sid, start, error: String(error?.message ?? error).slice(0, 300) });
        if (attempt > 0) throw error;
        await connect(s);
      }
    }
  };
  for (const runtime of ['python', 'ruby']) {
    for (const s of sessions) for (const arm of ARMS) await timed(s, runtime, arm, lineOf(runtime, arm), 'cold', 0);
    for (let i = 1; i <= ROUNDS; i++) {
      for (const s of sessions) {
        // The order turns a round at a time, so no arm always goes first.
        for (let k = 0; k < ARMS.length; k++) {
          const arm = ARMS[(k + i) % ARMS.length];
          await timed(s, runtime, arm, lineOf(runtime, arm), 'warm', i);
        }
      }
    }
  }
  for (const runtime of ['python', 'ruby']) {
    for (let i = 1; i <= TRIO_ROUNDS; i++) {
      for (const s of sessions) {
        for (const arm of ['oneshot-a', 'resident', 'light']) {
          const one = lineOf(runtime, arm);
          await timed(s, runtime, arm, `${one} > /dev/null & ${one} > /dev/null & ${one} > /dev/null & wait`, 'trio', i);
        }
      }
    }
  }
  await sleep(5000);
} catch (error) {
  out({ kind: 'error', error: String(error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
} finally {
  for (const s of sessions) {
    await s.t?.close().catch(() => {});
    await deleteSession(s.sid).catch(() => {});
  }
}
