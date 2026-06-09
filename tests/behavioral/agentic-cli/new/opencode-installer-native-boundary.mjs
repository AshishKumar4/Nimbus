#!/usr/bin/env bun
// agentic-cli/new/opencode-installer-native-boundary — opencode's public
// installer should reach the real Nimbus ABI boundary, not fail in curl/bash.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/opencode-installer-native-boundary');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const installer = await t.run('curl -fsSL https://opencode.ai/install | head -n 1', 60_000);
  const installerText = stripAnsi(installer.output);
  a.check('curl -fsSL follows opencode install redirects',
    hasOutputLine(installerText, '#!/usr/bin/env bash'),
    JSON.stringify(installerText.slice(-800)));

  const result = await t.run('curl -fsSL https://opencode.ai/install | bash; echo STATUS=$?', 90_000);
  const out = stripAnsi(result.output);
  a.check('opencode installer fails at the explicit Nimbus native ABI boundary',
    /Unsupported OS\/Arch: Lifo\/wasm/.test(out)
      && hasOutputLine(out, 'STATUS=1')
      && !/Expected Word|got Redirection|307 Temporary Redirect|<html/i.test(out),
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

function hasOutputLine(output, expected) {
  return output
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .includes(expected);
}
