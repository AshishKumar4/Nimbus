#!/usr/bin/env bun
// npm-semver — the one version-pick implementation, and its embedded copy.
//
// The resolver used to ignore prerelease identifiers: every `1.0.0-*` tied,
// so the first version the packument listed won. Measured against the live
// registry lists on 2026-09-14: `json-server@1.0.0-beta.15` resolved to
// `1.0.0-alpha.1` on the cache path (the second install in a session
// silently installed a different major's dependency tree), and
// `@polka/url ^1.0.0-next.24` resolved to `1.0.0-next.0`, which does not
// satisfy the range. X-ranges were wrong too: `1` and `1.x` picked `1.0.0`
// rather than the highest 1.y.z.
//
// This pins: prerelease ordering and admission per semver §11 / node-semver;
// X-ranges, tilde, caret, hyphen, `||`; order-independence of the pick; and
// parity between npm/semver.ts and the copy embedded in the resolver
// preamble by `fn.toString()`.

import assert from 'node:assert/strict';
import { compareSemver, parseSemver, resolveVersion, satisfiesRange } from '../../packages/worker/src/npm/semver.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';

const embedded = new Function(
  `${NPM_RESOLVE_PREAMBLE}\nreturn { PARSE_SEMVER, COMPARE_SEMVER, SATISFIES_RANGE, RESOLVE_VERSION };`,
)();

// ── parse + compare: prerelease identifiers are part of the order ───────────
{
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3, []]);
  assert.deepEqual(parseSemver('1.0.0-beta.15+build.7'), [1, 0, 0, ['beta', 15]]);
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('latest'), null);
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(compareSemver(parseSemver(order[i - 1]), parseSemver(order[i])) < 0, `${order[i - 1]} < ${order[i]}`);
  }
  assert.equal(compareSemver(parseSemver('1.0.0-beta.15'), parseSemver('1.0.0-alpha.1')) > 0, true);
  console.log('  parse/compare: semver §11 prerelease order');
}

// ── the measured failures ───────────────────────────────────────────────────
{
  // Registry order is publish order: alpha.1 is listed before beta.15.
  const jsonServer = ['0.17.4', '1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0-beta.0', '1.0.0-beta.3', '1.0.0-beta.15', '1.0.0-beta.9'];
  assert.equal(resolveVersion(jsonServer, '1.0.0-beta.15'), '1.0.0-beta.15', 'an exact prerelease pin resolves to itself');
  assert.equal(resolveVersion(jsonServer, '^1.0.0-beta.15'), '1.0.0-beta.15', 'a caret on a prerelease admits that prerelease line');
  assert.equal(resolveVersion([...jsonServer].reverse(), '1.0.0-beta.15'), '1.0.0-beta.15', 'the pick does not depend on list order');
  const polka = ['1.0.0-next.0', '1.0.0-next.11', '1.0.0-next.24', '1.0.0-next.29', '1.0.0-next.3'];
  assert.equal(resolveVersion(polka, '^1.0.0-next.24'), '1.0.0-next.29', 'the highest satisfying prerelease wins');
  assert.equal(satisfiesRange('1.0.0-next.0', '^1.0.0-next.24'), false, 'next.0 does not satisfy ^next.24');
  console.log('  measured failures: json-server pin and @polka/url caret');
}

// ── range grammar ───────────────────────────────────────────────────────────
{
  const vs = ['0.9.0', '1.0.0', '1.0.2', '1.2.0', '1.2.5', '1.5.3', '2.0.0', '2.1.0-rc.1', '2.1.0'];
  const cases = [
    ['1', '1.5.3'], ['1.x', '1.5.3'], ['1.2.x', '1.2.5'], ['1.2', '1.2.5'],
    ['^1.0.0', '1.5.3'], ['~1.0.0', '1.0.2'], ['~1.2', '1.2.5'], ['^0.9.0', '0.9.0'],
    ['>=1.0.0 <2.0.0', '1.5.3'], ['>1.0.0', '2.1.0'], ['<=1.2.0', '1.2.0'], ['1.0.0 - 1.2.0', '1.2.0'],
    ['1 || 2', '2.1.0'], ['2.1.0-rc.1', '2.1.0-rc.1'], ['^2.1.0-rc.0', '2.1.0'],
    ['>=2.1.0-rc.0 <2.1.0', '2.1.0-rc.1'], ['^2.0.0', '2.1.0'], ['=1.0.2', '1.0.2'],
    ['*', null], ['x', null], ['latest', null], ['', null], ['^3.0.0', null],
  ];
  for (const [range, expected] of cases) {
    assert.equal(resolveVersion(vs, range), expected, `resolveVersion(${JSON.stringify(range)})`);
  }
  // A prerelease is admitted only by a comparator on its own triple.
  assert.equal(satisfiesRange('2.1.0-rc.1', '^2.0.0'), false);
  assert.equal(satisfiesRange('2.1.0-rc.1', '>=2.0.0-rc.0'), false, 'a prerelease comparator on another triple does not admit it');
  assert.equal(satisfiesRange('2.1.0-rc.1', '>=2.1.0-rc.0'), true);
  assert.equal(satisfiesRange('2.1.0', '>=2.1.0-rc.0'), true, 'the release satisfies a prerelease lower bound');
  assert.equal(satisfiesRange('not-a-version', '*'), false);
  console.log('  range grammar: X-ranges, tilde, caret, comparators, hyphen, ||');
}

// ── parity: the preamble's copy answers exactly as the module ───────────────
{
  const corpus = ['0.0.1', '0.9.0', '1.0.0-alpha.1', '1.0.0-beta.15', '1.0.0-next.0', '1.0.0-next.29', '1.0.0', '1.0.2', '1.2.5', '1.5.3', '2.0.0', '2.1.0-rc.1', '2.1.0', 'garbage'];
  const ranges = ['1', '1.x', '^1.0.0', '~1.0.0', '1.0.0-beta.15', '^1.0.0-beta.15', '^1.0.0-next.24', '>=1.0.0 <2.0.0', '1.0.0 - 1.5.0', '1 || 2', '^2.1.0-rc.0', '*', 'latest', '', '^3'];
  for (const range of ranges) {
    assert.equal(embedded.RESOLVE_VERSION(corpus, range), resolveVersion(corpus, range), `RESOLVE_VERSION parity: ${range}`);
    for (const v of corpus) {
      assert.equal(embedded.SATISFIES_RANGE(v, range), satisfiesRange(v, range), `SATISFIES_RANGE parity: ${v} ${range}`);
    }
  }
  for (const v of corpus) assert.deepEqual(embedded.PARSE_SEMVER(v), parseSemver(v), `PARSE_SEMVER parity: ${v}`);
  assert.equal(
    embedded.COMPARE_SEMVER(parseSemver('1.0.0-beta.15'), parseSemver('1.0.0-alpha.1')),
    compareSemver(parseSemver('1.0.0-beta.15'), parseSemver('1.0.0-alpha.1')),
  );
  // Byte-equivalence: the preamble carries the module's own source.
  assert.ok(NPM_RESOLVE_PREAMBLE.includes(resolveVersion.toString()), 'the preamble embeds resolveVersion verbatim');
  assert.ok(NPM_RESOLVE_PREAMBLE.includes(satisfiesRange.toString()), 'the preamble embeds satisfiesRange verbatim');
  console.log('  parity: embedded preamble functions match npm/semver.ts');
}

console.log('npm-semver: ok');
