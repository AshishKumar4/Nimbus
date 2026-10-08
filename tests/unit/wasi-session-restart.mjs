#!/usr/bin/env bun
/**
 * wasi-session-restart — a WASI process whose session restarts under it is
 * told so, rather than handed EIO.
 *
 * Measured 2026-10-07: a one-shot wasm-runner program with ~44 MiB of code
 * and data replaces the session's isolate while it loads. The program runs
 * on, and its first filesystem call reaches a session whose process table
 * never held its pid. TypeScript 7's tsc reported that as "Error getting
 * current directory: stat .: I/O error".
 *
 * The session's refusal is ESRCH: each call it refuses answers ESRCH, and the
 * run ends naming why, for a WASI guest (the WASI body's run) and for bash
 * (its own scheduler). A refusal of any other kind is untouched.
 */

import assert from 'node:assert/strict';
import { residentGuest } from './lib/wasi-resident-guest.mjs';
import { loadPreamble } from './lib/bash-preamble.mjs';

const ESRCH = 71;
const guest = await residentGuest();
try {
  const before = await guest.open('home/user/before.txt', { create: true, write: true });
  await guest.close(before);
  await assert.rejects(guest.open('home/user/missing/x.txt'), (error) => error.errno === 44, 'an ordinary refusal keeps its own errno');

  guest.restartSession();
  await assert.rejects(guest.open('home/user/after.txt', { create: true, write: true }),
    (error) => error.errno === ESRCH, 'a call the restarted session cannot answer for this process answers ESRCH, not EIO');

  const run = await guest.P.__wasiRunStartAsync({ exports: { _start: () => {} } });
  assert.equal(run.exitCode, 1, 'a run whose session restarted under it fails');
  assert.match(run.error ?? '', /session no longer holds this process \(process pid \d+ does not exist\): it restarted, or ended the process, while the program ran/,
    'the run names the restart');
} finally {
  await guest.dispose();
}
// bash's own scheduler maps its refusals through the same entry point and
// ends the same way: it waits at a read, the session restarts, and its next
// write is refused.
const bash = loadPreamble({ remote: true });
try {
  const parked = await bash.boot({
    argv: ['bash', '-c', 'echo before > /tmp/before; read line; echo after > /tmp/after; echo "write=$?"'],
    environ: ['PATH=/bin:/usr/bin', 'HOME=/home/user', 'NIMBUS_PWD=/', 'TERM=dumb'],
    stdinTty: false, stdinClosed: false, busyboxApplets: bash.applets,
  });
  assert.equal(parked.state, 'need-input', `bash waits at its read (${parked.error ?? ''})`);
  bash.restartSession();
  const ended = await bash.feed({ data: 'go\n', eof: true });
  assert.equal(ended.state, 'error', `a bash run whose session restarted under it fails (${JSON.stringify(ended).slice(0, 400)})`);
  assert.notEqual(ended.exitCode, 0);
  assert.match(ended.error ?? '', /session no longer holds this process \(process pid \d+ does not exist\): it restarted, or ended the process, while the program ran/,
    'the bash run names the restart');
} finally {
  await bash.dispose();
}
console.log('wasi-session-restart: a restarted session reads as ESRCH and a named ending, for a WASI guest and for bash');
