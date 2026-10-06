#!/usr/bin/env bun
// npm-install-optional-peers — an optional peer installs only when the
// project asks for it, as npm installs it.
//
// npm 7+ installs a package's required peers and never its optional ones
// (`peerDependenciesMeta: { x: { optional: true } }`); pnpm and bun agree.
// Nimbus installed the optional peers of every top-level package. Measured
// 2026-10-01: `npm create vite` (react-ts) + `npm install` is 70 packages
// with npm 10.9 and ~456 in a Nimbus session, which held sass,
// sass-embedded, less, stylus, terser, tsx, jiti, @vitejs/devtools and
// Babel's trees. Those extras also ran: Vite 8's first build read a file
// only they bring (less -> probe-image-size -> stream-parser -> debug -> ms).
//
// Through the real NpmInstaller over real SQLite, each package resolved by
// the real per-package resolver task from a synthetic registry.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { kernelInstaller, makeFanoutEnv } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const PREAMBLE_SYMBOLS = [
  'SHOULD_SWAP', 'SHOULD_REJECT_FAIL',
  'NATIVE_EXECUTABLE_REJECT', 'NATIVE_PLATFORM_REJECT', 'IS_OPTIONAL_NATIVE_BINDING', 'PARSE_SEMVER', 'COMPARE_SEMVER',
  'SATISFIES_RANGE', 'RESOLVE_VERSION', 'IS_SEMVER_RANGE', 'STAGED_ARTIFACT', 'STAGED_ARTIFACT_APPLY',
];
Object.assign(globalThis, new Function(`${NPM_RESOLVE_PREAMBLE}\nreturn { ${PREAMBLE_SYMBOLS.join(', ')} };`)());
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

/** name -> the one version's manifest fields beyond name and version. */
const REGISTRY = {
  tool: {
    dependencies: { helper: '^1.0.0' },
    peerDependencies: { host: '^1.0.0', styler: '^1.0.0', listed: '^1.0.0' },
    peerDependenciesMeta: { styler: { optional: true }, listed: { optional: true } },
  },
  helper: { peerDependencies: { extra: '^1.0.0' }, peerDependenciesMeta: { extra: { optional: true } } },
  host: {},
  styler: { dependencies: { 'styler-dep': '^1.0.0' } },
  'styler-dep': {},
  listed: {},
  extra: {},
};

const asked = [];
function packumentFor(name) {
  const fields = REGISTRY[name];
  if (!fields) return null;
  return JSON.stringify({
    name,
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name, version: '1.0.0', ...fields, dist: { tarball: `https://registry.invalid/${name}-1.0.0.tgz`, integrity: `sha512-${name}` } } },
  });
}
const resolverEnv = {
  SUPERVISOR: {
    async getPackument(name) {
      asked.push(name);
      const json = packumentFor(name);
      return json === null ? { events: [], status: 404, source: 'network' } : { events: [], json, source: 'network' };
    },
  },
};

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const root = vfs.as(CRED_KERNEL);
root.mkdir(NM, { recursive: true });
root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'fixture', dependencies: { tool: '^1.0.0' }, devDependencies: { listed: '^1.0.0' } }));
const log = [];
const env = makeFanoutEnv({
  root, NM,
  resultFor: (name, spec) => resolveOnePackumentInFacet({ cachedEntries: [], isOptional: false, fetchTimeoutMs: 1_000, retries: 0, ...spec }, resolverEnv),
});
const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });

const result = await installer.install(PROJ, { pid: 1 });
assert.deepEqual(result.failed, [], `nothing fails: ${log.join('\n')}`);
const installed = (name) => root.exists(`${NM}/${name}/package.json`);

assert.ok(installed('tool') && installed('helper'), 'the project\'s dependency and its own dependency');
assert.ok(installed('host'), 'a required peer installs');
assert.ok(installed('listed'), 'an optional peer the project lists installs, as the project asked');
for (const name of ['styler', 'styler-dep', 'extra']) {
  assert.equal(installed(name), false, `an optional peer nobody asked for is not installed: ${name}`);
  assert.equal(asked.includes(name), false, `nor resolved: ${name}`);
}
assert.deepEqual([...installer.npmCache.readLockfile(PROJ).keys()].sort(), ['helper', 'host', 'listed', 'tool'], 'the lockfile holds what was installed');

console.log('npm-install-optional-peers: ok');
