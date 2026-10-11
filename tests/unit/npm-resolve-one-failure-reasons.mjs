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
import './lib/resolve-facet-scope.mjs';


const spec = (overrides = {}) => ({
  name: 'which',
  range: '^2.0.0',
  cachedEntries: [],
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

// ── What cannot run here is reported, not decided ───────────────────────
//
// The task cannot tell whether a package is optional (only the complete
// graph can), so it decides nothing by the edge that asked: a platform
// refusal (npm's EBADPLATFORM) is a refusal, which the plan skips where the
// placement is optional and fails where it is required; a native executable
// resolves like any package, carrying why it cannot run here, which the plan
// skips where optional and installs, with an advisory, where required.
{
  const platformBound = await resolveOnePackumentInFacet(
    spec({ name: '@esbuild/linux-x64', range: '0.21.5' }),
    envReturning({
      json: packument({
        '0.21.5': {
          name: '@esbuild/linux-x64', version: '0.21.5',
          os: ['linux'], cpu: ['x64'],
          dist: { tarball: 'https://registry.invalid/esb-0.21.5.tgz', integrity: 'sha512-AAAA' },
        },
      }, { latest: '0.21.5' }),
      source: 'network',
    }),
  );
  assert.equal(platformBound.pkg, null);
  assert.equal(platformBound.error?.type, 'w6-reject', 'a platform-bound package is a refusal');
  assert.match(platformBound.error.reason, /os=\[linux\]/);

  const nativeBin = await resolveOnePackumentInFacet(
    spec({ name: 'which', range: '2.0.2' }),
    envReturning({
      json: packument({
        '2.0.2': {
          name: 'which', version: '2.0.2', bin: { which: 'bin/which.exe' },
          dist: { tarball: 'https://registry.invalid/which-2.0.2.tgz', integrity: 'sha512-AAAA' },
        },
      }, { latest: '2.0.2' }),
      source: 'network',
    }),
  );
  assert.equal(nativeBin.pkg?.version, '2.0.2', 'a native executable resolves');
  assert.equal(nativeBin.error, undefined, 'with no failure');
  assert.match(nativeBin.nativeExecutable?.reason ?? '', /which\.exe/, 'and says why it cannot run here');
  console.log('  platform-bound → refusal; native executable → resolved, with its reason');
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
