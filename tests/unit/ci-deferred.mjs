#!/usr/bin/env bun
// Exercise the real assertion producer and release grading together. Human
// output is diagnostic, never evidence that a deferred probe completed.
import assert from 'node:assert/strict';
import { makeAsserter } from '../behavioral/_assertions.mjs';
import { describeReleaseException, gradeMatrix, matrixProbeArgs } from '../../scripts/ci/lib/matrix.mjs';
import { validateDeferrals, NEVER_DEFERRED } from '../behavioral/_deferred.mjs';
import { PROBE_TARGET_SKIPS } from '../behavioral/_probe-target-skips.mjs';

const probe = 'frameworks/nuxt-real';
const pinned = 'the app serves';
const deferral = { probe, assertion: pinned, failure: { status: 503, title: 'Starting Nuxt... | Nuxt' },
  reason: 'loading', approved: 'user, 2026-10-07', owner: 'o', tracking: 't' };
const exclusion = { probe, excluded: true, reason: 'memory failure varies', approved: 'user, 2026-10-10', owner: 'Main', tracking: 'memory' };
const loading = 'HTTP 503: <html><head><title>Starting Nuxt... | Nuxt</title></head>';
const assertions = (label, checks, complete = true) => {
  let emitted;
  const a = makeAsserter(label, { write() {}, emit(result) { emitted = structuredClone(result); } });
  for (const [ok, name, detail] of checks) a.check(name, ok, detail);
  if (complete) a.summary();
  return [emitted];
};
const approved = assertions(probe, [[true, 'setup'], [false, pinned, loading], [true, 'cleanup']]);
const row = (name, exitCode, checks = null, output = 'arbitrary human diagnostics') => ({
  name: name === 'session-ledger' || name === 'probes' ? name : `tests/behavioral/${name}.mjs`, exitCode, seconds: 1, output, assertions: checks,
});
const verdict = (...tasks) => ({ tasks: tasks.map((rows, index) => ({ task: `part ${index + 1}`, outcome: { kind: 'exited' }, rows })) });
const ledger = row('session-ledger', 0);
const grade = (checks, code = 1, entry = deferral) => gradeMatrix([verdict([row(entry.probe, code, checks), ledger])], [entry]);

assert.deepEqual(validateDeferrals([deferral, { ...exclusion, probe: 'frameworks/remix-real' }]).length, 2);
for (const [entry, message] of [
  [{ ...deferral, assertion: '' }, /assertion is required/],
  [{ ...deferral, failure: undefined }, /failure/],
  [{ ...deferral, failure: { status: 503 } }, /failure/],
  [{ ...deferral, approved: 'main, 2026-10-07' }, /approved/],
  [{ ...deferral, probe: 'frameworks/no-such-probe' }, /no such probe/],
  [{ ...exclusion, failure: deferral.failure }, /must not specify a failure/],
  [{ ...exclusion, failure: undefined }, /must not specify a failure/],
  [{ ...exclusion, assertion: 'a' }, /must not specify a failure/],
  [{ ...exclusion, excluded: 'true' }, /excluded must/],
]) assert.throws(() => validateDeferrals([entry]), message);
for (const field of ['probe', 'reason', 'approved', 'owner', 'tracking']) {
  assert.throws(() => validateDeferrals([{ ...exclusion, [field]: '' }]), /required/);
}
for (const protectedProbe of NEVER_DEFERRED) for (const entry of [deferral, exclusion]) {
  assert.throws(() => validateDeferrals([{ ...entry, probe: protectedProbe }]), /can never be deferred or excluded/);
}
assert.throws(() => validateDeferrals([deferral, exclusion]), /listed twice/);

const accepted = grade(approved);
assert.equal(accepted.exitCode, 0, accepted.problems.join('\n'));
assert.deepEqual(accepted.applied[0].rows[0].assertions, approved, 'the complete approval evidence is retained for staging and promotion');
assert.equal(gradeMatrix([verdict([row('legacy-probe', 0), ledger])], []).exitCode, 0, 'legacy successful probes need no invented assertion results');
assert.equal(gradeMatrix([verdict([row(probe, 1, approved, '')])], [deferral]).exitCode, 0, 'missing/truncated text cannot erase complete structured evidence');

