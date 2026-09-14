#!/usr/bin/env bun
// production/pi-coding-agent-tui — the npm-bin Pi probe, run against a
// deployed production target through an anonymous demo session.
//
// Mirrors tests/behavioral/agentic-cli/new/pi-coding-agent-npm-bin.mjs
// assertion for assertion. It exists separately because production gates
// POST /new on an interactive login, so the session has to come from the
// public anonymous endpoint.
//
//   BASE=https://nimbus-os.dev bun tests/behavioral/production/pi-coding-agent-tui.mjs

import { bootstrapProductionSession } from '../_production-anon.mjs';

const { sid } = await bootstrapProductionSession();

const { connectProcessTerminal, deleteSession, makeAsserter, stripAnsi, Terminal } =
  await import('../_driver.mjs');

const a = makeAsserter('production/pi-coding-agent-tui');
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const install = await t.run('npm install -g --ignore-scripts @earendil-works/pi-coding-agent', 240_000);
  const installOut = stripAnsi(install.output);
  a.check('Pi npm package installs from the public command',
    /added \d+ packages|Done!/.test(installOut) && !/npm install failed|ERR!|command not found/i.test(installOut),
    JSON.stringify(installOut.slice(-1200)));

  const installed = await t.run(
    'grep -m1 \'"version"\' /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json', 30_000);
  console.log('installed:', stripAnsi(installed.output).match(/"version":\s*"[^"]+"/)?.[0] ?? '(unknown)');

  const version = await t.run('pi --version', 60_000);
  const versionOut = stripAnsi(version.output);
  a.check('pi --version exits as a short command',
    /\b\d+\.\d+\.\d+\b/.test(versionOut) && !/\[bin started \(long-running\)/.test(versionOut),
    JSON.stringify(versionOut.slice(-800)));

  const help = await t.run('pi --help', 60_000);
  const helpOut = stripAnsi(help.output);
  a.check('pi --help exits as a short command',
    /usage|options|commands|pi/i.test(helpOut) && !/\[bin started \(long-running\)/.test(helpOut),
    JSON.stringify(helpOut.slice(-1000)));

  const launch = await t.run('pi', 60_000);
  const launchOut = stripAnsi(launch.output);
  const pid = Number(launchOut.match(/\[bin started \(long-running\): pid=(\d+) cmd="pi"\]/)?.[1] || 0);
  a.check('bare pi starts as a long-running attached process', pid > 0, JSON.stringify(launchOut.slice(-1000)));

  if (pid > 0) {
    const parentShellAfterLaunch = stripAnsi(t.buf);
    const proc = await connectProcessTerminal(sid, pid);
    await proc.waitFor((out) => /pi v\d+\.\d+\.\d+|ctrl\+o|escape interrupt/.test(out), 60_000, 'Pi TUI chrome');
    a.check('bare pi renders its TUI in the process terminal',
      /pi v\d+\.\d+\.\d+|ctrl\+o|escape interrupt/.test(proc.output),
      JSON.stringify(proc.output.slice(-1200)));
    a.check('bare pi does not crash before the TUI starts',
      !/fs\[method\] is not a function|utimes is not a function|TypeError/i.test(proc.output),
      JSON.stringify(proc.output.slice(-1200)));
    a.check('bare pi TUI output is not mirrored into the parent shell',
      stripAnsi(t.buf) === parentShellAfterLaunch,
      JSON.stringify(stripAnsi(t.buf).slice(-1200)));

    proc.input('hello');
    let echoed = false;
    try { await proc.waitFor((out) => /hello/.test(out), 20_000, 'Pi echoes typed input'); echoed = true; } catch {}
    a.check('bare pi accepts input and stays alive',
      echoed && !proc.closed && !proc.exit,
      `echoed=${echoed} closed=${proc.closed} exit=${JSON.stringify(proc.exit)} `
      + JSON.stringify(proc.output.slice(-1200)));

    const shellAfter = await t.run('echo SHELL_SURVIVED_LAUNCH', 30_000);
    a.check('the shell survives launching the TUI',
      /SHELL_SURVIVED_LAUNCH/.test(stripAnsi(shellAfter.output)),
      JSON.stringify(stripAnsi(shellAfter.output).slice(-600)));

    proc.resize(100, 31);
    proc.signal('SIGTERM');
    try { await proc.waitFor(() => !!proc.exit, 15_000, 'Pi SIGTERM exit'); } catch { proc.input('\u0003'); }
    try { proc.ws.close(); } catch {}
  }
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
