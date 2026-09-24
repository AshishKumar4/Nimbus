#!/usr/bin/env bun
// wasi/clock — clock_time_get(CLOCK_REALTIME=0, precision=0, out=8) must
// return errno=0 (ESUCCESS). Fixture writes ('0' + errno) + '\n', so a
// successful call produces "0\n".

import { mintSession, deleteSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeFixtureCmd } from './_fixtures.mjs';

const sid = await mintSession();
console.log(`[wasi/clock] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let exitCode = 1;
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/wasi && cd /home/user/wasi', 10_000);
  await t.run(writeFixtureCmd('clock', 'clock.wasm'), 30_000);

  const r = await t.run('wasm-runner clock.wasm _start', 30_000);
  const out = stripAnsi(r.output);
  const tail = out.split(/\r?\n/).slice(-6).join('\n');
  const errnoZeroOk = /^\s*0\s*$/m.test(tail);

  const findings = { probe: 'wasi/clock', sid, base: BASE, tail, errnoZeroOk };
  console.log(JSON.stringify(findings, null, 2));

  const checks = [
    ['clock_time_get returns errno 0', errnoZeroOk],
  ];
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass++;
  }
  const verdict = pass === checks.length ? 'passing' : 'failing';
  console.log(`[wasi/clock] ${verdict} — ${pass}/${checks.length}`);
  exitCode = verdict === 'passing' ? 0 : 1;
} finally {
  await t.close().catch(() => {});
  const del = await deleteSession(sid, 'wasi/clock');
  console.log(`deleteSession: ${del.status}`);
}
process.exit(exitCode);
