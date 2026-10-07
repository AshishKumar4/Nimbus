#!/usr/bin/env bun
// The release matrix's grade (scripts/ci/lib/matrix.mjs) against the user's
// deferrals (tests/behavioral/_deferred.mjs): green if and only if every red
// row is a deferred probe's that failed exactly as approved (its one named
// assertion, and nothing else, setup and cleanup included), and every
// deferred probe ran and failed. And the record itself: every entry names an
// existing probe, its assertion, the user's approval, an owner and a
// tracking item, and none is a check that can never be deferred.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { gradeMatrix, outcomeOf } from '../../scripts/ci/lib/matrix.mjs';
import { DEFERRED, validateDeferrals } from '../behavioral/_deferred.mjs';
import { HOSTED_DEMO_CHECKS, PRODUCTION_ONLY_CHECKS } from '../behavioral/_probe-target-skips.mjs';

const BEHAVIORAL = join(import.meta.dirname, '..', 'behavioral');

{
  for (const entry of DEFERRED) {
    assert.ok(existsSync(join(BEHAVIORAL, `${entry.probe}.mjs`)), `${entry.probe}: no such probe`);
    const source = readFileSync(join(BEHAVIORAL, `${entry.probe}.mjs`), 'utf8');
    assert.ok(source.includes(`'${entry.assertion}'`) || source.includes(`"${entry.assertion}"`), `${entry.probe}: it asserts no ${JSON.stringify(entry.assertion)}`);
  }
  const good = { probe: 'frameworks/nuxt-real', assertion: 'a', reason: 'r', approved: 'user, 2026-10-07', owner: 'o', tracking: 't' };
  for (const [entry, refused] of [
    [{ ...good, assertion: '' }, /assertion is required/],
    [{ ...good, approved: 'main, 2026-10-07' }, /approved must be the user's, dated/],
    [{ ...good, approved: 'user' }, /approved must be the user's, dated/],
    [{ ...good, probe: 'frameworks/no-such-probe' }, /no such probe/],
    [{ ...good, probe: 'session-ledger' }, /session-ledger can never be deferred/],
    ...[...HOSTED_DEMO_CHECKS, ...PRODUCTION_ONLY_CHECKS].map((probe) => [{ ...good, probe }, new RegExp(`${probe} can never be deferred`)]),
  ]) {
    assert.throws(() => validateDeferrals([entry]), refused, JSON.stringify(entry));
  }
  assert.throws(() => validateDeferrals([good, good]), /listed twice/);
  console.log(`  ok  _deferred.mjs: ${DEFERRED.length} entr${DEFERRED.length === 1 ? 'y' : 'ies'}, each naming an assertion its probe makes; the loader refuses a missing field, an approval not the user's and dated, an unknown probe, a duplicate, and every never-deferrable check`);
}

const PINNED = 'nuxt dev SSR serves the Vue app through the port route on its first run';
const deferral = { probe: 'frameworks/nuxt-real', assertion: PINNED, reason: 'r', approved: 'user, 2026-10-07', owner: 'o', tracking: 't' };
const row = (name, exitCode, output = '') => ({ name: name === 'session-ledger' || name === 'probes' ? name : `tests/behavioral/${name}.mjs`, exitCode, seconds: 1, output });
/** nuxt-real's output as makeAsserter prints it: each check, then (unless it threw) the summary. */
const nuxt = (checks, { finished = true } = {}) => [
  'frameworks/nuxt-real — BASE=https://example.workers.dev',
  ...checks.map(([ok, label, detail]) => `  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`),
  ...(finished ? ['', `  ──── [frameworks/nuxt-real] ${checks.filter(([ok]) => ok).length} pass / ${checks.filter(([ok]) => !ok).length} fail`] : ['error: install failed', '      at nuxt-real.mjs:26:35']),
].join('\n');
const asApproved = nuxt([[true, 'nuxi creates the real minimal project'], [true, 'npm install succeeds'], [false, PINNED, 'status 503\nNitro builder: building…'], [true, 'probe session deleted']]);
const verdict = (...tasks) => ({ tasks: tasks.map((rows, i) => ({ task: `part ${i + 1}/${tasks.length}`, outcome: { kind: 'exited' }, rows })) });
const ledger = row('session-ledger', 0);

{
  const graded = gradeMatrix([verdict([row('git-local', 0), row('frameworks/nuxt-real', 1, asApproved), ledger])], [deferral]);
  assert.equal(graded.exitCode, 0, graded.problems.join('\n'));
  assert.deepEqual(graded.applied.map((entry) => entry.probe), ['frameworks/nuxt-real']);
  assert.match(graded.applied[0].rows[0].output, /status 503/, 'the deferred probe\'s output is kept');
  console.log('  ok  a deferred probe failing exactly as approved: green, with the deferral applied and the probe\'s output kept');
}
{
  // The deferral is for one assertion: any other failure in the probe is red.
  const cases = [
    ['npm install failed, then the probe threw (no summary)', nuxt([[true, 'nuxi creates the real minimal project'], [false, 'npm install succeeds', 'ENOENT']], { finished: false }), /did not reach its summary/],
    ['scaffold failed, then threw', nuxt([[false, 'nuxi creates the real minimal project', 'exit 1']], { finished: false }), /did not reach its summary/],
    ['the pinned failure, and cleanup failed too', nuxt([[true, 'nuxi creates the real minimal project'], [true, 'npm install succeeds'], [false, PINNED, '503'], [false, 'probe session deleted', 'status=500']]), /other assertions failed: ✗ probe session deleted/],
    ['an install failure that did not throw', nuxt([[true, 'nuxi creates the real minimal project'], [false, 'npm install succeeds', 'x'], [false, PINNED, '503'], [true, 'probe session deleted']]), /other assertions failed: ✗ npm install succeeds/],
    ['a summary counting a failure whose ✗ line was lost', `${nuxt([[true, 'a'], [false, PINNED, '503']])}`.replace('1 pass / 1 fail', '1 pass / 2 fail'), /its summary says 2 failed/],
    ['the pinned assertion only in prose, not as a ✗', `  ✗ npm install succeeds — the next step is ${PINNED}\n\n  ──── [frameworks/nuxt-real] 2 pass / 1 fail`, /other assertions failed: ✗ npm install succeeds/],
  ];
  for (const [what, output, why] of cases) {
    const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 1, output), ledger])], [deferral]);
    assert.equal(graded.exitCode, 1, what);
    assert.match(graded.red.join('\n'), why, what);
    assert.deepEqual(graded.applied, [], what);
  }
  assert.deepEqual(outcomeOf(asApproved), { finished: true, pass: 3, fail: 1, failed: [PINNED] }, 'outcomeOf reads the checks and the summary');
  console.log('  ok  a deferred probe failing any other way (setup, cleanup, an exception, a lost ✗): red, saying how');
}
{
  const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 1, asApproved), row('git-local', 1), ledger])], [deferral]);
  assert.equal(graded.exitCode, 1);
  assert.deepEqual(graded.red, ['tests/behavioral/git-local.mjs (part 1/1, exit 1)']);
  console.log('  ok  any other red row: red');
}
{
  const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 0), ledger])], [deferral]);
  assert.equal(graded.exitCode, 1);
  assert.match(graded.problems.join('\n'), /frameworks\/nuxt-real passes; remove its deferral/);
  assert.deepEqual(graded.applied, []);
  // Passing in any one row is enough: a repeat that passes ends the deferral too.
  const once = gradeMatrix([verdict([row('frameworks/nuxt-real', 1, asApproved)], [row('frameworks/nuxt-real', 0)])], [deferral]);
  assert.equal(once.exitCode, 1);
  console.log('  ok  a deferred probe that passes: red, "remove its deferral"');
}
{
  const graded = gradeMatrix([verdict([row('git-local', 0), ledger])], [deferral]);
  assert.equal(graded.exitCode, 1);
  assert.match(graded.problems.join('\n'), /frameworks\/nuxt-real did not run/);
  console.log('  ok  a deferred probe that did not run: red');
}
{
  const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 1, asApproved), row('session-ledger', 1, 'leaked: x')])], [deferral]);
  assert.equal(graded.exitCode, 1, 'a leaked session is never deferrable');
  const notRun = gradeMatrix([verdict([row('probes', 2, 'NIMBUS_PROBE_TOKEN is not set')])], [deferral]);
  assert.equal(notRun.exitCode, 2, 'a task that was not graded leaves the matrix not graded');
  const noVerdict = gradeMatrix([verdict([row('frameworks/nuxt-real', 1, asApproved)]), null], [deferral]);
  assert.equal(noVerdict.exitCode, 2);
  const lost = gradeMatrix([{ tasks: [{ task: 'part 1/1', outcome: { kind: 'failed' }, rows: null }] }], [deferral]);
  assert.equal(lost.exitCode, 2);
  console.log('  ok  the session ledger is never deferrable, and a task or verdict missing leaves the matrix not graded');
}
{
  const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 1, asApproved), ledger]), verdict([row('auth/new/hosted-demo-try-terminal', 0)])], [deferral]);
  assert.equal(graded.exitCode, 0, 'rows from the suite and the hosted checks are graded together');
  const red = gradeMatrix([verdict([row('frameworks/nuxt-real', 1, asApproved), ledger]), verdict([row('auth/new/hosted-demo-try-terminal', 1)])], [deferral]);
  assert.equal(red.exitCode, 1);
  console.log('  ok  the suite and the hosted checks are one matrix');
}
console.log('ci-deferred OK');
