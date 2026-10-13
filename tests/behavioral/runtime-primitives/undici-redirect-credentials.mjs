#!/usr/bin/env bun
// A real process's undici.request follows two in-session origins. The
// destination server records its method, body, Host and explicit credentials.
import { mintSession, deleteSession, Terminal, makeAsserter, heredocCommand } from '../_driver.mjs';
import { REDIRECT_PROGRAM, redirectFailures } from '../../unit/lib/undici-redirect-fixture.mjs';
import { terminalCommandRunner } from '../../unit/lib/workerd-probe.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('runtime-primitives/undici-redirect-credentials');
const sid = await mintSession();
const terminal = new Terminal(sid);
const run = terminalCommandRunner(terminal);
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  await run(heredocCommand('/home/user/redirect-program.cjs', REDIRECT_PROGRAM), 30_000);
  const boot = await run('cd /home/user && node redirect-program.cjs 7321 7322', 90_000);
  a.check('both redirect origins launch in a real Node process', boot.status === 0 && /REDIRECT_ORIGINS|facet started/.test(boot.stdout), JSON.stringify(boot.stdout.slice(-1000)));
  let result;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    // The file has no trailing newline. Raw terminal output would append the
    // shell prompt to its JSON; control-frame stdout is the command's bytes.
    result = await run('cat /home/user/undici-redirect-result.json', 30_000);
    if (result.status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  a.check('request program records every response', result?.status === 0, JSON.stringify(result?.stdout.slice(-1500)));
  if (result?.status === 0) {
    const report = JSON.parse(result.stdout.trim());
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
