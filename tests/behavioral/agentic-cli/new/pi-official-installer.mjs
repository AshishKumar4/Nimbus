#!/usr/bin/env bun
// agentic-cli/new/pi-official-installer — Pi's public curl|sh installer
// should run through Nimbus sh, clean up progress jobs, link prefix bins,
// and leave `pi` runnable as a normal short command.

import {
  connectProcessTerminal,
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

  const launch = await t.run('pi', 60_000);
  const launchText = stripAnsi(launch.output);
  const pid = Number(launchText.match(/\[bin started \(long-running\): pid=(\d+) cmd="pi"\]/)?.[1] || 0);
  a.check('official install launches Pi as an attached TUI', pid > 0, JSON.stringify(launchText.slice(-1000)));
  if (pid > 0) {
    const proc = await connectProcessTerminal(sid, pid);
    await proc.waitFor(
      (out) => /pi v\d+\.\d+\.\d+|ctrl\+o|escape interrupt/.test(out),
      90_000,
      'Pi TUI chrome after official install',
    );
    a.check('officially installed Pi renders its TUI',
      /pi v\d+\.\d+\.\d+|ctrl\+o|escape interrupt/.test(proc.output),
      JSON.stringify(proc.output.slice(-1200)));
    proc.input('installer-check');
    let echoed = false;
    try {
      await proc.waitFor((out) => /installer-check/.test(out), 20_000, 'Pi input after official install');
      echoed = true;
    } catch { /* reported below */ }
    a.check('officially installed Pi accepts input and stays alive',
      echoed && !proc.closed && !proc.exit,
      `echoed=${echoed} closed=${proc.closed} exit=${JSON.stringify(proc.exit)} `
        + JSON.stringify(proc.output.slice(-1200)));
    const shellAfter = await t.run('echo SHELL_SURVIVED_PI_INSTALLER_TUI', 30_000);
    a.check('shell survives officially installed Pi TUI',
      /SHELL_SURVIVED_PI_INSTALLER_TUI/.test(stripAnsi(shellAfter.output)),
      JSON.stringify(stripAnsi(shellAfter.output).slice(-600)));
    proc.signal('SIGTERM');
    try { await proc.waitFor(() => !!proc.exit, 15_000, 'Pi SIGTERM exit'); }
    catch { proc.input('\u0003'); }
    try { proc.ws.close(); } catch {}
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
