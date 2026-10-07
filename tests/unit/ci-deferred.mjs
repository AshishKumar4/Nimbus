#!/usr/bin/env bun
// The release matrix's grade (scripts/ci/lib/matrix.mjs) against the user's
// deferrals (tests/behavioral/_deferred.mjs): green if and only if every red
// row is a deferred probe's, and every deferred probe ran and failed. And the
// record itself: every entry names an existing probe and carries the user's
// approval, an owner and a tracking item.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { gradeMatrix } from '../../scripts/ci/lib/matrix.mjs';
import { DEFERRED } from '../behavioral/_deferred.mjs';

const BEHAVIORAL = join(import.meta.dirname, '..', 'behavioral');

{
  const probes = new Set();
  for (const entry of DEFERRED) {
    for (const field of ['probe', 'reason', 'approved', 'owner', 'tracking']) {
      assert.ok(typeof entry[field] === 'string' && entry[field].trim(), `${entry.probe ?? '?'}: ${field} is required`);
    }
    assert.match(entry.approved, /^user, \d{4}-\d{2}-\d{2}$/, `${entry.probe}: the approval is the user's, dated`);
    assert.ok(existsSync(join(BEHAVIORAL, `${entry.probe}.mjs`)), `${entry.probe}: no such probe`);
    assert.ok(!probes.has(entry.probe), `${entry.probe}: listed twice`);
    probes.add(entry.probe);
  }
  console.log(`  ok  _deferred.mjs: ${DEFERRED.length} entr${DEFERRED.length === 1 ? 'y' : 'ies'}, each an existing probe with the user's dated approval, an owner and a tracking item`);
}

const deferral = { probe: 'frameworks/nuxt-real', reason: 'r', approved: 'user, 2026-10-07', owner: 'o', tracking: 't' };
const row = (name, exitCode, output = '') => ({ name: name === 'session-ledger' || name === 'probes' ? name : `tests/behavioral/${name}.mjs`, exitCode, seconds: 1, output });
const verdict = (...tasks) => ({ tasks: tasks.map((rows, i) => ({ task: `part ${i + 1}/${tasks.length}`, outcome: { kind: 'exited' }, rows })) });
const ledger = row('session-ledger', 0);

{
  const graded = gradeMatrix([verdict([row('git-local', 0), row('frameworks/nuxt-real', 1, 'BroadcastChannel is not a constructor'), ledger])], [deferral]);
  assert.equal(graded.exitCode, 0, graded.problems.join('\n'));
  assert.deepEqual(graded.applied.map((entry) => entry.probe), ['frameworks/nuxt-real']);
  assert.match(graded.applied[0].rows[0].output, /BroadcastChannel/, 'the deferred probe\'s output is kept');
  console.log('  ok  every red row deferred: green, with the deferral applied and the probe\'s output kept');
}
{
  const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 1), row('git-local', 1), ledger])], [deferral]);
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
  const once = gradeMatrix([verdict([row('frameworks/nuxt-real', 1)], [row('frameworks/nuxt-real', 0)])], [deferral]);
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
  const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 1), row('session-ledger', 1, 'leaked: x')])], [deferral]);
  assert.equal(graded.exitCode, 1, 'a leaked session is never deferrable');
  const notRun = gradeMatrix([verdict([row('probes', 2, 'NIMBUS_PROBE_TOKEN is not set')])], [deferral]);
  assert.equal(notRun.exitCode, 2, 'a task that was not graded leaves the matrix not graded');
  const noVerdict = gradeMatrix([verdict([row('frameworks/nuxt-real', 1)]), null], [deferral]);
  assert.equal(noVerdict.exitCode, 2);
  const lost = gradeMatrix([{ tasks: [{ task: 'part 1/1', outcome: { kind: 'failed' }, rows: null }] }], [deferral]);
  assert.equal(lost.exitCode, 2);
  console.log('  ok  the session ledger is never deferrable, and a task or verdict missing leaves the matrix not graded');
}
{
  const graded = gradeMatrix([verdict([row('frameworks/nuxt-real', 1), ledger]), verdict([row('auth/new/hosted-demo-try-terminal', 0)])], [deferral]);
  assert.equal(graded.exitCode, 0, 'rows from the suite and the hosted checks are graded together');
  const red = gradeMatrix([verdict([row('frameworks/nuxt-real', 1), ledger]), verdict([row('auth/new/hosted-demo-try-terminal', 1)])], [deferral]);
  assert.equal(red.exitCode, 1);
  console.log('  ok  the suite and the hosted checks are one matrix');
}
console.log('ci-deferred OK');
