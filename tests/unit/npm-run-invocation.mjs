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
// bins as workspace-wide commands, so project B ran project A's tool, and
// core's install linked no bins of a project's packages.

import assert from 'node:assert/strict';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
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

// ── a project's bins are its own, linked by its install ──
// A registry: tool-a 1.0.0 has the bin toola, 2.0.0 renames it toolb;
// dotted's bin .toola becomes .toolb; strbin 1.0.0's bin is a string (so it
// is named strbin), 2.0.0 has none; shared-a and shared-b both declare
// shared, and shared-a 2.0.0 drops it.
const TARBALLS = new Map();
const PACKUMENTS = {};
const publish = async (name, version, bin) => {
  const manifest = { name, version, ...(bin === undefined ? {} : { bin }) };
  const bytes = packageTarball({ 'package/package.json': JSON.stringify(manifest), 'package/cli.js': `console.log('${name} ${version} ran');\n` });
  const tarball = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  TARBALLS.set(tarball, bytes);
  PACKUMENTS[name] ??= { name, 'dist-tags': {}, versions: {} };
  PACKUMENTS[name].versions[version] = { ...manifest, dist: { tarball, integrity: await sriOf(bytes) } };
  PACKUMENTS[name]['dist-tags'].latest = version;
};
await publish('tool-a', '1.0.0', { toola: 'cli.js' });
await publish('tool-a', '2.0.0', { toolb: 'cli.js' });
await publish('dotted', '1.0.0', { '.toola': 'cli.js' });
await publish('dotted', '2.0.0', { '.toolb': 'cli.js' });
await publish('strbin', '1.0.0', 'cli.js');
await publish('strbin', '2.0.0');
await publish('shared-a', '1.0.0', { shared: 'cli.js' });
await publish('shared-a', '2.0.0');
await publish('shared-b', '1.0.0', { shared: 'cli.js' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const text = String(url);
  if (TARBALLS.has(text)) return new Response(TARBALLS.get(text));
  const [name, which] = text.slice('https://registry.npmjs.org/'.length).split('/').map(decodeURIComponent);
  const doc = PACKUMENTS[name];
  if (!doc) return new Response('not found', { status: 404 });
  if (which === undefined) return Response.json(doc);
  const version = doc.versions[which] ? which : doc['dist-tags'][which];
  return version ? Response.json(doc.versions[version]) : new Response('not found', { status: 404 });
};
const linked = async (path) => (await ws.exec(`test -x ${path}`)).exitCode === 0;
try {
  await check('a bin of project a is not a command of project b', async () => {
    await project('/home/user/a', { tool: 'toola' });
    await project('/home/user/b', { tool: 'toola' });
    const install = await ws.exec('npm install tool-a@1.0.0', { cwd: '/home/user/a' });
    assert.equal(install.exitCode, 0, install.stderr);
    const inA = await ws.exec('npm run tool', { cwd: '/home/user/a' });
    const inB = await ws.exec('npm run tool', { cwd: '/home/user/b' });
    assert.equal(inB.exitCode, 127, `project b has no toola, after project a ran it:\n${inB.stdout}${inB.stderr}`);
    assert.doesNotMatch(inB.stdout, /tool-a .* ran/);
    assert.match(inA.stdout, /tool-a 1\.0\.0 ran/, `project a runs the bin its install linked:\n${inA.stdout}${inA.stderr}`);
  });

  await check('a project\'s .bin follows its packages: relinked, renamed and pruned', async () => {
    await ws.exec('rm -rf /home/user/a/node_modules/.bin');
    assert.equal((await ws.exec('npm install', { cwd: '/home/user/a' })).exitCode, 0, 'an install that changes no package');
    assert.match((await ws.exec('toola', { cwd: '/home/user/a', env: { PATH: '/home/user/a/node_modules/.bin:/usr/bin:/bin' } })).stdout, /tool-a 1\.0\.0 ran/, 'links what is installed');
    assert.equal((await ws.exec('npm install tool-a@2.0.0', { cwd: '/home/user/a' })).exitCode, 0);
    assert.equal((await ws.exec('test -e /home/user/a/node_modules/.bin/toola')).exitCode, 1, 'a bin the new version does not declare is unlinked');
    assert.equal((await ws.exec('test -x /home/user/a/node_modules/.bin/toolb')).exitCode, 0, 'and its own is linked');
    assert.equal((await ws.exec('npm install dotted@1.0.0', { cwd: '/home/user/a' })).exitCode, 0);
    assert.ok(await linked('/home/user/a/node_modules/.bin/.toola'), 'a bin whose name starts with a dot is linked');
    assert.equal((await ws.exec('npm install dotted@2.0.0', { cwd: '/home/user/a' })).exitCode, 0);
    assert.ok(!await linked('/home/user/a/node_modules/.bin/.toola'), 'and unlinked when the new version renames it');
    assert.ok(await linked('/home/user/a/node_modules/.bin/.toolb'));
    await writeText(ws.fs, '/home/user/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));
    assert.equal((await ws.exec('npm install', { cwd: '/home/user/a' })).exitCode, 0, 'an install that prunes tool-a and dotted');
    assert.ok(!await linked('/home/user/a/node_modules/.bin/toolb'), 'a pruned package\'s bin is unlinked');
    assert.ok(!await linked('/home/user/a/node_modules/.bin/.toolb'), 'a dotted one too');
  });

  await check('a global upgrade unlinks the bins it drops, and only its own', async () => {
    assert.equal((await ws.exec('npm install -g alias@npm:strbin@1.0.0', { cwd: '/home/user' })).exitCode, 0);
    assert.ok(await linked('/usr/local/bin/strbin'), 'an alias\'s string bin is named for the package it installs');
    assert.equal((await ws.exec('npm install -g alias@npm:strbin@2.0.0', { cwd: '/home/user' })).exitCode, 0);
    assert.ok(!await linked('/usr/local/bin/strbin'), 'and is unlinked when its new version has none');
    for (const spec of ['shared-a@1.0.0', 'shared-b@1.0.0', 'shared-a@2.0.0']) {
      const install = await ws.exec(`npm install -g ${spec}`, { cwd: '/home/user' });
      assert.equal(install.exitCode, 0, install.stderr);
    }
    const shared = await ws.exec('shared', { cwd: '/home/user' });
    assert.match(shared.stdout, /shared-b 1\.0\.0 ran/, `shared-a's upgrade leaves shared-b's link of shared:\n${shared.stdout}${shared.stderr}`);
  });

  await check('a global install\'s bin is a command after a boot, found on PATH', async () => {
    const install = await ws.exec('npm install -g tool-a@1.0.0', { cwd: '/home/user' });
    assert.equal(install.exitCode, 0, install.stderr);
    await ws.close();
    const booted = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
    try {
      assert.equal(booted.registry.has('toola'), false, 'nothing registers it');
      const ran = await booted.exec('toola', { cwd: '/home/user' });
      assert.match(ran.stdout, /tool-a 1\.0\.0 ran/, `${ran.stdout}${ran.stderr}`);
    } finally {
      await booted.close();
    }
  });
} finally {
  globalThis.fetch = originalFetch;
}

harness.db.close();
assert.deepEqual(failures, [], 'every case holds');
console.log('npm-run-invocation: ok');
