#!/usr/bin/env bun
// shell/compat/r6/new/killed-background-loop-stops — killed shell loops
// must honor the process abort signal before their next loop iteration.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r6/new/killed-background-loop-stops');

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const command = [
    'spin() { while :; do echo SPIN; sleep 0.05; done; }',
    'spin & pid=$!',
    'sleep 0.25',
    'kill "$pid"',
    'wait "$pid"',
    'echo AFTER_KILL',
    'sleep 0.2',
    'echo DONE',
  ].join('; ');
  const result = await t.run(command, 12_000);
  const output = stripAnsi(result.output);

  a.check('background loop produced output before kill',
    /SPIN/.test(output),
    JSON.stringify(output));
  a.check('command continued after wait',
    /AFTER_KILL[\s\S]*DONE/.test(output),
    JSON.stringify(output));

  const afterKill = output.slice(output.lastIndexOf('AFTER_KILL'));
  a.check('background loop stopped after kill and wait',
    !/SPIN/.test(afterKill),
    JSON.stringify(afterKill));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
