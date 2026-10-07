// @serial
// What nothing caught ends the program as it ends Node 22.22.3's: the same
// stderr, byte for byte (but for the stack frames, which are the runtime's
// own beside the program's), and the same exit code (shims' fatal
// exception, node-shims.ts). The report: where it was thrown (the file, its
// line, a caret under the throw), the error as util.inspect shows it (its
// own properties, its cause), and Node's version; a rejection's from where
// the error was made, or Node's UnhandledPromiseRejection for a reason that
// is not an error; 'uncaughtException' and its monitor, a handler that
// takes it (the program goes on) or throws (exit 7, its stack as it is);
// 'exit' first, with process.exitCode, whose last value is the code. A
// file's CommonJS `this` is its exports, so its frame is Node's
// `Object.<anonymous>`. A module that does not compile is placed by the
// parser where V8 stops. Before, the guest printed the stack under
// "Uncaught exception:" and exited 1.
//
// Named limits (fine-print capabilities): an error a builtin throws, which
// Node places at its own library's source line, a value that is not an
// error, an error thrown away from where it was made or with its stack
// replaced, have no place or the place it was made at.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/fatal';
const FILES = {
  'sync.cjs': "const a = 1;\n  throw Object.assign(new TypeError('boom'), { code: 'E_X', extra: [1, 2] });\n",
  'rej.cjs': "Promise.reject(new Error('rejected'));\n",
  'rejstr.cjs': "Promise.reject('just a string');\n",
  'rejundef.cjs': 'Promise.reject();\n',
  'rejobj.cjs': 'Promise.reject({ a: 1 });\n',
  'timer.cjs': 'setTimeout(() => {\n  null.x;\n}, 1);\n',
  'handler.cjs': "process.on('exit', (c) => { console.error('exit handler', c); });\nprocess.on('uncaughtException', () => { throw new TypeError('in handler'); });\nthrow new Error('first');\n",
  'exitcode.cjs': "process.on('exit', (c) => { console.error('exit handler', c, process.exitCode); process.exitCode = 9; });\nthrow new Error('x');\n",
  'handled.cjs': "process.on('uncaughtExceptionMonitor', (e, t) => console.error('monitor', e.message, t));\nprocess.on('uncaughtException', (e, t) => console.error('handled', e.message, t));\nthrow new Error('first');\n",
  'rejhandled.cjs': "process.on('uncaughtException', (e, t) => console.error('handled', e.message, t));\nPromise.reject(new Error('r'));\nsetTimeout(() => console.error('later'), 10);\n",
  'cause.cjs': "throw new Error('outer', { cause: new Error('inner') });\n",
  'minified.cjs': 'var a=1;function z(){throw new Error("deep")}var b=2;z();\n',
  'noname.cjs': "throw Object.assign(new Error('m'), { name: undefined });\n",
  'tab.cjs': "function f() {\n\tif (true) {\tthrow new Error('tabbed'); }\n}\nf();\n",
  'uni.cjs': "const s = 'h\u00e9llo'; throw new Error(s);\n",
  'multi.cjs': "throw Object.assign(\n  new Error('multi'), { z: 1 });\n",
  'fnthrow.cjs': "function make() { return new Error('made'); }\nthrow make();\n",
  'this.cjs': "console.error(this === module.exports);\nthrow new Error('this');\n",
  'bad.cjs': 'const broken = ;\n',
  'req.cjs': "const x = 1;\nrequire('./bad.cjs');\n",
  'code3.cjs': 'process.exitCode = 3;\n',
  'code4.cjs': "process.exitCode = '4';\nprocess.on('exit', (c) => console.error('exit', JSON.stringify(c)));\nprocess.exit();\n",
  'input.js': 'throw new Error("in")\n',
};
const COMMANDS = [
  'node sync.cjs', 'node rej.cjs', 'node rejstr.cjs', 'node rejundef.cjs', 'node rejobj.cjs', 'node timer.cjs',
  'node handler.cjs', 'node exitcode.cjs', 'node handled.cjs', 'node rejhandled.cjs', 'node cause.cjs',
  'node minified.cjs', 'node noname.cjs', 'node tab.cjs', 'node uni.cjs', 'node multi.cjs', 'node fnthrow.cjs',
  'node this.cjs', 'node bad.cjs', 'node req.cjs', 'node code3.cjs', 'node code4.cjs',
  `node -e 'throw new Error("ev")'`, 'node - < input.js',
];

const host = realpathSync(mkdtempSync(join(tmpdir(), 'node-fatal-')));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
for (const [path, text] of Object.entries(FILES)) writeFileSync(join(host, path), text);
// What a command printed to fd 2 and its exit code, with the place it ran named W.
const shown = (stderr, from) => stderr.split(from).join(W)
  .split('\n').filter((line) => !/^\s+at /.test(line) && !/^\s*\.\.\. \d+ lines matching cause stack trace \.\.\.$/.test(line)).join('\n');
const run = (command) => `${command} > out.txt 2> err.txt; echo $? > code.txt`;
const read = `node -e "const fs = require('fs'); process.stdout.write(JSON.stringify({ err: fs.readFileSync('err.txt').toString('base64'), code: fs.readFileSync('code.txt', 'utf8') }))"`;

console.log('node-fatal-report-matches-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const made = await session.run(`mkdir -p ${W}`, 30_000);
    assert.equal(made.status, 0, made.stdout);
    for (const [path, text] of Object.entries(FILES)) await session.writeFile(`${W}/${path}`, text);
    for (const command of COMMANDS) {
      const expected = spawnSync('sh', ['-c', run(command)], { cwd: host, env: { PATH: process.env.PATH, HOME: host } });
      assert.equal(expected.status, 0);
      const want = { err: shown(spawnSync('cat', ['err.txt'], { cwd: host, encoding: 'utf8' }).stdout, host), code: spawnSync('cat', ['code.txt'], { cwd: host, encoding: 'utf8' }).stdout.trim() };
      await session.run(`cd ${W} && ${run(command)}`, 120_000);
      const r = await session.run(`cd ${W} && ${read}`, 60_000);
      const line = splitScenarioOutput(r.stdout).lines.find((l) => l.startsWith('{'));
      assert.ok(line, `${command}: read its output: ${r.stdout.slice(-1500)}`);
      const got = JSON.parse(line);
      const err = shown(Buffer.from(got.err, 'base64').toString('utf8'), W);
      assert.equal(err, want.err, `${command}: stderr is Node's`);
      assert.equal(got.code.trim(), want.code, `${command}: exits as Node does`);
      console.log(`  ok  ${command}: exit ${want.code}`);
    }
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-fatal-report-matches-node-workerd: uncaught errors end the program as they end Node');
