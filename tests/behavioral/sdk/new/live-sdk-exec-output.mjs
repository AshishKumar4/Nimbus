#!/usr/bin/env bun
// sdk/new/live-sdk-exec-output — a programmatic exec of a facet-hosted
// runtime returns what the program printed.
//
// The rest of the suite drives the interactive WebSocket terminal, where a
// runtime's output reaches the user through the supervisor RPC's terminal
// mirror. The programmatic path (`sandbox.exec` / `sandbox.runCode`, the
// SDK's whole non-interactive surface) has no terminal: its result IS the
// output, and a redirect or a pipe in the command line has to see the same
// bytes. That path went blind — exit codes correct, stdout and stderr empty
// — with nothing headless to catch it, because the one probe that asserts
// this shape (live-sdk-remote-smoke) needs hosted-demo OAuth and is skipped
// against `apps/probe`.

import { BASE, AUTH_TOKEN, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('sdk/new/live-sdk-exec-output');
console.log(`sdk/new/live-sdk-exec-output — BASE=${BASE}`);

const { Nimbus } = await import('../../../../packages/sdk/src/index.ts');

const box = Nimbus.connect({
  endpoint: BASE,
  ...(AUTH_TOKEN ? { token: AUTH_TOKEN } : {}),
}).sandbox(`exec-output-${Date.now()}`);

try {
  const control = await box.exec('echo shell-builtin');
  a.check('a shell builtin still returns its output',
    control.stdout === 'shell-builtin\n',
    JSON.stringify(control));

  const evaled = await box.exec('node -e "console.log(1 + 1)"');
  a.check('node -e stdout comes back on the result',
    evaled.exitCode === 0 && evaled.stdout === '2\n',
    JSON.stringify(evaled));

  const errored = await box.exec(`node -e "console.error('to-stderr')"`);
  a.check('node -e stderr comes back on the result',
    errored.exitCode === 0 && errored.stderr.includes('to-stderr'),
    JSON.stringify(errored));

  const threw = await box.exec(`node -e "throw new Error('boom')"`);
  a.check('a thrown error reports both its exit code and its trace',
    threw.exitCode === 1 && threw.stderr.includes('boom'),
    JSON.stringify(threw));

  await box.files.write('/home/user/exec-output.js', 'console.log("from-file")\n');
  const fromFile = await box.exec('node /home/user/exec-output.js');
  a.check('a node script file returns its output',
    fromFile.exitCode === 0 && fromFile.stdout === 'from-file\n',
    JSON.stringify(fromFile));

  // Output that never enters the command's stdout cannot be redirected or
  // piped, so these two are what prove it travels the shell's stdout chain
  // rather than being reattached to the result at the end.
  await box.exec('node -e "console.log(9)" > /home/user/exec-output.txt');
  const redirected = await box.files.read('/home/user/exec-output.txt');
  a.check('a redirect captures node stdout to a file',
    redirected === '9\n',
    JSON.stringify(redirected));

  const piped = await box.exec(`node -e "console.log('piped')" | cat`);
  a.check('a pipe carries node stdout to the next command',
    piped.exitCode === 0 && piped.stdout === 'piped\n',
    JSON.stringify(piped));

  const ran = await box.runCode('console.log(7)');
  a.check('runCode returns what the code printed',
    ran.exitCode === 0 && ran.stdout === '7\n',
    JSON.stringify(ran));
} finally {
  await box.destroy({ reason: 'live-sdk-exec-output-complete' }).catch(() => {});
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