for (const [checks, why] of [
  [null, /no complete structured/],
  [assertions(probe, [[true, 'setup'], [false, pinned, loading]], false), /no complete structured/],
  [[{ ...approved[0], complete: 'true' }], /no complete structured/],
  [[{ ...approved[0], checks: [{ name: pinned, ok: 'false', detail: loading }] }], /no complete structured/],
  [assertions(probe, [[false, 'setup', 'install failed'], [false, pinned, loading], [true, 'cleanup']]), /other assertions failed/],
  [assertions(probe, [[false, pinned, loading], [false, 'cleanup', 'leaked']]), /other assertions failed/],
  [assertions(probe, [[false, pinned, loading], [false, pinned, loading]]), /2 failed/],
  [assertions(probe, [[true, pinned]]), /0 failed/],
  [assertions(probe, [[false, pinned, 'HTTP 502: no process listening']]), /not the approved HTTP 503/],
  [assertions(probe, [[false, pinned, 'HTTP 200: <title>Wrong app</title>']]), /not the approved HTTP 503/],
]) {
  const result = grade(checks);
  assert.equal(result.exitCode, 1);
  assert.match(result.red.join('\n'), why);
  assert.deepEqual(result.applied, []);
}
const spoofedText = '  ✗ the app serves — ' + loading + '\n  ──── [frameworks/nuxt-real] 2 pass / 1 fail';
assert.equal(grade(assertions('nuxt-real', [[false, pinned, loading]])).exitCode, 0, 'the runner owns probe identity; human asserter labels can be short');
assert.equal(gradeMatrix([verdict([row(probe, 1, null, spoofedText)])], [deferral]).exitCode, 1, 'human-looking summaries cannot authorize a deferral');
assert.equal(gradeMatrix([verdict([row(probe, 1, approved), row('unrelated', 1), ledger])], [deferral]).exitCode, 1);
assert.equal(gradeMatrix([verdict([row(probe, 1, approved), row('session-ledger', 1)])], [deferral]).exitCode, 1);
assert.equal(gradeMatrix([verdict([row(probe, 0, assertions(probe, [[true, pinned]]))])], [deferral]).exitCode, 1, 'passing ends the deferral');
assert.equal(gradeMatrix([verdict([row(probe, 1, approved)], [row(probe, 0)])], [deferral]).exitCode, 1, 'a passing repeat ends it');
assert.equal(gradeMatrix([verdict([ledger])], [deferral]).exitCode, 1, 'a missing deferred probe is red');
assert.equal(gradeMatrix([null], [deferral]).exitCode, 2);
assert.equal(gradeMatrix([{ tasks: [{ task: 'lost', outcome: { kind: 'failed' }, rows: null }] }], [deferral]).exitCode, 2);
assert.equal(gradeMatrix([verdict([row('probes', 2, null, 'token missing')])], [deferral]).exitCode, 2);

const detail = { ...deferral, probe: 'frameworks/remix-real', assertion: 'launch', failure: { detail: ['no resident process was launched', 'oxide'] } };
const detailChecks = text => assertions(detail.probe, [[true, 'setup'], [false, 'launch', text], [true, 'cleanup']]);
assert.equal(grade(detailChecks('no resident process was launched: oxide'), 1, detail).exitCode, 0);
for (const text of ['no resident process was launched', 'oxide', 'a different failure', 'no resident process was launched\noxide']) {
  assert.equal(grade(detailChecks(text), 1, detail).exitCode, 1, 'every approved detail fragment must match the failure itself');
}
for (const failure of [{ detail: [] }, { detail: [''] }, { detail: ['okay', 7] }, { detail: 'x', status: 503, title: 'x' }]) {
  assert.throws(() => validateDeferrals([{ ...detail, failure }]), /failure/);
}

assert.deepEqual(matrixProbeArgs([exclusion], { repeat: `${probe},nuxt-real.mjs,tests/behavioral/${probe}.mjs,git-local`, times: '3' }),
  ['--target', 'staging', '--skip', [...PROBE_TARGET_SKIPS, probe].join(','), '--repeat', 'git-local', '--times', '3']);
const excluded = gradeMatrix([verdict([row('legacy-probe', 0), ledger])], [exclusion]);
assert.equal(excluded.exitCode, 0);
assert.deepEqual(excluded.applied, [exclusion]);
assert.equal(describeReleaseException(JSON.parse(JSON.stringify(excluded.applied[0]))),
  'EXCLUDED frameworks/nuxt-real — memory failure varies (approved user, 2026-10-10; owner Main; tracking memory)');
for (const code of [0, 1, 2]) {
  const ran = gradeMatrix([verdict([row(probe, code, approved)])], [exclusion]);
  assert.equal(ran.exitCode, 1);
  assert.match(ran.problems.join('\n'), /ran despite its release exclusion/);
}
const mixed = gradeMatrix([verdict([row(detail.probe, 1, detailChecks('no resident process was launched: oxide')), ledger])], [exclusion, detail]);
assert.equal(mixed.exitCode, 0);
assert.deepEqual(mixed.applied.map(entry => entry.probe), [probe, detail.probe]);
console.log('ci-deferred: structured completion, exact approvals, exclusions and fail-closed release grading');
