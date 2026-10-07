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
// X-ranges, tilde, caret, hyphen, `||`; order-independence of the pick;
// npm's own semver and npm-package-arg (as npm 10.9.8 ships them) under the
// adapters, with Nimbus's two policies (the highest satisfying version, and an
// open range left to the dist-tag); and parity between the modules and the
// resolver preamble's bundle of them, which reads nothing a facet lacks.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { compareSemver, isSemverRange, parseSemver, pickPackumentVersion, resolveVersion, satisfiesRange } from '../../packages/core/src/_shared/npm-semver.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { NPM_RESOLVE_NODE_IMPORTS, NPM_RESOLVE_SRC } from '../../packages/worker/src/npm/resolve-libs.generated.ts';
import { parseRegistryRequest, splitPackageSpec } from '../../packages/core/src/_shared/npm-spec.ts';
import { FACET_GLOBALS, freeNames } from '../../packages/worker/scripts/free-names.mjs';
import { importResolvePreamble } from './lib/npm-resolve-preamble-module.mjs';

const embedded = await importResolvePreamble(['PARSE_SEMVER', 'COMPARE_SEMVER', 'SATISFIES_RANGE', 'RESOLVE_VERSION', 'IS_SEMVER_RANGE', 'PICK_VERSION', 'parseRegistryRequest']);

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
    assert.equal(embedded.IS_SEMVER_RANGE(range), isSemverRange(range), `IS_SEMVER_RANGE parity: ${range}`);
    for (const v of corpus) {
      assert.equal(embedded.SATISFIES_RANGE(v, range), satisfiesRange(v, range), `SATISFIES_RANGE parity: ${v} ${range}`);
    }
  }
  for (const v of corpus) assert.deepEqual(embedded.PARSE_SEMVER(v), parseSemver(v), `PARSE_SEMVER parity: ${v}`);
  assert.equal(
    embedded.COMPARE_SEMVER(parseSemver('1.0.0-beta.15'), parseSemver('1.0.0-alpha.1')),
    compareSemver(parseSemver('1.0.0-beta.15'), parseSemver('1.0.0-alpha.1')),
  );
  // The preamble carries the build's bundle, after the imports it reads.
  assert.ok(NPM_RESOLVE_PREAMBLE.includes(NPM_RESOLVE_NODE_IMPORTS) && NPM_RESOLVE_PREAMBLE.includes(NPM_RESOLVE_SRC), 'the preamble splices the bundle and its imports');
  assert.ok(NPM_RESOLVE_PREAMBLE.indexOf(NPM_RESOLVE_NODE_IMPORTS) < NPM_RESOLVE_PREAMBLE.indexOf(NPM_RESOLVE_SRC));
  // The free-name guard: the bundle reads only its imports and a facet's globals.
  const imported = new Set([...NPM_RESOLVE_NODE_IMPORTS.matchAll(/import \* as (\w+) from/g)].map((m) => m[1]));
  const stray = [...freeNames(NPM_RESOLVE_SRC)].filter((name) => !FACET_GLOBALS.has(name) && !imported.has(name) && name !== '__nimbusNpmResolve');
  assert.deepEqual(stray, [], 'the bundle reads nothing a facet lacks');
  assert.deepEqual([...freeNames('var g = (() => { const a = 1; function f(b) { return a + b + c + Math.max(d.e, f.g); } return f; })(); try {} catch ({ h }) { h + i; } label: for (const j of k) { break label; }')].sort(), ['Math', 'c', 'd', 'i', 'k'], 'the guard finds free names, and only those');
  console.log('  parity: the preamble bundles core _shared/npm-semver.ts, reading only its imports and a facet\'s globals');
}

// ── the preamble's spec parsing is the supervisor's ─────────────────────────
{
  for (const [name, range] of [['a', '^1.0.0'], ['alias', 'npm:@scope/pkg@^1.2.0'], ['alias', 'npm:lodash'], ['alias', 'npm:@scope/pkg'], ['x', ''], ['g', 'github:u/r'], ['bad', 'npm:']]) {
    assert.deepEqual(embedded.parseRegistryRequest(name, range), parseRegistryRequest(name, range), `${name} ${range}`);
  }
  console.log('  parity: embedded parseRegistryRequest matches npm-spec.ts');
}

// ── the preamble's version pick is the module's ─────────────────────────────
{
  const versions = { '1.0.0': {}, '1.1.0': {}, '2.0.0-beta.1': {}, '2.0.0': {} };
  const tags = { latest: '1.1.0', next: '2.0.0-beta.1' };
  for (const range of [undefined, '', 'latest', '^1.0.0', '^2.0.0', 'next', 'nosuchtag', '^9', 'github:a/b', '2.0.0-beta.1', 'constructor']) {
    assert.equal(embedded.PICK_VERSION(versions, tags, range), pickPackumentVersion(versions, tags, range), String(range));
  }
  console.log('  parity: embedded PICK_VERSION matches pickPackumentVersion');
}

