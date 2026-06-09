#!/usr/bin/env bun
// agentic-cli/new/opencode-native-bin-diagnostic — native-only agent
// packages should fail loudly at install time instead of exposing a
// broken command.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/opencode-native-bin-diagnostic');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const install = await t.run('npm install opencode-ai', 90_000);
  const out = stripAnsi(install.output);
  a.check('opencode native executable package fails with an explicit Nimbus ABI diagnostic',
    /native executable bin/.test(out)
      && /cannot execute Linux\/Windows\/macOS native binaries/.test(out)
      && /JavaScript, WASM, or wasm32-wasi-nimbus artifact/.test(out)
      && !/added \d+ packages/.test(out),
    JSON.stringify(out.slice(-1200)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
