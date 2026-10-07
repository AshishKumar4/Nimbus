#!/usr/bin/env bun
// node's command line is read as Node reads it (core runtime/node-cli.ts),
// against host Node as the oracle:
//
//   (1) for each command line (and NODE_OPTIONS), what Node makes of it:
//       process.execArgv, the program and its arguments, and whether the
//       `development` condition is active (a `#imports` entry under it);
//       or, for one Node refuses, its exit code (9) and its message;
//   (2) the option table (node-cli-options.generated.ts) is Node's own:
//       its value options, the options NODE_OPTIONS may carry, its aliases.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseNodeCommandLine } from '../../packages/core/src/runtime/node-cli.ts';
import { NODE_ENV_OPTIONS, NODE_OPTION_ALIASES, NODE_VALUE_OPTIONS } from '../../packages/core/src/runtime/node-cli-options.generated.ts';

const dir = mkdtempSync(join(tmpdir(), 'node-cli-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', imports: { '#cond': { development: './t.js', default: './f.js' } } }));
writeFileSync(join(dir, 't.js'), 'export default true;');
writeFileSync(join(dir, 'f.js'), 'export default false;');
writeFileSync(join(dir, 'main.mjs'), "import c from '#cond'; console.log(JSON.stringify({ execArgv: process.execArgv, args: process.argv.slice(2), development: c }));");

const cases = [
  [['main.mjs']],
  [['main.mjs', 'a', '-C', 'b']],
  [['--conditions=development', 'main.mjs']],
  [['--conditions', 'development', 'main.mjs', 'x']],
  [['-C', 'development', 'main.mjs']],
  [['-C', 'development', '--', 'main.mjs', '--flag']],
  [['--no-warnings', '-C', 'other', '--conditions=development', 'main.mjs']],
  [['--title', 'nimbus', 'main.mjs']],
  [['--env-file-if-exists', 'none.env', 'main.mjs']],
  [['main.mjs'], '--conditions=development'],
  [['main.mjs'], '-C development'],
  [['main.mjs'], '-C "development"'],
  [['main.mjs'], '--max-old-space-size=100 --conditions development'],
  [['main.mjs'], 'stray -C development'],
  [['main.mjs'], '-C development stray --bogus'],
  [['main.mjs'], '--no_warnings -C development'],
  [['-C', 'other', 'main.mjs'], '-C development'],
  [['main.mjs'], '--bogus'],
  [['main.mjs'], '--eval 1'],
  [['main.mjs'], '--eval=1'],
  [['main.mjs'], '-e=1'],
  [['main.mjs'], '--no-bogus=1'],
  [['main.mjs'], '-C'],
  [['-C']],
  [['main.mjs'], '-C "development'],
];
for (const [args, nodeOptions = ''] of cases) {
  const host = spawnSync('node', args, {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) },
  });
  const ours = parseNodeCommandLine(args, nodeOptions);
  const label = `node ${JSON.stringify(args)}${nodeOptions ? ` NODE_OPTIONS=${JSON.stringify(nodeOptions)}` : ''}`;
  if (host.status !== 0) {
    assert.ok('error' in ours, `${label}: Node refuses it (${host.stderr.trim()}), and so must this`);
    assert.equal(ours.exitCode, host.status, `${label}: exit code`);
    assert.equal(ours.error, host.stderr.split('\n')[0] + '\n', `${label}: message`);
    continue;
  }
  assert.ok(!('error' in ours), `${label}: ${ours.error}`);
  const said = JSON.parse(host.stdout);
  assert.deepEqual(ours.execArgv, said.execArgv, `${label}: execArgv`);
  assert.equal(args[ours.programIndex], 'main.mjs', `${label}: the program`);
  assert.deepEqual(args.slice(ours.programIndex + 1), said.args, `${label}: the program's arguments`);
  assert.equal(ours.conditions.includes('development'), said.development, `${label}: the development condition`);
}
console.log(`  ok  (1) ${cases.length} command lines read as Node reads them`);

// ── (2) the option table is Node's own ──────────────────────────────────────
const dump = spawnSync('node', ['--expose-internals', '-e', `
  const { getCLIOptionsInfo } = require('internal/options');
  const { options, aliases } = getCLIOptionsInfo();
  console.log(JSON.stringify({
    value: [...options].filter(([, info]) => [3, 4, 5, 6, 7].includes(info.type)).map(([name]) => name).sort(),
    env: [...process.allowedNodeEnvironmentFlags].sort(),
    aliases: [...aliases].map(([alias, expansion]) => [alias, [...expansion]]).sort(([a], [b]) => (a < b ? -1 : 1)),
  }));
`], { encoding: 'utf8' });
assert.equal(dump.status, 0, dump.stderr);
const table = JSON.parse(dump.stdout);
assert.deepEqual([...NODE_VALUE_OPTIONS], table.value, 'value options (regenerate: node --expose-internals packages/core/scripts/gen-node-cli-options.mjs)');
assert.deepEqual([...NODE_ENV_OPTIONS], table.env, 'NODE_OPTIONS options');
assert.deepEqual([...NODE_OPTION_ALIASES].map(([alias, expansion]) => [alias, [...expansion]]), table.aliases, 'aliases');
console.log(`  ok  (2) the option table is Node ${process.versions.node ? spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim() : ''}'s own`);

console.log('node-cli-matches-node: command lines and NODE_OPTIONS read as Node reads them');