// ── npm's own libraries under the adapters ─────────────────────────────────
// The semver and npm-package-arg npm 10.9.8 runs, from its own install:
// every answer is theirs but where Nimbus's policy differs, which is pinned.
{
  const npmRoot = join(dirname(realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim())), '..');
  const npmRequire = createRequire(join(npmRoot, 'package.json'));
  const npmSemver = npmRequire('semver');
  const npa = npmRequire('npm-package-arg');
  const loose = { loose: true };
  const corpus = ['0.0.1', '1.0.0-alpha.1', '1.0.0-beta.15', '1.0.0', '1.2.3', '=1.2.4', 'v1.2.5', '01.2.6', '1.2.7beta', ' 1.3.0 ', '2.0.0-rc.1', '2.0.0', '1.2', 'latest', 'garbage'];
  const ranges = ['1', '1.x', '^1.0.0', '~1.2.3', '>=1.2.3 <2', '1.0.0 - 1.5.0', '1 || 2', '^2.0.0-rc.0', '>1.2.3-beta', '=1.2.4', 'v1.2.5', '1.2.7beta', '~>1.2', '*', 'x', '', 'latest', 'next', 'github:u/r', 'file:../x', '^9'];
  for (const v of corpus) {
    const theirs = npmSemver.parse(v, loose);
    assert.deepEqual(parseSemver(v), theirs && [theirs.major, theirs.minor, theirs.patch, [...theirs.prerelease]], `parse ${JSON.stringify(v)}`);
    for (const range of ranges) {
      const open = ['', '*', 'x', 'X', 'latest'].includes(range.trim());
      assert.equal(satisfiesRange(v, range), npmSemver.satisfies(v, open ? '*' : range, loose), `satisfies ${JSON.stringify(v)} ${JSON.stringify(range)}`);
    }
  }
  for (const range of ranges) {
    const open = ['', '*', 'x', 'X', 'latest'].includes(range.trim());
    assert.equal(isSemverRange(range), open || npmSemver.validRange(range, loose) !== null, `validRange ${JSON.stringify(range)}`);
    // Policy: the highest satisfying, and an open range left to the dist-tag.
    assert.equal(resolveVersion(corpus, range), open ? null : npmSemver.maxSatisfying(corpus, range, loose), `maxSatisfying ${JSON.stringify(range)}`);
  }
  const sorted = corpus.filter((v) => npmSemver.valid(v, loose)).sort((a, b) => npmSemver.compare(a, b, loose));
  for (let i = 1; i < sorted.length; i++) assert.ok(compareSemver(parseSemver(sorted[i - 1]), parseSemver(sorted[i])) <= 0, `order ${sorted[i - 1]} ${sorted[i]}`);
  // npm-pick-manifest prefers `latest` when it satisfies; Nimbus takes the highest (deliberate).
  assert.equal(pickPackumentVersion({ '1.0.0': {}, '1.5.0': {} }, { latest: '1.0.0' }, '^1.0.0'), '1.5.0', 'the highest satisfying version, not latest');
  for (const [name, range] of [['a', '^1.0.0'], ['alias', 'npm:@scope/pkg@^1.2.0'], ['alias', 'npm:lodash'], ['x', 'latest'], ['g', 'github:u/r'], ['f', 'file:../d']]) {
    const theirs = npa.resolve(name, range);
    const ours = parseRegistryRequest(name, range);
    assert.equal(ours.alias, theirs.type === 'alias', `alias ${name}@${range}`);
    if (ours.alias) assert.deepEqual([ours.registryName, ours.range], [theirs.subSpec.name, theirs.subSpec.rawSpec], `alias target ${name}@${range}`);
  }
  // A command-line spec splits where npa's name ends; a spec naming no package is its own name.
  for (const spec of ['vite', 'vite@', 'vite@latest', '@s/x', '@s/x@^1', 'x@npm:y@1', '@s/x@npm:@t/y', 'u/r', './dir', 'X Y']) {
    const name = (() => { try { return npa(spec).name; } catch { return undefined; } })();
    const ranged = Boolean(name) && spec.startsWith(`${name}@`);
    assert.deepEqual(splitPackageSpec(spec), ranged ? { name, range: spec.slice(name.length + 1) } : { name: spec, range: null }, `split ${spec}`);
  }
  console.log('  npm\'s semver and npm-package-arg under the adapters, Nimbus\'s pick policy pinned');
}

console.log('npm-semver: ok');
