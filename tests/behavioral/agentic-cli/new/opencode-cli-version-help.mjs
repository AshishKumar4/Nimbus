#!/usr/bin/env bun
// agentic-cli/new/opencode-cli-version-help — the staged opencode JS bundle
// runs as a real CLI in Nimbus: `npm install -g opencode-ai` installs the
// Nimbus-staged ESM bundle (not the native shards), and `opencode --version`
// / `opencode --help` execute end-to-end through the ESM facet runner
// (import.meta.url / createRequire fix, VFS-backed node:fs/os bridge, and the
// deferred-entry build that moves opencode's startup I/O out of workerd's
// global scope).

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/opencode-cli-version-help');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  const install = await t.run('npm install -g opencode-ai', 240_000);
  const installOut = stripAnsi(install.output);
  a.check('opencode-ai installs the staged Nimbus bundle (not native shards)',
    /linked 1 bin into|added 1 packages/.test(installOut),
    JSON.stringify(installOut.slice(-400)));

  const shim = await t.run('cat /usr/local/bin/opencode', 15_000);
  const shimOut = stripAnsi(shim.output);
  a.check('opencode bin is the staged-artifact node shim',
    /nimbus staged artifact: nimbus-staged:opencode/.test(shimOut),
    JSON.stringify(shimOut.slice(-300)));

  const version = await t.run('opencode --version; echo EXIT=$?', 120_000);
  const versionOut = stripAnsi(version.output);
  a.check('opencode --version prints 1.16.2 and exits 0',
    hasOutputLine(versionOut, '1.16.2') && hasOutputLine(versionOut, 'EXIT=0'),
    JSON.stringify(versionOut.slice(-500)));
  a.check('opencode --version produces no global-scope / createRequire error',
    !/Disallowed operation called within global scope|createRequire|operation not permitted|does not provide an export/.test(versionOut),
    JSON.stringify(versionOut.slice(-500)));

  const help = await t.run('opencode --help; echo EXIT=$?', 120_000);
  const helpOut = stripAnsi(help.output);
  a.check('opencode --help renders the CLI option help and exits 0',
    /model to use in the format of provider\/model/.test(helpOut)
      && /continue the last session/.test(helpOut)
      && /prompt to use/.test(helpOut)
      && /EXIT=0/.test(helpOut),
    JSON.stringify(helpOut.slice(-700)));
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
