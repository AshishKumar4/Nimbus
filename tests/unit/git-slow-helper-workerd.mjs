#!/usr/bin/env bun
// @tier slow — drives a local workerd with installed bash and git
//
// Real git hears a helper that answers after more than 8 s.
//
// A wait on a pipe is bounded by its host (a suspended wasm stack outliving
// about 15 s in a facet never resumes): at 8 s the read gives up. git read
// its credential and transport helpers through stdio, which took the
// give-up's EINTR for the helper's end: `credential fill` went on as if the
// helper had said nothing, and a push whose helper answered late reported
// "failed to push some refs" though the remote had taken it. git-runner@2's
// image asks such a read again (NIMBUS_ERESTART, wasm/nimbus-libc
// nimbus-restart.c): `git credential fill` with a helper that answers after
// 10 s gets the helper's username and password (red before: git asked its
// own prompt, which a pipe cannot answer).

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

} finally {
  if (terminal) await terminal.close();
  if (probe) await probe.stop();
}
assert.deepEqual(failed, [], failed.join('\n'));
console.log('git-slow-helper-workerd: a helper that answers after 10 s is heard');
