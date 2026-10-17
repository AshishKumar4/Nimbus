#!/usr/bin/env bun
// python/installed-build-survives-reset — a session that installed CPython
// 3.13.14-1 keeps python, and pip, when the deployment changes under it.
//
// WHAT IT PROVES
//   A deploy ends every session's isolate; on its next request a session
//   wakes on the new code and rebinds each installed runtime by the runner
//   key its manifest names. 3.13.14-1 names `cpython-runner`; a later build
//   names `cpython-runner@2`, and a deployment that registered only that
//   would leave every -1 session with "command not found". This deployment
//   is the new code, so a real isolate reset (`POST /api/_diag/abort`, which
//   ends the DO isolate as a deploy does while every synced row survives)
//   after installing -1 is the same wake a deploy causes.
//
// Red before: the runner was registered only under cpython-runner@2, so the
// install of -1 was refused by its runner.

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, stripAnsi, sleep } from '../_driver.mjs';
import { afterReset, resetInstance } from '../durable/_reset-window.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/installed-build-survives-reset');
console.log(`python/installed-build-survives-reset — ${BASE}`);

const BUILD = '3.13.14-1';
const sid = await mintSession();
console.log(`SID: ${sid}`);
let t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const install = stripAnsi((await t.run(`nimbus install cpython@${BUILD}`, 300_000)).output);
  a.check(`cpython@${BUILD} installs`, new RegExp(`installed at .*cpython/${BUILD.replaceAll('.', '\\.')}|already installed`).test(install)
    && !/not registered|not in catalog|command not found/i.test(install), JSON.stringify(install.slice(-600)));

  const runs = async (when) => {
    const python = stripAnsi((await t.run(`python3 -c "import sys; print('py', *sys.version_info[:2])"`, 120_000)).output);
    a.check(`python runs ${when}`, /py 3 13/.test(python) && !/command not found/.test(python), JSON.stringify(python.slice(-400)));
    const pip = stripAnsi((await t.run('pip --version', 120_000)).output);
    a.check(`pip runs ${when}`, /pip \d+/.test(pip) && !/command not found/.test(pip), JSON.stringify(pip.slice(-400)));
  };
  await runs('after the install');

  const reset = await resetInstance(sid);
  a.check('the abort reset the instance: the session answers from a new incarnation', reset.ok, reset.detail);
  await t.close();
  await sleep(500);
  t = new Terminal(sid);
  await afterReset(() => t.connect());
  await t.waitForPrompt(60_000);
  await runs('after the isolate reset');
} finally {
  await t.close().catch(() => undefined);
  await deleteSession(sid).catch(() => undefined);
}
const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
