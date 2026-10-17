#!/usr/bin/env bun
// node:path's posix half (core _shared/posix-path.ts, the guest's node:path)
// answers as Node v22.22.3's does: host Node's path.posix the oracle, over a
// generated corpus. Every string of '/', '.', 'a' and 'é' up to six long, for
// each function of one path (dirname, basename, extname, normalize,
// isAbsolute, parse, toNamespacedPath); every pair of them up to three long
// for join, resolve, relative and basename's suffix; format over the parts
// parse makes and over objects with some parts missing; and each argument
// Node refuses, by its error's code and message.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPosixPath } from '../../packages/core/src/_shared/posix-path.ts';

const ALPHABET = ['/', '.', 'a', 'é'];
const strings = (max) => {
  const out = [''];
  let level = [''];
  for (let length = 1; length <= max; length++) {
    const next = [];
    for (const prefix of level) for (const char of ALPHABET) next.push(prefix + char);
    out.push(...next);
    level = next;
  }
  return out;
};
const singles = strings(6);
const shorts = strings(3);
const formats = [
  ...strings(2).map((s) => ({ dir: s, base: 'b' })),
  { root: '/', base: 'x' }, { root: '/', dir: '/', base: 'x' }, { root: '/', dir: '/a', name: 'n', ext: 'e' },
  { name: 'n', ext: '.e' }, { name: 'n' }, { ext: 'e' }, { dir: 'd', name: 'n', ext: '.e', base: '' }, {},
];
const refused = [
  ['dirname', [5]], ['basename', [5]], ['basename', ['a', 3]], ['extname', [null]], ['normalize', [{}]], ['isAbsolute', [1n]],
  ['parse', [undefined]], ['join', ['a', 3]], ['resolve', ['a', 3, 'b']], ['resolve', [3, '/abs']], ['relative', [1, 'a']], ['relative', ['a', 1]],
  ['format', [1]], ['format', [null]], ['format', [[]]], ['format', ['x']], ['format', [undefined]], ['toNamespacedPath', [5]],
];
const calls = [];
for (const s of singles) for (const fn of ['dirname', 'basename', 'extname', 'normalize', 'isAbsolute', 'parse', 'toNamespacedPath']) calls.push([fn, [s]]);
for (const a of shorts) {
  for (const b of shorts) {
    calls.push(['join', [a, b]], ['resolve', [a, b]], ['relative', [a, b]], ['basename', [a, b]]);
  }
}
calls.push(['join', []], ['resolve', []], ['resolve', ['']], ['resolve', ['.']], ['join', ['a', '', 'b', '..', 'c/']]);
for (const object of formats) calls.push(['format', [object]]);
calls.push(...refused);

const answer = (path) => (fn, args) => {
  try {
    return { value: path[fn](...args) };
  } catch (error) {
    return { code: error.code, message: error.message };
  }
};
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'posix-path-')));
try {
  // Host Node, in `cwd`: its path.posix over the same calls (a bigint argument as its own).
  const script = `const p = require('node:path').posix;
const calls = JSON.parse(require('node:fs').readFileSync(0, 'utf8'), (k, v) => v === 'undefined:' ? undefined : typeof v === 'string' && v.startsWith('bigint:') ? BigInt(v.slice(7)) : v);
const answer = (fn, args) => { try { return { value: p[fn](...args) }; } catch (error) { return { code: error.code, message: error.message }; } };
process.stdout.write(JSON.stringify(calls.map(([fn, args]) => answer(fn, args))));`;
  const node = spawnSync('node', ['-e', script], {
    // A bigint, and undefined (JSON's null in an array), as themselves.
    cwd, input: JSON.stringify(calls, (k, v) => (typeof v === 'bigint' ? `bigint:${v}` : v === undefined ? 'undefined:' : v)), encoding: 'utf8', maxBuffer: 1 << 28, env: { PATH: process.env.PATH },
  });
  assert.equal(node.status, 0, node.stderr);
  const want = JSON.parse(node.stdout);
  const port = answer(createPosixPath(() => cwd));
  const failures = [];
  calls.forEach(([fn, args], i) => {
    const seen = port(fn, args);
    if (JSON.stringify(seen) !== JSON.stringify(want[i])) failures.push(`${fn}(${args.map((a) => (typeof a === 'bigint' ? `${a}n` : JSON.stringify(a))).join(', ')}): want ${JSON.stringify(want[i])}, seen ${JSON.stringify(seen)}`);
  });
  console.log(failures.slice(0, 40).join('\n'));
  assert.deepEqual(failures, [], `${failures.length} of ${calls.length} calls answer otherwise than Node's path.posix`);
  console.log(`ok - posix-path-matches-node (${calls.length} calls, as host Node's path.posix answers them)`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
