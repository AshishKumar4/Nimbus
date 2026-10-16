#!/usr/bin/env bun
// `npm run` runs a script as npm does: the script's text through the shell,
// the words after the script name (after `--`) appended to it, each quoted
// for the shell, with pre<event> before and post<event> after it, and
// node_modules/.bin of the project and its parents first on its PATH. A
// project's bins are its own: running a script in one project does not make
// its bins commands of another.
//
// Red before: a script with no shell operator was split on whitespace
// (`mkdir "a b"` made `"a` and `b"`), the words after `--` were dropped,
// pre and post scripts did not run, and npm run registered the project's
// bins as workspace-wide commands, so project B ran project A's tool.

import assert from 'node:assert/strict';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { writeText } from '../../packages/core/src/vfs/vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
/** The workspace's shell runs each script, as a host's shellExecute does. */
const shellExecute = async (command, ctx) => {
  const result = await ws.exec(command, { cwd: ctx.cwd, env: ctx.env });
  await ctx.stdout.write(result.stdout);
  await ctx.stderr.write(result.stderr);
  return result.exitCode;
};
ws.registry.register('npm', createNpmCommand(ws.registry, shellExecute, ws.kernel));
const calls = [];
ws.registry.register('record', (ctx) => {
  calls.push({ args: ctx.args, event: ctx.env.npm_lifecycle_event, script: ctx.env.npm_lifecycle_script });
  return 0;
});
/** Each case runs; the file fails at the end with every case that failed. */
const failures = [];
const check = async (name, body) => {
  try {
    await body();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✗ ${name}: ${error.message}`);
  }
};
const project = async (dir, scripts) => {
  await ws.exec(`mkdir -p ${dir}`);
  await writeText(ws.fs, `${dir}/package.json`, JSON.stringify({ name: dir.split('/').pop(), version: '1.0.0', scripts }));
};

// ── a quoted word is one word ──
await check('a script\'s quoted word reaches its command whole', async () => {
  await project('/home/user/q', { make: 'mkdir "a b"' });
  const run = await ws.exec('npm run make', { cwd: '/home/user/q' });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal((await ws.exec('test -d "/home/user/q/a b"')).exitCode, 0, 'mkdir "a b" makes one directory, a b');
  assert.notEqual((await ws.exec('test -e \'/home/user/q/"a\'')).exitCode, 0, 'and no directory "a');
});

// ── the words after the script name, after --, are the script's ──
await check('npm run rec -- a b passes a and b, each whole', async () => {
  await project('/home/user/f', { rec: 'record first' });
  calls.length = 0;
  const run = await ws.exec(`npm run rec -- --flag 'two words' "it's"`, { cwd: '/home/user/f' });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(calls.map(({ args }) => args), [['first', '--flag', 'two words', "it's"]]);
  assert.equal(calls[0].script, 'record first', 'npm_lifecycle_script is the script, without its arguments');
});

// ── pre and post scripts run around the script, the arguments the script's alone ──
await check('npm test runs pretest, test and posttest in order; a failure stops it', async () => {
  await project('/home/user/t', { pretest: 'record pre', test: 'record main', posttest: 'record post' });
  calls.length = 0;
  const run = await ws.exec('npm test -- x', { cwd: '/home/user/t' });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(calls.map(({ args, event }) => [event, ...args]), [['pretest', 'pre'], ['test', 'main', 'x'], ['posttest', 'post']]);
  calls.length = 0;
  assert.equal((await ws.exec('npm test --ignore-scripts', { cwd: '/home/user/t' })).exitCode, 0);
  assert.deepEqual(calls.map(({ event }) => event), ['test'], '--ignore-scripts runs the script alone');
  await project('/home/user/t', { pretest: 'false', test: 'record main' });
  calls.length = 0;
  assert.notEqual((await ws.exec('npm test', { cwd: '/home/user/t' })).exitCode, 0, 'a failed pretest fails npm test');
  assert.deepEqual(calls, [], 'and the test does not run');
});

// ── a project's bins are its own ──
await check('a bin of project a is not a command of project b', async () => {
  await project('/home/user/a', { tool: 'toola' });
  await project('/home/user/b', { tool: 'toola' });
  await ws.exec('mkdir -p /home/user/a/node_modules/tool-a /home/user/a/node_modules/.bin');
  await writeText(ws.fs, '/home/user/a/node_modules/tool-a/package.json', JSON.stringify({ name: 'tool-a', version: '1.0.0', bin: { toola: 'cli.sh' } }));
  await writeText(ws.fs, '/home/user/a/node_modules/tool-a/cli.sh', '#!/bin/sh\necho tool-a ran\n');
  await writeText(ws.fs, '/home/user/a/node_modules/.bin/toola', '#!/bin/sh\necho tool-a ran\n');
  await ws.exec('chmod 755 /home/user/a/node_modules/.bin/toola /home/user/a/node_modules/tool-a/cli.sh');
  const inA = await ws.exec('npm run tool', { cwd: '/home/user/a' });
  assert.match(inA.stdout, /tool-a ran/, `project a runs its own bin:\n${inA.stdout}${inA.stderr}`);
  const inB = await ws.exec('npm run tool', { cwd: '/home/user/b' });
  assert.equal(inB.exitCode, 127, `project b has no toola:\n${inB.stdout}${inB.stderr}`);
  assert.doesNotMatch(inB.stdout, /tool-a ran/);
});

harness.db.close();
assert.deepEqual(failures, [], 'every case holds');
console.log('npm-run-invocation: ok');
