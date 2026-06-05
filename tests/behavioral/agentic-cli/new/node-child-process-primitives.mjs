#!/usr/bin/env bun
// agentic-cli/new/node-child-process-primitives — Node primitives used by
// JS agent CLIs: env/home, TTY flags, child_process.spawn, execFile, and
// Nimbus's deferred spawnSync completion.

import { mintSession, Terminal, makeAsserter, heredocCommand, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/node-child-process-primitives');

const source = `
import { spawn, execFile, spawnSync } from 'node:child_process';

console.log('ENV_HOME=' + process.env.HOME);
console.log('ENV_PATH_HAS_USR_BIN=' + String((process.env.PATH || '').split(':').includes('/usr/bin')));
console.log('TTY_FLAGS=' + String(process.stdin.isTTY) + ':' + String(process.stdout.isTTY));

const child = spawn('node', ['-e', [
  "process.stdin.setEncoding('utf8')",
  "let input=''",
  "process.stdin.on('data', d => input += d)",
  "process.stdin.on('end', () => { console.log('CHILD_STDOUT:' + input.trim()); console.error('CHILD_STDERR:ok'); })",
].join(';')], { stdio: ['pipe', 'pipe', 'pipe'] });

let spawnOut = '';
let spawnErr = '';
child.stdout.on('data', d => { spawnOut += String(d); });
child.stderr.on('data', d => { spawnErr += String(d); });
child.stdin.write('hello-agent');
child.stdin.end();
const spawnCode = await new Promise(resolve => child.on('close', resolve));
console.log('SPAWN_CODE=' + spawnCode);
console.log('SPAWN_OUT=' + spawnOut.trim());
console.log('SPAWN_ERR=' + spawnErr.trim());

await new Promise((resolve) => {
  execFile('node', ['-e', "console.log('EXECFILE_OK')"], (_err, stdout, stderr) => {
    console.log('EXECFILE_OUT=' + String(stdout).trim());
    console.log('EXECFILE_ERR=' + String(stderr).trim());
    resolve();
  });
});

const sync = spawnSync('node', ['--version']);
if (sync && sync.__deferred) {
  const done = await sync.__deferred;
  console.log('SPAWNSYNC_DEFERRED_STATUS=' + done.status);
  console.log('SPAWNSYNC_DEFERRED_OUT=' + String(done.stdout).trim());
} else {
  console.log('SPAWNSYNC_DEFERRED_STATUS=missing');
}
`;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(15_000);

await t.run(heredocCommand('agentic-primitives.mjs', source), 10_000);
const run = await t.run('node agentic-primitives.mjs', 120_000);
const out = stripAnsi(run.output);

a.check('HOME is the Nimbus user home', /ENV_HOME=\/home\/user/.test(out), JSON.stringify(out.slice(-800)));
a.check('PATH includes /usr/bin', /ENV_PATH_HAS_USR_BIN=true/.test(out), JSON.stringify(out.slice(-800)));
a.check('non-interactive node process reports non-TTY stdio', /TTY_FLAGS=false:false/.test(out), JSON.stringify(out.slice(-800)));
a.check('child_process.spawn returns child stdout', /SPAWN_OUT=CHILD_STDOUT:hello-agent/.test(out), JSON.stringify(out.slice(-800)));
a.check('child_process.spawn returns child stderr', /SPAWN_ERR=CHILD_STDERR:ok/.test(out), JSON.stringify(out.slice(-800)));
a.check('child_process.spawn close code is 0', /SPAWN_CODE=0/.test(out), JSON.stringify(out.slice(-800)));
a.check('child_process.execFile callback receives stdout', /EXECFILE_OUT=EXECFILE_OK/.test(out), JSON.stringify(out.slice(-800)));
a.check('spawnSync deferred completion resolves', /SPAWNSYNC_DEFERRED_STATUS=0/.test(out), JSON.stringify(out.slice(-800)));
a.check('spawnSync deferred stdout includes node version', /SPAWNSYNC_DEFERRED_OUT=v?\d+\.\d+\.\d+/.test(out), JSON.stringify(out.slice(-800)));

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
