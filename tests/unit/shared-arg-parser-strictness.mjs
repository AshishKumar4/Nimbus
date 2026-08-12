#!/usr/bin/env bun

// The shared option parser used to drop any flag it did not recognise, so a
// caller could not tell "the command did what I asked" from "the command
// ignored my flags and did something else". Unknown options are now refused
// with GNU's exact diagnostics, and the one command that must keep going
// (npm) gets them reported instead of swallowed.

import assert from 'node:assert/strict';

import { parseArgs } from '../../packages/worker/src/substrate/lifo/utils/args.ts';

const spec = {
  long: { type: 'boolean', short: 'l' },
  recursive: { type: 'boolean', short: 'rR' },
  format: { type: 'string', short: 'c' },
};

// ── unknown options are refused, not dropped ──────────────────────────────
const badLong = parseArgs('ls', ['--bogus'], spec);
assert.equal(badLong.ok, false);
assert.equal(
  badLong.error,
  "ls: unrecognized option '--bogus'\nTry 'ls --help' for more information.\n",
);

// GNU keeps the `=value` in the diagnostic; so do we.
const badLongValue = parseArgs('ls', ['--bogus=1'], spec);
assert.equal(badLongValue.ok, false);
assert.match(badLongValue.error, /unrecognized option '--bogus=1'/);

const badShort = parseArgs('ls', ['-Q'], spec);
assert.equal(badShort.ok, false);
assert.equal(
  badShort.error,
  "ls: invalid option -- 'Q'\nTry 'ls --help' for more information.\n",
);

// An unknown letter hiding inside a valid cluster is still refused.
const badCluster = parseArgs('ls', ['-lQ'], spec);
assert.equal(badCluster.ok, false);
assert.match(badCluster.error, /invalid option -- 'Q'/);

// ── options that ARE known still work ─────────────────────────────────────
const good = parseArgs('ls', ['-l', 'a.txt'], spec);
assert.equal(good.ok, true);
assert.equal(good.flags.long, true);
assert.deepEqual(good.positional, ['a.txt']);

// Several short aliases can share one long name (rm -r / -R).
for (const alias of ['-r', '-R']) {
  const parsed = parseArgs('rm', [alias], spec);
  assert.equal(parsed.ok, true, alias);
  assert.equal(parsed.flags.recursive, true, alias);
}

// A value can arrive as the next argv or as the rest of the cluster.
for (const argv of [['-c', '%s'], ['-c%s'], ['--format', '%s'], ['--format=%s']]) {
  const parsed = parseArgs('stat', argv, spec);
  assert.equal(parsed.ok, true, argv.join(' '));
  assert.equal(parsed.flags.format, '%s', argv.join(' '));
}

// A missing value is an error, not an empty string.
const missingLong = parseArgs('stat', ['--format'], spec);
assert.equal(missingLong.ok, false);
assert.match(missingLong.error, /option '--format' requires an argument/);

const missingShort = parseArgs('stat', ['-c'], spec);
assert.equal(missingShort.ok, false);
assert.match(missingShort.error, /option requires an argument -- 'c'/);

// A value on a boolean is refused unless the command opts into npm's dialect.
const boolValue = parseArgs('ls', ['--long=1'], spec);
assert.equal(boolValue.ok, false);
assert.match(boolValue.error, /option '--long' doesn't allow an argument/);

// ── `--` and `-` keep their POSIX meaning ─────────────────────────────────
const terminated = parseArgs('ls', ['--', '--bogus', '-Q'], spec);
assert.equal(terminated.ok, true);
assert.deepEqual(terminated.positional, ['--bogus', '-Q']);

const dash = parseArgs('ls', ['-'], spec);
assert.equal(dash.ok, true);
assert.deepEqual(dash.positional, ['-']);

// ── the obsolete bare-number form, only where GNU offers it ───────────────
const numeric = parseArgs('tail', ['-5'], { lines: { type: 'string', short: 'n' } }, {
  numericShorthand: 'lines',
});
assert.equal(numeric.ok, true);
assert.equal(numeric.flags.lines, '5');

// Without that opt-in, `-5` is an invalid option, exactly as GNU treats it.
const numericElsewhere = parseArgs('ls', ['-5'], spec);
assert.equal(numericElsewhere.ok, false);
assert.match(numericElsewhere.error, /invalid option -- '5'/);

// ── tolerant mode reports unknown options rather than dropping them ───────
const tolerant = parseArgs('npm', ['--bogus', '-Z', '-l', 'pkg'], spec, {
  tolerateUnknown: true,
});
assert.equal(tolerant.ok, true);
assert.deepEqual(tolerant.unknown, ['--bogus', '-Z']);
assert.equal(tolerant.flags.long, true, 'known flags still parse alongside unknown ones');
assert.deepEqual(tolerant.positional, ['pkg']);

// A clean parse reports no unknowns, so callers can trust the field.
assert.deepEqual(parseArgs('ls', ['-l'], spec).unknown, []);

// ── npm's `--flag=false` boolean dialect ──────────────────────────────────
const npmBool = parseArgs('npm', ['--long=false'], spec, { booleanValues: true });
assert.equal(npmBool.ok, true);
assert.equal(npmBool.flags.long, false);

const npmBoolTrue = parseArgs('npm', ['--long=true'], spec, { booleanValues: true });
assert.equal(npmBoolTrue.ok, true);
assert.equal(npmBoolTrue.flags.long, true);

console.log('shared-arg-parser-strictness: ok');
