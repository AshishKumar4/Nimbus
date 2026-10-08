// @serial
// The errors the runtime gives a code have Node's own shape (core
// _shared/node-error.ts, lib/internal/errors.js v22.22.3), in a session as in
// Node (host Node the oracle, on the same files): a NodeError's String(),
// its stack's first line and util.inspect read `Name [CODE]: message`, its
// `code` its one own enumerable key, its name and constructor its base's; a
// SystemError adds the system call's context, which inspect shows through
// its getters; an error Node gives no code has none; and an uncaught one
// is headed as Node heads it. Before, each was a plain error with a `code` set
// on it: `TypeError: Unknown option '--x'`. An ERR_INVALID_ARG_TYPE describes
// the value as Node does (node-invalid-arg-type-matches-node).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTerminal, splitScenarioOutput, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/node-errors';
const FILES = {
  'cases.cjs': `
const util = require('util');
const fs = require('fs');
fs.mkdirSync('d', { recursive: true });
fs.writeFileSync('a.txt', 'a');
fs.writeFileSync('b.txt', 'b');
const report = (label, e, withCtor = true) => {
  console.log(JSON.stringify({
    label,
    string: String(e),
    header: String(e.stack).split('\\n')[0],
    keys: Object.keys(e),
    name: e.name,
    ownName: Object.prototype.hasOwnProperty.call(e, 'name'),
    ...(withCtor ? { ctor: e.constructor.name } : {}),
    error: e instanceof Error,
    inspect: util.inspect(e).split('\\n').filter((line) => !/^\\s+at /.test(line)),
  }));
};
const cases = [
  ['parseArgs', () => util.parseArgs({ args: ['--nope'], options: {} })],
  ['require empty id', () => require('module').prototype.require.call(module, '')],
  ['rm a directory', () => fs.rmSync('d'), false],
  ['cp onto a file', () => fs.cpSync('a.txt', 'b.txt', { force: false, errorOnExist: true }), false],
  ['cp a directory', () => fs.cpSync('d', 'd2')],
  ['process.binding', () => process.binding('nope')],
  ['require a number', () => require('module').prototype.require.call(module, 5)],
  ['a glob exclude', () => fs.globSync('*', { exclude: 5 })],
  ['a warning', () => process.emitWarning(5)],
  ['table properties', () => console.table([], 'x')],
  ['a console stream', () => new console.Console({ stdout: {} })],
];
for (const [label, run, withCtor] of cases) {
  try { run(); console.log(label, 'did not throw'); } catch (e) { report(label, e, withCtor); }
}
const w = new (require('stream').Writable)({ write(chunk, encoding, callback) { callback(); } });
w.on('error', () => {});
w.destroy();
w.write('x', (e) => report('write after destroy', e));
`,
  'uncaught.cjs': "require('util').parseArgs({ args: ['--x'], options: {} });\n",
};

const host = mkdtempSync(join(tmpdir(), 'node-errors-'));
process.on('exit', () => rmSync(host, { recursive: true, force: true }));
for (const [path, text] of Object.entries(FILES)) writeFileSync(join(host, path), text);
const hostRun = (command) => {
  const r = spawnSync('sh', ['-c', command], { cwd: host, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: host } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

console.log('node-errors-match-node-workerd: starting local workerd');
const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const made = await session.run(`mkdir -p ${W}`, 30_000);
    assert.equal(made.status, 0, made.stdout);
    for (const [path, text] of Object.entries(FILES)) await session.writeFile(`${W}/${path}`, text);

    const expected = hostRun('node cases.cjs');
    assert.equal(expected.status, 0, expected.stderr);
    const r = await session.run(`cd ${W} && node cases.cjs`, 120_000);
    const got = splitScenarioOutput(r.stdout).lines.filter((line) => line.startsWith('{'));
    const want = expected.stdout.trim().split('\n');
    assert.equal(got.length, want.length, `every case reports: ${r.stdout.slice(-2000)}`);
    for (let i = 0; i < want.length; i++) {
      assert.deepEqual(JSON.parse(got[i]), JSON.parse(want[i]), `${JSON.parse(want[i]).label} has Node's shape`);
      console.log(`  ok  ${JSON.parse(want[i]).label}: ${JSON.parse(want[i]).header}`);
    }

    // Uncaught: the error's first line is Node's. (The rest of Node's fatal
    // report, the source line and the error's own properties, is not this
    // test's.)
    const uncaught = hostRun('node uncaught.cjs');
    const header = uncaught.stderr.split('\n').find((line) => line.startsWith('TypeError ['));
    assert.ok(header, `host: ${uncaught.stderr}`);
    const u = await session.run(`cd ${W} && node uncaught.cjs`, 120_000);
    assert.equal(u.status, uncaught.status, `uncaught: exit ${u.status}: ${u.stdout.slice(-1500)}`);
    const printed = splitScenarioOutput(u.stdout).lines;
    assert.ok(printed.includes(header), `uncaught prints ${header}: ${u.stdout.slice(-1500)}`);
    console.log(`  ok  uncaught: ${header}`);
  } finally {
    await session.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-errors-match-node-workerd: coded errors have Node\'s shape');
