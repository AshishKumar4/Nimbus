#!/usr/bin/env bun
// Non-bare default command: project resolution and network/global flags reach
// a real serve+attach pair, and unsupported controls launch neither half.
import { connectProcessTerminal, deleteSession, makeAsserter, mintSession, stripAnsi, Terminal, outputLines } from '../../_driver.mjs';
const a = makeAsserter('agentic-cli/new/opencode-default-tui-project');
const sid = await mintSession();
console.log(`SID: ${sid}`);
const terminal = new Terminal(sid);
let tui;
try {
  await terminal.connect();
  await terminal.waitForPrompt(30_000);
  const installed = await terminal.run('npm install -g opencode-ai', 240_000);
  a.check('the staged OpenCode installs', installed.exitCode === 0, stripAnsi(installed.output).slice(-500));
  const unsupported = await terminal.run('opencode --model=bogusprovider/nope', 30_000);
  a.check('an unsupported default-TUI model option fails before either process starts',
    unsupported.exitCode !== 0 && /--model.*cannot run over the remote TUI transport/.test(stripAnsi(unsupported.output))
      && !/bin started/.test(unsupported.output), stripAnsi(unsupported.output).slice(-700));
  await terminal.run('mkdir -p /home/user/opencode-project /home/user/opencode-parent; cd /home/user/opencode-parent', 30_000);
  const launched = await terminal.run('opencode --port=4201 --log-level=ERROR ../opencode-project', 60_000);
  const pid = Number(stripAnsi(launched.output).match(/bin started \(long-running\): pid=(\d+)/)?.[1] ?? 0);
  a.check('a relative project with flags launches the real default TUI', pid > 0, stripAnsi(launched.output).slice(-900));
  if (pid > 0) {
    tui = await connectProcessTerminal(sid, pid);
    await tui.waitFor(() => /\x1b\[/.test(tui.rawOutput), 60_000, 'default project TUI frame');
    a.check('the non-bare invocation renders an actual frame', /\x1b\[/.test(tui.rawOutput), tui.output.slice(-500));
    const fetched = await terminal.run('curl -s http://127.0.0.1:4201/path', 30_000);
    const line = outputLines(fetched.output).find(line => line.startsWith('{') && line.includes('"directory"'));
    const directory = line ? JSON.parse(line).directory : undefined;
    a.check('the requested server port serves the resolved project directory',
      fetched.exitCode === 0 && directory === '/home/user/opencode-project', JSON.stringify({ directory, output: stripAnsi(fetched.output).slice(-700) }));
    tui.signal('SIGINT');
    await tui.waitFor(() => !!tui.exit, 30_000, 'default project TUI exit');
    a.check('the default project TUI tears down cleanly', tui.exit.code !== 137 && !/process killed:/.test(tui.output), JSON.stringify(tui.exit));
  }
} finally {
  try { tui?.ws?.close(); } catch {}
  await terminal.close();
  const cleanup = await deleteSession(sid);
  a.check('the project probe session is deleted', cleanup.ok, `status=${cleanup.status} ${cleanup.body.slice(-300)}`);
}
process.exit(a.summary().fail > 0 ? 1 : 0);
