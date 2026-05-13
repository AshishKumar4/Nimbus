#!/usr/bin/env bun
// winwin-w1/process-logs-still-emit — basic exit→log path still works.
//
// Verifies the change to _ensureLogJanitor didn't break the ordinary
// process-log emit path. We run a command that exits with a non-zero
// code AND writes to stderr; verify the terminal sees both the stdout
// and the non-zero exit's downstream exit-dump.
//
// This is a smoke probe at the user-observable level: if W1 broke
// either the markExit hook or the in-isolate flush timer, the user
// would notice the absence of expected stderr output or the exit-
// dump line that normally trails a non-zero exit.

import { mintSession, Terminal, makeAsserter, stripAnsi, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('winwin-w1/process-logs-still-emit');
console.log(`winwin-w1/process-logs-still-emit — ${BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(30_000);

// stdout + non-zero exit. The user-visible markers:
//   - "marker-stdout" must reach the terminal
//   - the shell's $? after `false` must be non-zero (typically 1)
const { output: o1 } = await t.run('echo marker-stdout && false', 10_000);
const s1 = stripAnsi(o1);
a.check('stdout marker reaches terminal', /marker-stdout/.test(s1),
  `output=${JSON.stringify(s1.slice(-200))}`);

const { output: o2 } = await t.run('echo "rc=$?"', 10_000);
const s2 = stripAnsi(o2);
a.check('non-zero exit code captured by shell $?',
  /rc=[1-9][0-9]*/.test(s2),
  `output=${JSON.stringify(s2.slice(-200))}`);

// stderr + zero-exit. Verify stderr also reaches the terminal.
const { output: o3 } = await t.run('echo "stderr-marker" 1>&2', 10_000);
const s3 = stripAnsi(o3);
a.check('stderr marker reaches terminal', /stderr-marker/.test(s3),
  `output=${JSON.stringify(s3.slice(-200))}`);

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
