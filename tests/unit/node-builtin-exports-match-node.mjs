// The names Node 22.23.4 gives each builtin's ES namespace beside `default`
// (core runtime/node-builtin-exports.ts, which an ES module's import of a
// builtin is staged with): host Node the oracle. On a difference this prints
// the table as Node gives it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NODE_BUILTIN_EXPORTS } from '../../packages/core/src/runtime/node-builtin-exports.ts';

const PROGRAM = `
const { builtinModules } = require('module');
const names = [...builtinModules, 'node:sea', 'node:sqlite', 'node:test', 'node:test/reporters'].map((n) => n.replace(/^node:/, '')).sort();
const table = {};
for (const name of names) table[name] = Object.keys(require('node:' + name)).filter((k) => k !== 'default').sort();
process.stdout.write(JSON.stringify(table));
`;
const ran = spawnSync('node', ['--no-warnings', '-e', PROGRAM], { encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.equal(ran.status, 0, ran.stderr);
const node = JSON.parse(ran.stdout);
const ours = JSON.parse(JSON.stringify(NODE_BUILTIN_EXPORTS));
if (JSON.stringify(ours) !== JSON.stringify(node)) {
  console.log(Object.entries(node).map(([name, list]) => `  ${JSON.stringify(name)}: ${JSON.stringify(list)},`).join('\n'));
}
assert.deepEqual(ours, node, "the table is Node's");
console.log(`node-builtin-exports-match-node: ${Object.keys(node).length} builtins, as Node names their exports`);
