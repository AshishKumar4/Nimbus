#!/usr/bin/env bun
// agentic-cli/new/node-handled-fs-rejection — an fs rejection the program
// caught is the program's business, not the process's cause of death.
//
// Async fs calls that mutate a path are ordered through the VFS mutation
// queue, which retains a failed mutation so a deferred persistence flush
// cannot lose data silently. A syscall the program awaits is not that case:
// the rejection is delivered to the caller exactly as Node delivers it, and
// retaining it as well killed processes over errors their author had already
// handled — `opencode --help` rendered its whole help surface and then exited
// 1 on the `fs.truncate(logfile).catch(() => {})` in its logger init.
//
// The unhandled arm is here so the fix cannot be read as "swallow fs
// failures": a rejection nobody handles must still fail the process loudly.

import {
  deleteSession,
  mintSession,
  Terminal,
  makeAsserter,
  heredocCommand,
  stripAnsi,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'agentic-cli/new/node-handled-fs-rejection';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const MISSING = '/home/user/no-such-file.log';

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await t.run(heredocCommand('/home/user/handled.js', [
    'const fs = require("fs");',
    'async function main() {',
    `  await fs.promises.truncate(${JSON.stringify(MISSING)})`,
    '    .then(() => console.log("TRUNCATE_RESOLVED"))',
    '    .catch((e) => console.log("TRUNCATE_CAUGHT=" + e.code));',
    '  const fh = await fs.promises.open("/home/user/handled-target.txt", "w");',
    '  await fh.write(Buffer.from("payload"), 0, 7, 0);',
    '  await fh.close();',
    '  console.log("READBACK=" + fs.readFileSync("/home/user/handled-target.txt", "utf8"));',
    '  console.log("STILL_RUNNING");',
    '}',
    'main();',
  ].join('\n')), 15_000);

  {
    const out = stripAnsi((await t.run('node /home/user/handled.js; echo EXIT=$?', 90_000)).output);
    a.check('a caught fs.promises.truncate rejection reports ENOENT to the caller',
      /TRUNCATE_CAUGHT=ENOENT/.test(out) && !/TRUNCATE_RESOLVED/.test(out),
      JSON.stringify(out.slice(-600)));
    a.check('the program keeps running past the rejection it handled',
      /STILL_RUNNING/.test(out) && /READBACK=payload/.test(out),
      JSON.stringify(out.slice(-600)));
    a.check('the process exits 0 rather than dying on the handled rejection',
      /EXIT=0/.test(out) && !/ENOENT: truncate/.test(out),
      JSON.stringify(out.slice(-600)));
  }

  await t.run(heredocCommand('/home/user/unhandled.js', [
    'const fs = require("fs");',
    'async function main() {',
    `  await fs.promises.truncate(${JSON.stringify(MISSING)});`,
    '  console.log("NEVER_REACHED");',
    '}',
    'main();',
  ].join('\n')), 15_000);

  {
    const out = stripAnsi((await t.run('node /home/user/unhandled.js; echo EXIT=$?', 90_000)).output);
    a.check('an fs rejection nobody handles still fails the process loudly',
      /EXIT=1/.test(out) && /ENOENT/.test(out) && !/NEVER_REACHED/.test(out),
      JSON.stringify(out.slice(-600)));
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
