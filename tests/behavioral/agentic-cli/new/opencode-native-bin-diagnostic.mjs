#!/usr/bin/env bun
// agentic-cli/new/native-only-bin-diagnostic — a genuinely native-only
// npm package (one with NO Nimbus staged-artifact or WASM swap) must
// fail loudly at install time with the Nimbus ABI diagnostic instead of
// exposing a broken command.
//
// opencode-ai used to be the subject here, but it now installs as the
// Nimbus staged JS artifact (its success is covered by
// opencode-cli-version-help + opencode-run-pipeline). We repoint at
// @esbuild/linux-x64: a real platform-native shard with os=[linux]
// cpu=[x64] in its package.json and no WASM/wasi build — exactly the
// native-only class this diagnostic protects.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/native-only-bin-diagnostic');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const install = await t.run('npm install @esbuild/linux-x64', 90_000);
  const out = stripAnsi(install.output);
  a.check('native-only package fails with an explicit Nimbus ABI diagnostic',
    /only ships platform-native artifacts/.test(out)
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
