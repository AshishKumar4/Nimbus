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
  const tail = JSON.stringify(out.slice(-1200));

  // The installer derives `os` from `uname -s` through a `Linux*)` case and
  // `arch` from `uname -m`, then refuses any combination it has no build for.
  // Reaching that refusal is the whole point of the probe: it means the script
  // parsed, ran, and got as far as resolving a download — the failure is the
  // native ABI, not the shell. Assert the properties, not the literal line:
  // the string moved once already when `uname -s` was corrected from `Lifo` to
  // `Linux`, and pinning the new spelling would only re-arm the same trap.
  const refusal = /Unsupported OS\/Arch: (\S+)\/(\S+)/.exec(out);
  a.check('opencode installer reaches its own OS/Arch resolution',
    refusal !== null, tail);

  // A kernel name the installer recognises proves `uname -s` still answers
  // what platform gates test for; the raw value used to be nonsense, and every
  // installer died on the very first check.
  a.check('uname -s resolves to a kernel installers gate on',
    refusal?.[1] === 'linux', `os=${refusal?.[1]} ${tail}`);

  // `uname -m` stays honest at wasm on purpose. Reporting x86_64 would let the
  // download resolve and hand the user a binary that could never execute, so
  // failing here is the correct outcome, not a gap.
  a.check('uname -m reports wasm, so an arch-keyed download refuses to resolve',
    refusal?.[2] === 'wasm', `arch=${refusal?.[2]} ${tail}`);

  a.check('the installer exits non-zero rather than claiming success',
    hasOutputLine(out, 'STATUS=1'), tail);

  a.check('nothing failed inside curl or bash on the way there',
    !/Expected Word|got Redirection|307 Temporary Redirect|<html/i.test(out), tail);
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
