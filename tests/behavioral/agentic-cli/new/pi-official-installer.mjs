#!/usr/bin/env bun
// agentic-cli/new/pi-official-installer — Pi's public curl|sh installer
// should run through Nimbus sh, clean up progress jobs, link prefix bins,
// and leave `pi` runnable as a normal short command.

import {
  deleteSession,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
  sleep,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/pi-official-installer');

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  t.reset();
  t.cmd('curl -fsSL https://pi.dev/install.sh | sh');
  await t.waitFor((b) => /Choose an action:/.test(b), 60_000, 'Pi action prompt');
  t.send('y');

  await t.waitFor(
    (b) => /Run it with: pi|Add \/home\/user\/\.local\/bin to your PATH/.test(b),
    360_000,
    'Pi install completion',
  );

  const installText = stripAnsi(t.buf);
  // The completion marker's glyph belongs to the installer, not to Nimbus:
  // upstream renders `ok install complete` on a dumb pipe and `✓ install
  // complete` on a TTY, and has changed between them. Both spellings are the
  // same signal, so both pass; the success sentence stays required, and the
  // OUTCOME (a runnable `pi` on PATH) is asserted independently below.
  a.check('official installer reported install success',
    /(?:\bok|✓) install complete\b/.test(installText) && /Pi was installed successfully/.test(installText),
    JSON.stringify(installText.slice(-1600)));

  const pathPrompt = installText.lastIndexOf('Add /home/user/.local/bin to your PATH');
  if (pathPrompt >= 0) {
    await sleep(1500);
    const afterPrompt = stripAnsi(t.buf).slice(pathPrompt);
    a.check('progress renderer stopped before PATH prompt',
      !/starting npm install/.test(afterPrompt),
      JSON.stringify(afterPrompt.slice(-1000)));
    t.send('y\r');
    await t.waitFor((b) => /Then run: pi|user@nimbus:/.test(b), 60_000, 'PATH prompt completion');
  } else {
    const runLine = installText.lastIndexOf('Run it with: pi');
    await sleep(1500);
    const afterRunLine = stripAnsi(t.buf).slice(runLine);
    a.check('progress renderer stopped before final install message',
      !/starting npm install/.test(afterRunLine),
      JSON.stringify(afterRunLine.slice(-1000)));
  }

  const check = await t.run('command -v pi; which pi; pi --version', 120_000);
  const checkText = stripAnsi(check.output);
  a.check('pi resolves to a PATH shim',
    /\/home\/user\/\.local\/bin\/pi|\/usr\/local\/bin\/pi/.test(checkText),
    JSON.stringify(checkText.slice(-1000)));
  a.check('pi --version exits as a short command after official install',
    /\b\d+\.\d+\.\d+\b/.test(checkText) && !/\[bin started \(long-running\)/.test(checkText),
    JSON.stringify(checkText.slice(-1200)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
