#!/usr/bin/env bun
// agentic-cli/new/attached-npm-bin-tty — npm-bin agent CLIs need a real
// attached process contract: TTY-shaped stdio, long-running PID handoff,
// process terminal streaming, and stdin delivery after launch.

import {
  connectProcessTerminal,
  deleteSession,
  heredocCommand,
  makeAsserter,
  mintSession,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/attached-npm-bin-tty');

const packageJson = JSON.stringify({
  name: '@nimbus-fixtures/attached-agent',
  version: '1.0.0',
  keywords: ['tui', 'coding-agent'],
  bin: { 'attached-agent': './cli.js' },
}, null, 2);

const cliSource = `
const readline = require('node:readline');

console.log('TTY=' + process.stdin.isTTY + ':' + process.stdout.isTTY);
console.log('RAW_MODE=' + typeof process.stdin.setRawMode);
console.log('RAW_BEFORE=' + process.stdin.isRaw);
process.stdin.setRawMode(true);
console.log('RAW_AFTER_TRUE=' + process.stdin.isRaw);
process.stdin.setRawMode(false);
console.log('RAW_AFTER_FALSE=' + process.stdin.isRaw);
process.stdin.setRawMode(true);
console.log('STDOUT_EVENTS=' + [typeof process.stdout.on, typeof process.stdout.removeListener, typeof process.stdout.listenerCount].join(':'));
console.log('CURSOR_API=' + [typeof process.stdout.cursorTo, typeof process.stdout.moveCursor, typeof process.stdout.clearLine, typeof readline.cursorTo, typeof readline.moveCursor, typeof readline.clearScreenDown].join(':'));
const removedDataListener = () => {};
process.stdin.on('data', removedDataListener);
process.stdin.removeListener('data', removedDataListener);
process.stdin.off('data', removedDataListener);
console.log('STDIN_REMOVE_LISTENER_OK');
process.stdout.write('CURSOR_A');
process.stdout.cursorTo(0);
process.stdout.clearLine(0);
process.stdout.write('CURSOR_B\\n');
readline.cursorTo(process.stdout, 1, 2);
readline.moveCursor(process.stdout, 2, -1);
readline.clearScreenDown(process.stdout);
console.log('CURSOR_HELPERS_DONE');

process.stdout.on('resize', () => {
  console.log('STDOUT_RESIZE=' + process.stdout.columns + 'x' + process.stdout.rows);
});
process.on('SIGWINCH', () => {
  console.log('SIGWINCH=' + process.stdout.columns + 'x' + process.stdout.rows);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});
readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', (_str, key) => {
  if (key && key.name) console.log('KEYPRESS=' + key.name + ':' + !!key.ctrl);
});

process.stdout.write('PROMPT> ');
rl.on('line', (line) => {
  console.log('LINE=' + line);
  if (line.trim() === 'exit') {
    rl.close();
    process.exit(0);
  }
  process.stdout.write('PROMPT> ');
});
`;

const asyncTuiPackageJson = JSON.stringify({
  name: '@nimbus-fixtures/async-attached-agent',
  version: '1.0.0',
  keywords: ['tui', 'coding-agent'],
  bin: { 'async-attached-agent': './cli.js' },
}, null, 2);

const asyncTuiCliSource = `
async function main() {
  await Promise.resolve();
  await Promise.resolve();
  process.stdout.write('\\x1b[?1049h\\x1b[?25l\\x1b[2J\\x1b[H');
  process.stdout.write('ASYNC_TUI_FRAME\\nPROMPT> ');
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write('INPUT=' + text.replace(/\\r/g, '<CR>').replace(/\\n/g, '<NL>') + '\\n');
    if (text.includes('exit')) {
      process.stdout.write('\\x1b[?25h\\x1b[?1049l');
      process.exit(0);
    }
    process.stdout.write('PROMPT> ');
  });
}

main();
`;

const asyncCrashPackageJson = JSON.stringify({
  name: '@nimbus-fixtures/async-attached-crash',
  version: '1.0.0',
  keywords: ['tui', 'coding-agent'],
  bin: { 'async-attached-crash': './cli.js' },
}, null, 2);

const asyncCrashCliSource = `
async function main() {
  await Promise.resolve();
  throw new Error('ASYNC_ATTACHED_CRASH');
}

main();
`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/attached-agent /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/attached-agent/package.json', packageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/attached-agent/cli.js', cliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/attached-agent', '#!/usr/bin/env node\nrequire("../@nimbus-fixtures/attached-agent/cli.js");'), 10_000);

  const launch = await t.run('attached-agent', 30_000);
  const terminalOut = stripAnsi(launch.output);
  const pidMatch = terminalOut.match(/\[bin started \(long-running\): pid=(\d+) cmd="attached-agent"\]/);
  const pid = pidMatch ? Number(pidMatch[1]) : 0;
  a.check('npm bin launches as a long-running attached process', pid > 0, JSON.stringify(terminalOut.slice(-800)));

  const logs = await connectProcessTerminal(sid, pid);
  await logs.waitFor((out) => /TTY=true:true/.test(out), 30_000, 'TTY flags');
  await logs.waitFor((out) => /RAW_MODE=function/.test(out), 30_000, 'raw mode shape');
  await logs.waitFor((out) => /RAW_AFTER_TRUE=true/.test(out) && /RAW_AFTER_FALSE=false/.test(out), 30_000, 'raw mode state');
  await logs.waitFor((out) => /STDOUT_EVENTS=function:function:function/.test(out), 30_000, 'stdout event emitter shape');
  await logs.waitFor((out) => /STDIN_REMOVE_LISTENER_OK/.test(out), 30_000, 'stdin removeListener cleanup');
  await logs.waitFor((out) => /CURSOR_HELPERS_DONE/.test(out), 30_000, 'cursor helpers');
  await logs.waitFor((out) => /PROMPT>/.test(out), 30_000, 'prompt');
  a.check('attached process exposes TTY-shaped stdio to the Node CLI',
    /TTY=true:true/.test(logs.output)
      && /RAW_MODE=function/.test(logs.output)
      && /RAW_AFTER_TRUE=true/.test(logs.output)
      && /RAW_AFTER_FALSE=false/.test(logs.output)
      && /STDOUT_EVENTS=function:function:function/.test(logs.output)
      && /STDIN_REMOVE_LISTENER_OK/.test(logs.output)
      && /CURSOR_API=function:function:function:function:function:function/.test(logs.output),
    JSON.stringify(logs.output.slice(-800)));
  a.check('attached process cursor helpers emit ANSI terminal control sequences',
    logs.rawOutput.includes('\x1b[1G')
      && logs.rawOutput.includes('\x1b[2K')
      && logs.rawOutput.includes('\x1b[3;2H')
      && logs.rawOutput.includes('\x1b[2C\x1b[1A')
      && logs.rawOutput.includes('\x1b[0J'),
    JSON.stringify(logs.rawOutput.slice(-800)));

  logs.resize(100, 31);
  await logs.waitFor((out) => /STDOUT_RESIZE=100x31/.test(out) && /SIGWINCH=100x31/.test(out), 30_000, 'resize propagation');
  a.check('attached process receives terminal resize through stdout and SIGWINCH',
    /STDOUT_RESIZE=100x31/.test(logs.output) && /SIGWINCH=100x31/.test(logs.output),
    JSON.stringify(logs.output.slice(-800)));

  logs.input('hello-agent\n');
  await logs.waitFor(() => !!logs.stdinAck, 30_000, 'stdin ack');
  a.check('process terminal WebSocket input is acknowledged by the session',
    logs.stdinAck && logs.stdinAck.ok === true,
    JSON.stringify(logs.stdinAck));
  await logs.waitFor((out) => /LINE=hello-agent/.test(out), 30_000, 'stdin line echo');
  a.check('process terminal WebSocket input reaches the running npm bin',
    /LINE=hello-agent/.test(logs.output),
    JSON.stringify(logs.output.slice(-800)));
  await logs.waitFor((out) => /KEYPRESS=h:false/.test(out) && /KEYPRESS=enter:false/.test(out), 30_000, 'keypress events');
  a.check('readline emits keypress events for attached process input',
    /KEYPRESS=h:false/.test(logs.output) && /KEYPRESS=enter:false/.test(logs.output),
    JSON.stringify(logs.output.slice(-800)));

  logs.input('erase-a\x7fb\n');
  await logs.waitFor((out) => /LINE=erase-b/.test(out), 30_000, 'readline backspace editing');
  a.check('readline cooked input handles backspace before emitting a line',
    /LINE=erase-b/.test(logs.output) && !/LINE=erase-a/.test(logs.output),
    JSON.stringify(logs.output.slice(-1000)));

  logs.input('exit\n');
  await logs.waitFor(() => !!logs.exit, 30_000, 'exit frame');
  a.check('attached process reports a clean exit after interactive input',
    logs.exit && logs.exit.code === 0,
    JSON.stringify(logs.exit));

  try { logs.ws.close(); } catch {}

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/async-attached-agent /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-attached-agent/package.json', asyncTuiPackageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-attached-agent/cli.js', asyncTuiCliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/async-attached-agent', '#!/usr/bin/env node\nrequire("../@nimbus-fixtures/async-attached-agent/cli.js");'), 10_000);

  const asyncLaunch = await t.run('async-attached-agent', 30_000);
  const asyncTerminalOut = stripAnsi(asyncLaunch.output);
  const asyncPidMatch = asyncTerminalOut.match(/\[bin started \(long-running\): pid=(\d+) cmd="async-attached-agent"\]/);
  const asyncPid = asyncPidMatch ? Number(asyncPidMatch[1]) : 0;
  a.check('unawaited async npm-bin TUI launches as a long-running attached process',
    asyncPid > 0,
    JSON.stringify(asyncTerminalOut.slice(-800)));

  const asyncLogs = await connectProcessTerminal(sid, asyncPid);
  await asyncLogs.waitFor((out) => /ASYNC_TUI_FRAME/.test(out) && /PROMPT>/.test(out), 30_000, 'async TUI first frame');
  a.check('unawaited async npm-bin TUI renders its first ANSI frame',
    /ASYNC_TUI_FRAME/.test(asyncLogs.output)
      && asyncLogs.rawOutput.includes('\x1b[?1049h')
      && asyncLogs.rawOutput.includes('\x1b[?25l'),
    JSON.stringify(asyncLogs.rawOutput.slice(-800)));

  asyncLogs.input('ping\n');
  await asyncLogs.waitFor((out) => /INPUT=ping<NL>/.test(out), 30_000, 'async TUI stdin');
  a.check('unawaited async npm-bin TUI receives attached terminal stdin',
    /INPUT=ping<NL>/.test(asyncLogs.output),
    JSON.stringify(asyncLogs.output.slice(-800)));

  asyncLogs.input('exit\n');
  await asyncLogs.waitFor(() => !!asyncLogs.exit, 30_000, 'async TUI exit');
  a.check('unawaited async npm-bin TUI exits cleanly from attached terminal input',
    asyncLogs.exit && asyncLogs.exit.code === 0,
    JSON.stringify(asyncLogs.exit));

  try { asyncLogs.ws.close(); } catch {}

  await t.run('mkdir -p /home/user/node_modules/@nimbus-fixtures/async-attached-crash /home/user/node_modules/.bin', 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-attached-crash/package.json', asyncCrashPackageJson), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/@nimbus-fixtures/async-attached-crash/cli.js', asyncCrashCliSource), 10_000);
  await t.run(heredocCommand('/home/user/node_modules/.bin/async-attached-crash', '#!/usr/bin/env node\nrequire("../@nimbus-fixtures/async-attached-crash/cli.js");'), 10_000);

  t.reset();
  t.cmd('async-attached-crash');
  await t.waitFor((body) => /ASYNC_ATTACHED_CRASH/.test(body), 30_000, 'async TUI crash stack');
  const crashTerminalOut = stripAnsi(t.buf);
  const crashPidMatch = crashTerminalOut.match(/\[bin started \(long-running\): pid=(\d+) cmd="async-attached-crash"\]/);
  const crashPid = crashPidMatch ? Number(crashPidMatch[1]) : 0;
  a.check('unawaited async npm-bin crash launches as a long-running attached process',
    crashPid > 0,
    JSON.stringify(crashTerminalOut.slice(-800)));

  a.check('unawaited async npm-bin crash is surfaced with an exit code and stack',
    /Process \d+ \(async-attached-crash\) exited with code 1/.test(crashTerminalOut)
      && /ASYNC_ATTACHED_CRASH/.test(crashTerminalOut),
    JSON.stringify(crashTerminalOut.slice(-1000)));
  t.send('\r');
  await t.waitForPrompt(30_000);
  a.check('terminal remains responsive after an attached async startup crash',
    /[$#>]\s*$/.test(stripAnsi(t.buf).trimEnd().slice(-3)),
    JSON.stringify(stripAnsi(t.buf).slice(-1000)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
