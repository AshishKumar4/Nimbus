#!/usr/bin/env bun
// wasi/symlink-follow-open — WASI socket and polling support B3 — symlink follow on path_open.
//
// Spec: dirflags & LOOKUPFLAGS_SYMLINK_FOLLOW (bit 1) makes path_open
// dereference symlinks transparently. The authority codec hands the flag to
// the filesystem, whose path resolution walks the chain (bounded by
// SYMLOOP_MAX) and opens the final non-symlink target.
//
// Fixture: writes "real.txt" containing "OK\\n", creates symlink "lnk"
// → "real.txt", opens "lnk" with follow=on, reads 3 bytes, echoes them
// to stdout. Expected: "OK\\n" in output.

import { mintSession, deleteSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';
import { writeStreamBFixtureCmd } from './_fixtures-stream-b.mjs';

const sid = await mintSession();
console.log(`[wasi/symlink-follow-open] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
let exitCode = 1;
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);

  await t.run('mkdir -p /home/user/sb && cd /home/user/sb', 10_000);
  await t.run(writeStreamBFixtureCmd('symlink-follow-open', 'sfo.wasm'), 30_000);

  const r = await t.run('wasm-runner sfo.wasm', 60_000);
  const out = stripAnsi(r.output);
  const tail = out.split(/\r?\n/).slice(-6).join('\n');
  const ok = /OK/.test(tail);

  console.log(JSON.stringify({ probe: 'wasi/symlink-follow-open', sid, base: BASE, tail, ok }, null, 2));

  const checks = [['path_open(follow) on symlink reads target contents', ok]];
  let pass = 0;
  for (const [n, o] of checks) { console.log(`  ${o ? 'PASS' : 'FAIL'}  ${n}`); if (o) pass++; }
  const verdict = pass === checks.length ? 'passing' : 'failing';
  console.log(`[wasi/symlink-follow-open] ${verdict} — ${pass}/${checks.length}`);
  exitCode = verdict === 'passing' ? 0 : 1;
} finally {
  await t.close().catch(() => {});
  const del = await deleteSession(sid, 'wasi/symlink-follow-open');
  console.log(`deleteSession: ${del.status}`);
}
process.exit(exitCode);
