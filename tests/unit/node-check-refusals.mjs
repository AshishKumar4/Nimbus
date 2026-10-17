#!/usr/bin/env bun
// The hosted node's -c (--check) and --experimental-default-type, where they
// are decided before anything runs (core runtime/runtime-registry.ts):
//   - Node's own refusals of the command line (exit 9), as host Node prints
//     them: -c with -e or -p, an --experimental-default-type that is neither
//     module nor commonjs, and both at once, each on its line; an invalid
//     one in NODE_OPTIONS, which the command line cannot override (nor
//     --version or --help pass);
//   - -c of an ES module entry (.mjs, a typeless .js of module syntax, stdin
//     under --input-type=module) is refused, exit 9, and nothing runs: no ES
//     module compiles here without being evaluated;
//   - --experimental-default-type is refused, exit 9, and nothing runs;
//   - -c of a CommonJS script, of stdin, and of TypeScript (its own text,
//     as Node compiles it under -c) reaches the runner as a check.
// What the runner does with a check (compiles, and does not run) is
// node-check-matches-node-workerd's.
//
// Red before: the hosted node ran every program -c named, and ran
// --experimental-default-type=module's eval code as CommonJS.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildRuntimeHandler } from '../../packages/core/src/runtime/runtime-registry.ts';

const files = {
  'home/user/ok.cjs': 'console.log("ran");\n',
  'home/user/esm.mjs': 'export const a = 1;\n',
  'home/user/typeless.js': 'export const a = 1;\nconsole.log("ran");\n',
  'home/user/ok.ts': 'const a: number = 1;\n',
};

/** The hosted node run with `args` (stdin `input`, NODE_OPTIONS `nodeOptions`): its exit, stderr, and the runs it asked of its runner. */
async function node(args, input, nodeOptions) {
  const runs = [];
  const fs = {
    exists: (p) => Object.hasOwn(files, p),
    isFile: (p) => Object.hasOwn(files, p),
    stat: (p) => (Object.hasOwn(files, p) ? { type: 'file', size: files[p].length } : null),
    readFileString: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error('ENOENT ' + p);
      return files[p];
    },
  };
  const handler = buildRuntimeHandler({
    name: 'node', version: 'v22.22.3', helpText: 'help', supportsBinSpawn: true, nodeCommandLine: true, repl: 'repl',
    async run(code, opts) {
      runs.push({ code, opts });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  }, {
    vfs: { as: () => fs },
    getEsbuild: () => ({
      async transform() { assert.fail('nothing is transformed'); },
      async transformMany() { assert.fail('nothing is stripped under -c'); },
    }),
    registry: { resolve: () => undefined },
  });
  const stderr = [];
  const exitCode = await handler({
    vfs: fs, args, cwd: '/home/user', env: nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions },
    cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    stdout: { write: () => {} },
    stderr: { write: (text) => stderr.push(text) },
    ...(input === undefined ? {} : { stdin: { readAll: async () => input } }),
  });
  return { exitCode, stderr: stderr.join(''), runs };
}

// Node's refusals, host Node the oracle. NODE_OPTIONS' are checked as it is read, before the command line overrides it.
for (const [args, nodeOptions] of [
  [['-c', '-e', '1']], [['-e', '1', '-c']], [['--check', '--print', '1']],
  [['--experimental-default-type=bogus', '-e', '1']], [['--experimental-default-type=bogus', '-c', '-e', '1']],
  [['--experimental-default-type=commonjs', '--version'], '--experimental-default-type=bogus'],
  [['--help'], '--experimental-default-type=bogus'],
  [['--experimental-default-type=bogus', '-c', '-e', '1'], '--experimental-default-type=module'],
]) {
  const host = spawnSync('node', args, { encoding: 'utf8', env: { PATH: process.env.PATH, ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }) } });
  const ours = await node(args, undefined, nodeOptions);
  const label = `${nodeOptions === undefined ? '' : `NODE_OPTIONS=${nodeOptions} `}node ${args.join(' ')}`;
  assert.deepEqual([ours.exitCode, ours.stderr], [host.status, host.stderr], label);
  assert.equal(ours.runs.length, 0, `${label}: nothing runs`);
}

const MODULE_CHECK = 'node: -c cannot check an ES module entry in Nimbus without running it\n';
for (const [args, input] of [[['-c', 'esm.mjs']], [['-c', 'typeless.js']], [['--input-type=module', '-c'], 'export const a = 1;\n']]) {
  const ours = await node(args, input);
  assert.deepEqual([ours.exitCode, ours.stderr], [9, MODULE_CHECK], `node ${args.join(' ')}`);
  assert.equal(ours.runs.length, 0, `node ${args.join(' ')}: nothing runs`);
}
for (const args of [['--experimental-default-type=module', '-e', 'console.log(typeof require)'], ['--experimental-default-type=commonjs', 'ok.cjs']]) {
  const ours = await node(args);
  assert.deepEqual([ours.exitCode, ours.stderr], [9, 'node: --experimental-default-type is not supported by this node\n'], `node ${args.join(' ')}`);
  assert.equal(ours.runs.length, 0, `node ${args.join(' ')}: nothing runs`);
}

// A CommonJS script, stdin of module syntax (checked as CommonJS, as Node does), and TypeScript's own text: a check.
for (const [args, input, code] of [
  [['-c', 'ok.cjs'], undefined, files['home/user/ok.cjs']],
  [['-c'], 'export const a = 1;\n', 'export const a = 1;\n'],
  [['-c', 'ok.ts'], undefined, files['home/user/ok.ts']],
]) {
  const ours = await node(args, input);
  assert.equal(ours.exitCode, 0, `node ${args.join(' ')}: ${ours.stderr}`);
  assert.equal(ours.runs.length, 1, `node ${args.join(' ')}: one run`);
  const [run] = ours.runs;
  assert.equal(run.code, code, `node ${args.join(' ')}: the program's own text`);
  assert.equal(run.opts.node.check, true, `node ${args.join(' ')}: the runner is told it is a check`);
  assert.notEqual(run.opts.esModule, true, `node ${args.join(' ')}: compiled as CommonJS`);
  assert.notEqual(run.opts.launchesServer, true, `node ${args.join(' ')}: not launched as a server`);
}

console.log('node-check-refusals: ok');
