#!/usr/bin/env bun
// A lifo CommonJS command runs in the shell's realm, whose process is the
// host's, yet a warning the engine's own builtins raise for it
// (util.deprecate) is the command's, as Node delivers a warning to the
// process that raised it: its process's 'warning' listeners hear it and its
// stderr carries it as Node writes it. Two commands running at once each
// hear their own; the host keeps its own warnings, raised outside them.
// Under Bun against the source, then under node against the built package
// (packages/core/dist: rebuild first).
//
// Red before: the builtin's warning went to the host's process, its
// listeners and its stderr, and the command heard nothing.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { deprecate } from 'node:util';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const source = (path) => `../../packages/core/${underBun ? 'src' : 'dist'}/${path}.${underBun ? 'ts' : 'js'}`;
const { NimbusWorkspace } = await import(source('workspace/nimbus-workspace'));
const { createLifoCommand } = await import(source('substrate/lifo/pkg/lifo-runtime'));

const hostHeard = [];
process.on('warning', (warning) => hostHeard.push(warning.code));

const command = `
const util = require('util');
module.exports = async (ctx) => {
  process.on('warning', (w) => console.log('heard', w.code));
  await new Promise((resolve) => setTimeout(resolve, 20));
  util.deprecate(() => 1, 'old api of ' + ctx.args[0], 'DEP_' + ctx.args[0])();
  await new Promise((resolve) => setTimeout(resolve, 40));
  return 0;
};
`;
const workspaces = [];
let failure = null;
try {
  for (let i = 0; i < 2; i++) {
    const { sql, transactions } = await hostSqlite();
    const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
    await ws.fs.mkdir('/home/user/pkg', { recursive: true });
    await ws.fs.writeFile('/home/user/pkg/warn.js', command);
    ws.registry.register('warn', createLifoCommand('/home/user/pkg/warn.js', ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } })));
    workspaces.push(ws);
  }
  const [a, b] = await Promise.all([workspaces[0].exec('warn A'), workspaces[1].exec('warn B')]);
  const told = (code, what) => new RegExp(`^\\(node:\\d+\\) \\[${code}\\] DeprecationWarning: old api of ${what}\\n\\(Use \`node --trace-deprecation \\.\\.\\.\` to show where the warning was created\\)\\n$`);
  assert.deepEqual([a.exitCode, a.stdout], [0, 'heard DEP_A\n'], `the command hears its own warning: ${a.stderr}`);
  assert.match(a.stderr, told('DEP_A', 'A'));
  assert.deepEqual([b.exitCode, b.stdout], [0, 'heard DEP_B\n'], `the other command hears its own: ${b.stderr}`);
  assert.match(b.stderr, told('DEP_B', 'B'));
  deprecate(() => 1, 'the host\'s own', 'DEP_HOST')();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(hostHeard, ['DEP_HOST'], 'the host hears its own warning, and none of the commands\'');
} catch (error) {
  failure = error;
} finally {
  for (const ws of workspaces) await ws.close();
}

if (underBun) {
  // Under node whatever Bun answered, so a red run shows both.
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(failure, null, `bun: ${failure?.message}\n\nunder node (exit ${node.status}):\n${node.stdout}${node.stderr}`);
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-command-warnings (a builtin\'s warning is the command\'s; under Bun and Node)');
} else {
  if (failure !== null) throw failure;
  console.log('ok - under node');
}
