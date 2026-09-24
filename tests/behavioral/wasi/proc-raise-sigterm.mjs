#!/usr/bin/env bun
// wasi/proc-raise-sigterm — WASI socket and polling support B5 — proc_raise(SIGTERM=15) → 143.
//
// Spec: POSIX convention exit = 128 + signo. SIGTERM=15 → 143. Sibling
// probe to proc-raise-sigabrt: validates the encoding holds for multiple
// signals (not hardcoded for SIGABRT).

import { mintSession, deleteSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/proc-raise-sigterm] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let exitCode = 1;
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
  await t.run(writeStreamBFixtureCmd('proc-raise-sigterm', 'prt.wasm'), 30_000);

  await t.run('wasm-runner prt.wasm', 60_000);
  const r = await t.run('echo $?', 10_000);
  const out = stripAnsi(r.output);
  const tail = out.split(/\r?\n/).slice(-6).join('\n');
  const lines = tail.split(/\r?\n/).map(s => s.trim());
  const ok = lines.some(s => s === '143');

  console.log(JSON.stringify({ probe: 'wasi/proc-raise-sigterm', sid, base: BASE, tail, ok }, null, 2));

  const checks = [['proc_raise(SIGTERM=15) → exit code 143', ok]];
  let pass = 0;
  for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
  const verdict = pass === checks.length ? 'passing' : 'failing';
  console.log(`[wasi/proc-raise-sigterm] ${verdict} — ${pass}/${checks.length}`);
  exitCode = verdict === 'passing' ? 0 : 1;
} finally {
  await t.close().catch(() => {});
  const del = await deleteSession(sid, 'wasi/proc-raise-sigterm');
  console.log(`deleteSession: ${del.status}`);
}
process.exit(exitCode);
