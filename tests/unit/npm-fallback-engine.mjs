#!/usr/bin/env bun
/**
 * The shell's fallback npm (lifo commands/system/npm.ts, used when no
 * installer is wired) reads a spec and picks its version by the rules the
 * worker's resolver uses (core _shared/npm-spec.ts, npm-semver.ts), and
 * checks a tarball's integrity as the install facet does
 * (_shared/tarball-integrity.ts). Driven through `npm info` and
 * `npm install` against a mocked registry:
 *   - each spec installs what the worker's pick answers, and what npm's own
 *     npm-pick-manifest answers, where the two agree (see KNOWN_DIVERGENCE);
 *   - an `npm:` alias installs the aliased package under the alias's name,
 *     and saves as npm does (`"mine": "npm:real@^1.1.0"`), so a reinstall
 *     from package.json installs the aliased package again;
 *   - a tarball whose bytes do not match its integrity is refused and
 *     nothing is installed; a multi-hash integrity is checked by its
 *     strongest entry.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTar } from '../../packages/core/src/substrate/lifo/utils/archive.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { pickPackumentVersion } from '../../packages/core/src/_shared/npm-semver.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const VERSIONS = ['1.0.0', '1.1.0', '1.2.0-beta.1', '2.0.0-beta.1', '2.0.0', '3.0.0-rc.1'];
const DIST_TAGS = { latest: '1.1.0', next: '2.0.0-beta.1', experimental: '3.0.0-rc.1' };
const SPECS = ['', 'latest', '*', 'x', '^1.0.0', '~1.0.0', '1.x', '^2.0.0', '>=1 <2', '<2', '1.0.0 || 2.0.0',
  '1.0.0 - 1.1.0', '2.0.0-beta.1', '^1.2.0-beta.0', '^3.0.0-rc.0', 'next', 'experimental', 'nosuchtag', '^4.0.0', '1.2'];
// npm-pick-manifest takes the `latest` tag when it satisfies a range; the
// worker's resolver (and so the fallback) takes the highest that does.
const KNOWN_DIVERGENCE = new Set(['>=1.0.0']);

const tarball = (name, version) => gzipSync(createTar([{
  path: 'package/package.json', type: 'file', mode: 0o644, mtime: 0,
  data: new TextEncoder().encode(JSON.stringify({ name, version })),
}]));
const sri = async (algo, bytes) => `${algo.toLowerCase().replace('-', '')}-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest(algo, bytes))))}`;
const TARBALLS = new Map();
const packument = async (name, integrity = async (bytes) => sri('SHA-512', bytes)) => {
  const versions = {};
  for (const version of VERSIONS) {
    const bytes = tarball(name, version);
    const url = `https://registry.test/${name}-${version}.tgz`;
    TARBALLS.set(url, bytes);
    versions[version] = { name, version, dist: { tarball: url, integrity: await integrity(bytes) } };
  }
  return { name, 'dist-tags': DIST_TAGS, versions };
};
const PACKUMENTS = {
  pkg: await packument('pkg'),
  real: await packument('real'),
  corrupt: await packument('corrupt', async () => `sha512-${btoa('x'.repeat(64))}`),
  multihash: await packument('multihash', async (bytes) => `sha1-${btoa('wrong sha1 digest!!!')} ${await sri('SHA-512', bytes)}`),
};

// npm's own pick, from the npm that ships with node.
const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const pickManifest = join(npmRoot, 'npm', 'node_modules', 'npm-pick-manifest');
assert.ok(existsSync(pickManifest), `npm-pick-manifest at ${pickManifest}`);
const npmPicks = JSON.parse(execFileSync('node', ['-e', `
  const pick = require(${JSON.stringify(pickManifest)});
  const packument = ${JSON.stringify(PACKUMENTS.pkg)};
  const out = {};
  for (const spec of ${JSON.stringify([...SPECS, ...KNOWN_DIVERGENCE])}) {
    try { out[spec] = pick(packument, spec).version; } catch (e) { out[spec] = e.code; }
  }
  process.stdout.write(JSON.stringify(out));
`], { encoding: 'utf8' }));

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const fs = ws.vfs.as(CRED_KERNEL);
ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
const originalFetch = globalThis.fetch;
// The registry's routes: a packument, and `/<name>/<version-or-tag>`.
globalThis.fetch = async (url) => {
  const text = String(url);
  if (TARBALLS.has(text)) return new Response(TARBALLS.get(text));
  const [name, which] = text.slice('https://registry.npmjs.org/'.length).split('/').map(decodeURIComponent);
  const doc = PACKUMENTS[name];
  if (!doc) return new Response('not found', { status: 404 });
  if (which === undefined) return Response.json(doc);
  const version = Object.hasOwn(doc.versions, which) ? which : doc['dist-tags'][which];
  return version ? Response.json(doc.versions[version]) : new Response('not found', { status: 404 });
};

try {
  for (const spec of SPECS) {
    const worker = pickPackumentVersion(PACKUMENTS.pkg.versions, DIST_TAGS, spec) ?? 'ETARGET';
    assert.equal(worker, npmPicks[spec], `the worker's pick for '${spec}' is npm's`);
    const info = await ws.exec(`npm info 'pkg@${spec}'`);
    const shown = info.exitCode === 0 ? /pkg@(\S+)/.exec(info.stdout)?.[1] : 'ETARGET';
    assert.equal(shown, worker, `the fallback installs '${spec}' as the worker's resolver does: ${info.stderr}`);
  }
  for (const spec of KNOWN_DIVERGENCE) {
    assert.notEqual(pickPackumentVersion(PACKUMENTS.pkg.versions, DIST_TAGS, spec), npmPicks[spec], `'${spec}' still diverges from npm`);
  }

  assert.equal((await ws.exec(`printf '%s' '{"name":"app","version":"1.0.0"}' > package.json`)).exitCode, 0);
  const alias = await ws.exec(`npm install 'mine@npm:real@^1.0.0'`);
  assert.equal(alias.exitCode, 0, alias.stderr);
  const devAlias = await ws.exec(`npm install --save-dev 'tool@npm:real@1'`);
  assert.equal(devAlias.exitCode, 0, devAlias.stderr);
  const installedAs = () => ['mine', 'tool'].map((name) => JSON.parse(fs.readFileString(`/home/user/node_modules/${name}/package.json`)));
  assert.deepEqual(installedAs(), [{ name: 'real', version: '1.1.0' }, { name: 'real', version: '1.1.0' }],
    'an npm: alias installs the aliased package under the alias');
  const saved = JSON.parse(fs.readFileString('/home/user/package.json'));
  assert.deepEqual([saved.dependencies, saved.devDependencies], [{ mine: 'npm:real@^1.1.0' }, { tool: 'npm:real@^1.1.0' }],
    'and saves it as npm does, naming the aliased package');
  assert.equal((await ws.exec('rm -rf node_modules')).exitCode, 0);
  const reinstall = await ws.exec('npm install');
  assert.equal(reinstall.exitCode, 0, reinstall.stderr);
  assert.deepEqual(installedAs(), [{ name: 'real', version: '1.1.0' }, { name: 'real', version: '1.1.0' }],
    'a reinstall from package.json installs the aliased package again');

  const corrupt = await ws.exec('npm install corrupt');
  assert.notEqual(corrupt.exitCode, 0, 'a tarball that does not match its integrity is refused');
  assert.match(corrupt.stderr, /integrity mismatch/);
  assert.equal(fs.exists('/home/user/node_modules/corrupt/package.json'), false, 'and nothing of it is installed');

  const multi = await ws.exec('npm install multihash');
  assert.equal(multi.exitCode, 0, multi.stderr);
  assert.ok(fs.exists('/home/user/node_modules/multihash/package.json'), 'a multi-hash integrity is checked by its strongest entry');
} finally {
  globalThis.fetch = originalFetch;
  harness.db.close();
}

console.log(`npm-fallback-engine: ${SPECS.length} specs pick as npm and the worker pick, alias, integrity`);
