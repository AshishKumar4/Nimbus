#!/usr/bin/env bun
// One option scanner (utils/args.ts scanOptions) and two policies over it.
// parseArgs, the flag-table collector, answers what it answered as a scanner
// of its own (the expectations below are its answers before it became a
// policy): exact long names, undeclared options set aside, a missing value
// read as '', a boolean given a value true. getopt answers as GNU
// getopt_long, over the same scan: prefixes, and its diagnostics.
import assert from 'node:assert/strict';
import { getopt, parseArgs } from '../../packages/core/src/substrate/lifo/utils/args.ts';

const SPEC = { keep: { type: 'boolean', short: 'k' }, level: { type: 'string', short: 'l' }, name: { type: 'string' }, help: { type: 'boolean' } };
const LEGACY = [
  [["-k", "a"], {"flags": {"keep": true, "level": "", "name": "", "help": false}, "positional": ["a"], "unknown": []}],
  [["-kl3", "b"], {"flags": {"keep": true, "level": "3", "name": "", "help": false}, "positional": ["b"], "unknown": []}],
  [["-l", "4", "-k"], {"flags": {"keep": true, "level": "4", "name": "", "help": false}, "positional": [], "unknown": []}],
  [["-l"], {"flags": {"keep": false, "level": "", "name": "", "help": false}, "positional": [], "unknown": []}],
  [["--level=5", "x"], {"flags": {"keep": false, "level": "5", "name": "", "help": false}, "positional": ["x"], "unknown": []}],
  [["--level", "6"], {"flags": {"keep": false, "level": "6", "name": "", "help": false}, "positional": [], "unknown": []}],
  [["--level"], {"flags": {"keep": false, "level": "", "name": "", "help": false}, "positional": [], "unknown": []}],
  [["--keep=yes"], {"flags": {"keep": true, "level": "", "name": "", "help": false}, "positional": [], "unknown": []}],
  [["--name=", "y"], {"flags": {"keep": false, "level": "", "name": "", "help": false}, "positional": ["y"], "unknown": []}],
  [["--help", "--", "-k", "-"], {"flags": {"keep": false, "level": "", "name": "", "help": true}, "positional": ["-k", "-"], "unknown": []}],
  [["-zk", "--zap=1", "--zip", "f"], {"flags": {"keep": true, "level": "", "name": "", "help": false}, "positional": ["f"], "unknown": ["-z", "--zap", "--zip"]}],
  [["--ke"], {"flags": {"keep": false, "level": "", "name": "", "help": false}, "positional": [], "unknown": ["--ke"]}],
  [["-", "a", "-k"], {"flags": {"keep": true, "level": "", "name": "", "help": false}, "positional": ["-", "a"], "unknown": []}],
];
for (const [argv, want] of LEGACY) assert.deepEqual(parseArgs(argv, SPEC), want, JSON.stringify(argv));

const GNU = { short: 'kl:', long: { keep: ['k', 'none'], level: ['l', 'required'], label: ['label', 'required'], help: ['help', 'none'] } };
const scan = (argv) => [...getopt(argv, GNU)];
assert.deepEqual(scan(['--ke', 'a']), [{ kind: 'option', key: 'k' }, { kind: 'operand', value: 'a' }], 'an unambiguous prefix');
assert.deepEqual(scan(['--l']), [{ kind: 'error', message: "option '--l' is ambiguous; possibilities: '--level' '--label'" }]);
assert.deepEqual(scan(['--keep=1']), [{ kind: 'error', message: "option '--keep' doesn't allow an argument" }]);
assert.deepEqual(scan(['--level']), [{ kind: 'error', message: "option '--level' requires an argument" }]);
assert.deepEqual(scan(['-l']), [{ kind: 'error', message: "option requires an argument -- 'l'" }]);
assert.deepEqual(scan(['-kz', 'x']), [{ kind: 'option', key: 'k' }, { kind: 'error', message: "invalid option -- 'z'" }]);
assert.deepEqual(scan(['--zap=1']), [{ kind: 'error', message: "unrecognized option '--zap=1'" }]);
assert.deepEqual(scan(['a', '-l2', '--', '-k']), [{ kind: 'operand', value: 'a' }, { kind: 'option', key: 'l', value: '2' }, { kind: 'operand', value: '-k' }]);
console.log('option-scanner: ok');
