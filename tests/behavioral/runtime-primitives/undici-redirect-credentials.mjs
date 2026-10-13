#!/usr/bin/env bun
// A real process's undici.request follows two in-session origins. The
// destination server records its method, body, Host and explicit credentials.
import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';
import { REDIRECT_PROGRAM, redirectFailures } from '../../unit/lib/undici-redirect-fixture.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/undici-redirect-credentials');
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  await terminal.run(heredocCommand('/home/user/redirect-program.cjs', REDIRECT_PROGRAM), 30_000);
  const boot = stripAnsi((await terminal.run('cd /home/user && node redirect-program.cjs 7321 7322', 90_000)).output);
  a.check('both redirect origins launch in a real Node process', /REDIRECT_ORIGINS|facet started/.test(boot), JSON.stringify(boot.slice(-1000)));
  let line;
  let result = '';
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    result = stripAnsi((await terminal.run('cat /home/user/undici-redirect-result.json', 30_000)).output).replace(/\r/g, '');
    line = /^\{"results":.+$/m.exec(result);
    if (line) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  a.check('request program records every response', Boolean(line), JSON.stringify(result.slice(-1500)));
  if (line) {
    const report = JSON.parse(line[0]);
    const failures = redirectFailures(report);
    a.check('cross-origin requests strip credentials, same-origin keeps them, Host is regenerated, and 303 drops content headers', failures.length === 0, failures.join('\n'));
  }
} finally {
  await terminal.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}
const summary = a.summary();
process.exit(summary.fail > 0 ? 1 : 0);
