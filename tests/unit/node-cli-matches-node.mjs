#!/usr/bin/env bun
// node's command line is read as Node reads it (core runtime/node-cli.ts),
// against host Node as the oracle:
//
//   (1) for each command line (and NODE_OPTIONS), what Node makes of it:
//       process.execArgv, the program and its arguments, and whether the
//       `development` condition is active (a `#imports` entry under it);
//       or, for one Node refuses, its exit code (9) and its message: an
//       empty `--conditions=`, a value that is an option (`-C --version`),
//       a short option with `=` (`-C=development`), the `\-` escape, a bad
//       option, a V8 flag, `--no-` of a non-boolean, `--` in NODE_OPTIONS;
//   (1e) for `-e` and `-p`: the code, its arguments and execArgv;
//   (2) the option table (node-cli-options.generated.ts) is Node's own:
//       its value options, the options NODE_OPTIONS may carry, its aliases.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseNodeCommandLine } from '../../packages/core/src/runtime/node-cli.ts';
import {
  NODE_BOOLEAN_OPTIONS, NODE_ENV_OPTIONS, NODE_KNOWN_OPTIONS, NODE_OPTION_ALIASES, NODE_V8_FLAGS, NODE_VALUE_OPTIONS,
} from '../../packages/core/src/runtime/node-cli-options.generated.ts';

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
  [['--conditions=', 'main.mjs']],
  [['-C', '--version', 'main.mjs']],
  [['-C', '--', 'main.mjs']],
  [['-C=development', 'main.mjs']],
  [['-C', '\\-development', 'main.mjs']],
  [['--conditions', '\\-dev', 'main.mjs']],
  [['--conditions=\\-dev', 'main.mjs']],
  [['--no-conditions', 'main.mjs']],
  [['--bogus', 'main.mjs']],
  [['-x', 'main.mjs']],
  [['--no-bogus', 'main.mjs']],
  [['--harmony', '--expose_gc', '--max-old-space-size=100', 'main.mjs']],
  [['--no-warnings', '--no_deprecation', 'main.mjs']],
  [['--stack-size=900', 'main.mjs']],
  [['--title=', 'main.mjs']],
  [['main.mjs'], '--'],
  [['main.mjs'], '--no-warnings --'],
  [['main.mjs'], '--no-conditions'],
  [['main.mjs'], '--no-conditions=x'],
  [['main.mjs'], '--conditions='],
  [['main.mjs'], '-C=development'],
  [['main.mjs'], '--conditions --version'],
  [['main.mjs'], '-C \\-dev'],
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

// ── (1e) -e and -p ──────────────────────────────────────────────────────────
const EVAL = 'console.log(JSON.stringify({ execArgv: process.execArgv, args: process.argv.slice(1) }))';
const evalCases = [
  ['-e', EVAL],
  ['-e', EVAL, 'a', 'b'],
  ['--eval', EVAL, '-C', 'development', 'x'],
  ['-C', 'development', '-e', EVAL, '--', '-x'],
  ['--eval=' + EVAL, 'y'],
];
for (const args of evalCases) {
  const host = spawnSync('node', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
  assert.equal(host.status, 0, host.stderr);
  const said = JSON.parse(host.stdout);
  const ours = parseNodeCommandLine(args);
  assert.ok(!('error' in ours), ours.error);
  assert.equal(ours.eval, EVAL, `node ${JSON.stringify(args)}: the code`);
  assert.deepEqual(ours.execArgv, said.execArgv, `node ${JSON.stringify(args)}: execArgv`);
  assert.deepEqual(args.slice(ours.programIndex), said.args, `node ${JSON.stringify(args)}: the program's arguments`);
}
for (const args of [['-p', '1+1'], ['-pe', '1+1'], ['--print', '1+1'], ['-p', '-e', '1+1']]) {
  const host = spawnSync('node', args, { encoding: 'utf8' });
  assert.equal(host.stdout, '2\n', `host node ${args.join(' ')}`);
  const ours = parseNodeCommandLine(args);
  assert.ok(!('error' in ours) && ours.print && ours.eval === '1+1', `node ${JSON.stringify(args)}: print, and the code: ${JSON.stringify(ours)}`);
  assert.deepEqual(ours.execArgv, args, `node ${JSON.stringify(args)}: execArgv`);
}
console.log(`  ok  (1e) ${evalCases.length} -e command lines and four -p ones read as Node reads them`);

// ── (2) the option table is Node's own ──────────────────────────────────────
const dump = spawnSync('node', ['--expose-internals', '-e', `
  const { getCLIOptionsInfo } = require('internal/options');
  const { options, aliases } = getCLIOptionsInfo();
  console.log(JSON.stringify({
    known: [...options.keys()].sort(),
    boolean: [...options].filter(([, info]) => info.type === 2).map(([name]) => name).sort(),
    value: [...options].filter(([, info]) => [3, 4, 5, 6, 7].includes(info.type)).map(([name]) => name).sort(),
    env: [...process.allowedNodeEnvironmentFlags].sort(),
    aliases: [...aliases].map(([alias, expansion]) => [alias, [...expansion]]).sort(([a], [b]) => (a < b ? -1 : 1)),
  }));
`], { encoding: 'utf8' });
assert.equal(dump.status, 0, dump.stderr);
const table = JSON.parse(dump.stdout);
assert.deepEqual([...NODE_KNOWN_OPTIONS], table.known, 'options (regenerate: node --expose-internals packages/core/scripts/gen-node-cli-options.mjs)');
assert.deepEqual([...NODE_BOOLEAN_OPTIONS], table.boolean, 'boolean options');
assert.deepEqual([...NODE_VALUE_OPTIONS], table.value, 'value options');
const v8 = [...new Set(spawnSync('node', ['--v8-options'], { encoding: 'utf8' }).stdout.split('\n').flatMap((line) => /^ {2}--([a-z0-9][a-z0-9_-]*) /.exec(line)?.[1] ?? []))].sort();
assert.deepEqual([...NODE_V8_FLAGS], v8, 'V8 flags');
assert.deepEqual([...NODE_ENV_OPTIONS], table.env, 'NODE_OPTIONS options');
assert.deepEqual([...NODE_OPTION_ALIASES].map(([alias, expansion]) => [alias, [...expansion]]), table.aliases, 'aliases');
console.log(`  ok  (2) the option table is Node ${process.versions.node ? spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim() : ''}'s own`);

console.log('node-cli-matches-node: command lines and NODE_OPTIONS read as Node reads them');
