#!/usr/bin/env bun
// agentic-cli/new/node-fs-utimes — Node callback/promise utimes works in
// the dynamic runtime. Pi's lockfile path depends on callback fs.utimes.

import {
  deleteSession,
  heredocCommand,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/node-fs-utimes');

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const script = `
const fs = require('fs');
const path = '/home/user/utimes-probe.txt';

return (async () => {
  fs.writeFileSync(path, 'lock');
  const first = new Date(946684800123);
  await new Promise((resolve, reject) => {
    fs.utimes(path, first, first, (err) => err ? reject(err) : resolve());
  });
  const callbackStat = fs.statSync(path);
  console.log('callback=' + callbackStat.mtime.getTime());

  const second = new Date(946684801456);
  await fs.promises.utimes(path, second, second);
  const promiseStat = await fs.promises.stat(path);
  console.log('promise=' + promiseStat.mtime.getTime());
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
`;

  await t.run(heredocCommand('/home/user/utimes-probe.js', script), 60_000);
  const run = await t.run('node /home/user/utimes-probe.js', 60_000);
  const out = stripAnsi(run.output);

  a.check('callback fs.utimes updates stat mtime',
    /callback=946684800123/.test(out),
    JSON.stringify(out.slice(-1000)));
  a.check('fs.promises.utimes updates stat mtime',
    /promise=946684801456/.test(out),
    JSON.stringify(out.slice(-1000)));
  a.check('utimes does not throw missing-method errors',
    !/fs\[method\] is not a function|utimes is not a function|TypeError/i.test(out),
    JSON.stringify(out.slice(-1000)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
