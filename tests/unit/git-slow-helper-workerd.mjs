#!/usr/bin/env bun
// @tier slow — drives a local workerd with installed bash and git
//
// Real git hears a helper that answers after more than 8 s, and a signal
// still interrupts it while it waits.
//
// A wait on a pipe is bounded by its host (a suspended wasm stack outliving
// about 15 s in a facet never resumes): at 8 s the read gives up. git read
// its credential and transport helpers through stdio, which took the
// give-up's EINTR for the helper's end: `credential fill` went on as if the
// helper had said nothing, and a push whose helper answered late reported
// "failed to push some refs" though the remote had taken it. git-runner@2's
// image asks such a read again (NIMBUS_ERESTART, wasm/nimbus-libc
// nimbus-restart.c); a signal still ends it.
//
//   1. `git credential fill` with a helper that answers after 10 s gets the
//      helper's username and password (red before: git asked its own prompt,
//      which a pipe cannot answer);
//   2. Ctrl-C ends a `git credential fill` waiting on a helper that sleeps a
//      minute, at once, with status 130;
//   3. Ctrl-C ends real bash's `read` waiting on the terminal, with status 130.

import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

let probe;
let terminal;
const failed = [];
const check = async (name, body) => {
  try {
    await body();
    console.log(`  ok ${name}`);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
  }
};
try {
  probe = await startLocalProbe({ runtimes: ['bash', 'git'] });
  terminal = await localTerminal(probe, { install: ['bash', 'git'] });
  const t = terminal.terminal;
  const query = "printf 'protocol=https\\nhost=example.com\\n\\n'";

  await check('a helper that answers after 10 s is heard', async () => {
    const helper = "!f() { sleep 10; echo username=ada; echo password=secret; }; f";
    const started = Date.now();
    const filled = await terminal.run(`${query} | GIT_TERMINAL_PROMPT=0 NIMBUS_GIT_WASI=1 git -c credential.helper='${helper}' credential fill`, 120_000);
    assert.equal(filled.status, 0, filled.stdout);
    assert.match(filled.stdout, /username=ada\npassword=secret/, filled.stdout);
    assert.ok(Date.now() - started >= 10_000, 'after the helper answered');
  });

  await check('Ctrl-C ends git waiting on a helper', async () => {
    t.reset();
    t.cmd(`${query} | NIMBUS_GIT_WASI=1 git -c credential.helper='!sleep 60' credential fill; echo "status $?"`);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const sent = Date.now();
    t.send('\x03');
    await t.waitFor((buf) => /status \d+/.test(buf), 20_000, 'git ends');
    assert.ok(Date.now() - sent < 15_000, `ended ${Date.now() - sent} ms after Ctrl-C`);
    assert.match(t.buf, /status 130/, JSON.stringify(t.buf.slice(-400)));
  });

  await check('Ctrl-C ends real bash\'s read', async () => {
    await t.waitForPrompt(30_000);
    t.reset();
    t.cmd(`bash -c 'read line; echo "read $line"'; echo "status $?"`);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const sent = Date.now();
    t.send('\x03');
    await t.waitFor((buf) => /status \d+/.test(buf), 20_000, 'bash ends');
    assert.ok(Date.now() - sent < 15_000, `ended ${Date.now() - sent} ms after Ctrl-C`);
    assert.match(t.buf, /status 130/, JSON.stringify(t.buf.slice(-400)));
    assert.doesNotMatch(t.buf, /read /, 'read did not complete');
  });
} finally {
  if (terminal) await terminal.close();
  if (probe) await probe.stop();
}
assert.deepEqual(failed, [], failed.join('\n'));
console.log('git-slow-helper-workerd: a late helper is heard; Ctrl-C ends git and bash waiting');
