#!/usr/bin/env bun
// npx keeps what it installs as libnpmexec 10.9.8 does: each request in a
// directory of its own (the first 16 hex digits of the SHA-512 of its specs,
// sorted, one a line, under /tmp/.npx-cache), written only by that request's
// install; and it runs what is installed only where that answers the request
// (missingFromTree): a wildcard any version, a version or range only a
// version satisfying it, in the project or in that directory.
//
// Red before: every npx installed into one shared project whose package.json
// named the request before the install ran, so a request that failed stayed
// a root and failed every later npx; and a request by version ran whatever
// version the project or the cache held.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { resolveNpxBinary } from '../../packages/worker/src/npm/npx-install.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { npmRegistry } from './lib/npm-registry.mjs';

const VERSIONS = { p: ['1.0.0', '2.0.0'], tool: ['3.1.0'] };

/** A session whose registry has `VERSIONS` (each bin `cli.js`), its project at /home/user/app holding `local`. */
function session(local = {}) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir('home/user/app', { recursive: true });
  for (const [name, version] of Object.entries(local)) {
    root.mkdir(`home/user/app/node_modules/${name}`, { recursive: true });
    root.writeFile(`home/user/app/node_modules/${name}/package.json`, JSON.stringify({ name, version, bin: { [name]: 'cli.js' } }));
    root.writeFile(`home/user/app/node_modules/${name}/cli.js`, '');
  }
  const { resultFor } = npmRegistry(Object.fromEntries(Object.entries(VERSIONS).map(([name, versions]) => [
    name, Object.fromEntries(versions.map((version) => [version, { bin: { [name]: 'cli.js' } }])),
  ])));
  const env = makeFanoutEnv({ root, NM: 'tmp/.npx-cache/node_modules', resultFor, manifestFor: (p) => ({ name: p.name, version: p.version, bin: { [p.name]: 'cli.js' } }), filesFor: () => ({ 'cli.js': '' }) });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
  const installs = [];
  const install = installer.install.bind(installer);
  installer.install = (dir, spec) => { installs.push(spec.packages); return install(dir, spec); };
  const projectView = {
    exists: async (path) => root.exists(path),
    isDirectory: async (path) => root.exists(path) && root.stat(path).type === 'directory',
    readFileString: async (path) => root.readFileString(path),
    mkdir: async (path, options) => root.mkdir(path, options),
    writeFile: async (path, data) => root.writeFile(path, data),
  };
  const npx = (...args) => resolveNpxBinary(installer, projectView, CRED_KERNEL, '/home/user/app', args, () => {}, 1);
  const versionOf = (binPath) => JSON.parse(root.readFileString(`${binPath.slice(1, binPath.lastIndexOf('/'))}/package.json`)).version;
  return { root, npx, versionOf, installs };
}

/** libnpmexec's directory for `specs`. */
const npmDir = (specs) => `/tmp/.npx-cache/${createHash('sha512').update([...specs].sort((a, b) => a.localeCompare(b, 'en')).join('\n')).digest('hex').slice(0, 16)}`;

// ── A request that fails leaves nothing another request reads ──
{
  const { root, npx, versionOf } = session();
  const missing = await npx('no-such-package');
  assert.equal(missing.ok, false, 'a missing package ran');
  assert.equal(root.exists('tmp/.npx-cache/package.json'), false, 'the failed request named itself in a shared project');
  const ran = await npx('tool');
  assert.equal(ran.ok, true, `a later request failed: ${ran.error}`);
  assert.equal(versionOf(ran.binPath), '3.1.0');
  assert.ok(ran.binPath.startsWith(`${npmDir(['tool'])}/node_modules/tool/`), `installed where libnpmexec installs it: ${ran.binPath}`);
}

// ── A request by version runs only a version that answers it ──
{
  const { npx, versionOf } = session({ p: '1.0.0' });
  const two = await npx('p@2.0.0');
  assert.equal(two.ok, true, two.error);
  assert.equal(versionOf(two.binPath), '2.0.0', 'the project\'s p@1.0.0 ran for p@2.0.0');
  assert.equal(two.source, 'fresh-install');
  const caret = await npx('p@^1.0.0');
  assert.equal(caret.source, 'project-nm', 'the project\'s p@1.0.0 answers ^1.0.0');
  assert.equal((await npx('p')).source, 'project-nm', 'by name alone, the project\'s');
  const again = await npx('p@2.0.0');
  assert.equal(again.source, 'npx-cache', 'the request\'s own directory answers it again');
  assert.equal(versionOf(again.binPath), '2.0.0');
}

// ── A wildcard takes any installed version, a prerelease too, as missingFromTree does ──
// Red before: `p@*` was matched as a range, which takes no prerelease, so it installed again.
{
  const { npx, versionOf, installs } = session({ p: '1.0.0-beta.1' });
  const any = await npx('p@*');
  assert.equal(any.ok, true, any.error);
  assert.equal(any.source, 'project-nm', 'the project\'s prerelease did not answer p@*');
  assert.equal(versionOf(any.binPath), '1.0.0-beta.1');
  assert.equal((await npx('p@1.0.0-beta.1')).source, 'project-nm', 'the exact prerelease did not answer itself');
  assert.deepEqual(installs, [], 'npx installed what the project had');
}

// ── What one request installed does not answer another's version ──
{
  const { npx, versionOf } = session();
  assert.equal(versionOf((await npx('p@1.0.0')).binPath), '1.0.0');
  const two = await npx('p@2.0.0');
  assert.equal(versionOf(two.binPath), '2.0.0', 'p@1.0.0 from the cache ran for p@2.0.0');
  assert.equal(two.source, 'fresh-install');
}

console.log('npx-cache: ok');
