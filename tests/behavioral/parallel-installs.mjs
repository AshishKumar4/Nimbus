#!/usr/bin/env bun
// behavioral/parallel-installs — fire 8 concurrent npm installs across
// 8 sessions; verify that no refusal at the Dynamic Worker limit surfaces to
// the user, in any wording the platform has used (classifyMessage's).
//
// Black-box surfaces only. NO _diag.

import { mintSession, Terminal, makeAsserter } from './_driver.mjs';
import { classifyMessage } from '../../packages/platform/src/oom-classify.ts';

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
    await t.waitForPrompt(60_000);
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
// What each install that did not finish said, so a failure names its cause.
const failures = [];
for (const res of installs) {
  if (res.status === 'rejected') {
    other++;
    failures.push(`rejected: ${String(res.reason?.stack ?? res.reason).split('\n').slice(0, 3).join(' | ')}`);
    continue;
  }
  const { i, sid, output } = res.value;
  if (output.split('\n').some((line) => classifyMessage(line) === 'dynamic_worker_cap')) capError++;
  if (/added \d+ packages|installed \d+ packages|Done!\s+\d+ packages/i.test(output)) success++;
  else failures.push(`#${i} ${sid}: ${JSON.stringify(output.slice(-600))}`);
}
for (const failure of failures) console.log(`      ${failure}`);

a.check(`${N}/${N} installs completed (added/installed marker)`,
  success === N, `success=${success} capError=${capError} other=${other}`);
a.check('zero Dynamic Worker limit refusals visible to users',
  capError === 0, `capError=${capError}`);

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
