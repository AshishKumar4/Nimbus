#!/usr/bin/env bun
// behavioral/parallel-installs — fire 8 concurrent npm installs across
// 8 sessions; verify zero "Too many concurrent dynamic workers" errors
// surface to the user.
//
// Black-box surfaces only. NO _diag.

import { mintSession, Terminal, makeAsserter, sleep } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('parallel-installs');
console.log(`behavioral/parallel-installs — 8 concurrent npm installs\nBASE=${process.env.BASE}`);

const N = 8;
// Tiny package picked for fast install.
const PKG = 'zod';

const installs = await Promise.allSettled(
  Array.from({ length: N }, async (_, i) => {
    const sid = await mintSession();
    const t = new Terminal(sid);
    await t.connect();
    await sleep(1_500 + Math.random() * 500);
    await t.run('mkdir -p /home/user/parallel && cd /home/user/parallel', 10_000);
    await t.run('echo \'{"name":"p","version":"0.0.0"}\' > package.json', 10_000);
    const r = await t.run(`npm install ${PKG}`, 240_000);
    await t.close();
    return { i, sid, output: r.output };
  }),
);

let success = 0;
let capError = 0;
let other = 0;
for (const res of installs) {
  if (res.status === 'rejected') { other++; continue; }
  const { output } = res.value;
  if (/Too many concurrent dynamic workers/i.test(output)) capError++;
  if (/added \d+ packages|installed \d+ packages|Done!\s+\d+ packages/i.test(output)) success++;
}

a.check(`${N}/${N} installs completed (added/installed marker)`,
  success === N, `success=${success} capError=${capError} other=${other}`);
a.check('zero "Too many concurrent dynamic workers" errors visible to users',
  capError === 0, `capError=${capError}`);

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
