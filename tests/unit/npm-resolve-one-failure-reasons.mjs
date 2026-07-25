#!/usr/bin/env bun
// npm-resolve-one-failure-reasons — the per-package resolver task must
// distinguish "policy skipped this" from "this failed to resolve".
//
// Both used to return `pkg: null` with nothing else set, so the
// supervisor's `if (!pkg) continue` erased a required dependency AND its
// whole subtree from the tree it was building — and the install still
// reported success. Every failure path now names itself, and the
// supervisor turns that into a failed install
// (tests/unit/npm-install-partial-honesty.mjs).

import assert from 'node:assert/strict';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';

const PREAMBLE_SYMBOLS = [
  'SHOULD_SKIP_PACKAGE', 'SHOULD_SWAP', 'SHOULD_REJECT_FAIL', 'SHOULD_WARN_SKIP_TRANSITIVE',
  'NATIVE_EXECUTABLE_REJECT', 'IS_OPTIONAL_NATIVE_BINDING', 'PARSE_SEMVER', 'COMPARE_SEMVER',
  'SATISFIES_RANGE', 'RESOLVE_VERSION', 'STAGED_ARTIFACT', 'STAGED_ARTIFACT_APPLY',
];
Object.assign(
  globalThis,
  new Function(`${NPM_RESOLVE_PREAMBLE}\nreturn { ${PREAMBLE_SYMBOLS.join(', ')} };`)(),
);
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);

const spec = (overrides = {}) => ({
  name: 'which',
  range: '^2.0.0',
  cachedEntries: [],
  topLevel: false,
  isOptional: false,
  frameworkAware: false,
  fetchTimeoutMs: 1_000,
  retries: 0,
  ...overrides,
});

const envReturning = (result) => ({
  SUPERVISOR: {
    async getPackument() { return { events: [], ...result }; },
  },
});

const packument = (versions, distTags = {}) => JSON.stringify({
  name: 'which',
  'dist-tags': distTags,
  versions,
});

// ── Registry 4xx: the package does not exist ─────────────────────────────
{
  const res = await resolveOnePackumentInFacet(
    spec(),
    envReturning({ json: null, source: 'network', status: 404 }),
  );
  assert.equal(res.pkg, null);
  assert.equal(res.error?.type, 'unresolved', 'a 404 is a resolution failure, not a skip');
  assert.match(res.error.reason, /404/);
  assert.match(res.error.reason, /which/);
  console.log('  404 → unresolved');
}

// ── Fetch exhausted after retries ────────────────────────────────────────
{
  const res = await resolveOnePackumentInFacet(
    spec(),
    envReturning({ json: null, source: 'network', failure: 'connection reset' }),
  );
  assert.equal(res.error?.type, 'unresolved');
  assert.match(res.error.reason, /connection reset/);
  console.log('  exhausted fetch → unresolved');
}

// ── Malformed packument ──────────────────────────────────────────────────
{
  const res = await resolveOnePackumentInFacet(
    spec(),
    envReturning({ json: '{ not json', source: 'network' }),
  );
  assert.equal(res.error?.type, 'unresolved');
  assert.match(res.error.reason, /malformed packument/);
  console.log('  malformed packument → unresolved');
}

// ── Packument with no versions map ───────────────────────────────────────
{
  const res = await resolveOnePackumentInFacet(
    spec(),
    envReturning({ json: JSON.stringify({ name: 'which' }), source: 'network' }),
  );
  assert.equal(res.error?.type, 'unresolved');
  assert.match(res.error.reason, /no versions/);
  console.log('  versionless packument → unresolved');
}

// ── No published version satisfies the range ─────────────────────────────
{
  const res = await resolveOnePackumentInFacet(
    spec(),
    envReturning({ json: packument({}), source: 'network' }),
  );
  assert.equal(res.error?.type, 'unresolved');
  assert.match(res.error.reason, /no published version/);
  console.log('  unsatisfiable range → unresolved');
}

// ── A deliberate policy skip is NOT a failure ────────────────────────────
//
// `typescript` is in SKIP_PACKAGES: at transitive depth the resolver drops
// it on purpose. That must stay distinguishable from the failures above,
// or every install of a project with build-only deps would go red.
{
  const res = await resolveOnePackumentInFacet(
    spec({ name: 'typescript', range: '^5.0.0' }),
    envReturning({ json: null, source: 'network', status: 404 }),
  );
  assert.equal(res.pkg, null);
  assert.equal(res.error, undefined, 'a policy skip carries no failure');
  assert.equal(res.packumentSource, 'skipped');
  console.log('  policy skip → skipped, no error');
}

// ── A resolvable package still resolves ──────────────────────────────────
{
  const res = await resolveOnePackumentInFacet(
    spec(),
    envReturning({
      json: packument({
        '2.0.2': {
          name: 'which',
          version: '2.0.2',
          dist: { tarball: 'https://registry.invalid/which-2.0.2.tgz', integrity: 'sha512-AAAA' },
          dependencies: { isexe: '^2.0.0' },
        },
      }, { latest: '2.0.2' }),
      source: 'network',
    }),
  );
  assert.equal(res.error, undefined);
  assert.equal(res.pkg?.version, '2.0.2');
  assert.deepEqual(res.deps, { isexe: '^2.0.0' });
  console.log('  resolvable package → resolved');
}

console.log('npm-resolve-one-failure-reasons: all assertions passed');
