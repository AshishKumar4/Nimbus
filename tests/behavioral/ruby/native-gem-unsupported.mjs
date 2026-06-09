#!/usr/bin/env bun
// ruby/native-gem-unsupported — native extension gems fail with an explicit
// ruby.wasm compatibility diagnostic instead of installing partially.

import { deleteSession, mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'ruby/native-gem-unsupported';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  await t.run('nimbus install ruby', 180_000);

  {
    const { output } = await t.run('gem install ffi', 180_000);
    const stripped = stripAnsi(output);
    a.check('native extension gem install is rejected explicitly',
      /contains native extension/.test(stripped) && /not compatible with ruby\.wasm in Nimbus/.test(stripped),
      JSON.stringify(stripped.slice(-1200)));
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
