#!/usr/bin/env bun
// A real process's undici.request follows two in-session origins. The
// destination server records its method, body, Host and explicit credentials.
import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../_driver.mjs';
import { REDIRECT_CLIENT, REDIRECT_SERVER, redirectFailures } from '../../unit/lib/undici-redirect-fixture.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/undici-redirect-credentials');
const sid = await mintSession();
const terminal = new Terminal(sid);
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  await terminal.run(heredocCommand('/home/user/redirect-server.cjs', REDIRECT_SERVER), 30_000);
  await terminal.run(heredocCommand('/home/user/redirect-client.cjs', REDIRECT_CLIENT), 30_000);
  const boot = stripAnsi((await terminal.run('node /home/user/redirect-server.cjs 7321 7322', 90_000)).output);
  a.check('both redirect origins launch in a real Node process', /REDIRECT_ORIGINS|facet started/.test(boot), JSON.stringify(boot.slice(-1000)));
  const result = stripAnsi((await terminal.run('node /home/user/redirect-client.cjs http://127.0.0.1:7321', 180_000)).output);
  const line = /^UNDICI_REDIRECT (.+)$/m.exec(result.replace(/\r/g, ''));
  a.check('request program records every response', Boolean(line), JSON.stringify(result.slice(-1500)));
  if (line) {
    const report = JSON.parse(line[1]);
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
