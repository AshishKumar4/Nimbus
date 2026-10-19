#!/usr/bin/env bun
// The npm release's order and its publish. publishPackages orders the
// packages so each follows the published packages it needs; npm-publish
// publishes what publish-pack packed, in that order, each version npm lacks,
// and refuses a set holding an archive that is not the one packed, and stops
// at the first publish that fails.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishPackages } from '../../scripts/ci/lib/publish-packages.mjs';
import { publishPacked } from '../../scripts/ci/npm-publish.mjs';

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const root = mkdtempSync(join(tmpdir(), 'nimbus-publish-test-'));

try {
  const published = publishPackages(repo);
  assert.equal(published.length, 10);
  assert.ok(published.some((pkg) => pkg.name === 'create-nimbus-app'), 'the version guard includes the published create helper');
  const index = new Map(published.map((pkg, index) => [pkg.name, index]));
  for (const pkg of published) for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (index.has(dep)) assert.ok(index.get(dep) < index.get(pkg.name), `${pkg.name} follows its published dependency ${dep}`);
  }
  console.log('  ✓ the packages are ordered after the published packages they need');

  // A fake npm that records each call and fails a publish of an archive named *fail*.
  const bin = join(root, 'bin');
  const calls = join(root, 'calls');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$*" >> '${calls}'\ncase "$2" in *fail*) exit 1;; esac\n`);
  chmodSync(join(bin, 'npm'), 0o700);
  const dir = join(root, 'tarballs');
  mkdirSync(dir);
  const hash = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);
  const receipt = (name, version) => {
    const bytes = Buffer.from(`${name}@${version}`);
    const file = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    writeFileSync(join(dir, file), bytes);
    return { name, version, file, bytes: bytes.length, sha256: hash('sha256', bytes, 'hex'), shasum: hash('sha1', bytes, 'hex'), integrity: `sha512-${hash('sha512', bytes, 'base64')}` };
  };
  const packed = [receipt('@nimbus-sh/runtime-toy', '1.0.0-2'), receipt('@nimbus-sh/held', '0.1.0'), receipt('@nimbus-sh/next', '0.2.0')];
  const held = new Set(['@nimbus-sh/held@0.1.0']);
  const fetch = async (url) => {
    const [, name, version] = /^https:\/\/registry\.test\/(.+)\/([^/]+)$/.exec(url);
    return new Response('{}', { status: held.has(`${decodeURIComponent(name)}@${version}`) ? 200 : 404 });
  };
  const run = (options) => publishPacked({ tarballs: packed, dir, registry: 'https://registry.test', fetch, npm: join(bin, 'npm'), log() {}, ...options });
  const npmCalls = () => readFileSync(calls, 'utf8').trim().split('\n');

  const done = await run();
  assert.deepEqual(done.map(({ name, published }) => [name, published]), [['@nimbus-sh/runtime-toy', true], ['@nimbus-sh/held', false], ['@nimbus-sh/next', true]]);
  assert.deepEqual(npmCalls(), [packed[0], packed[2]].map(({ file }) => `publish ${join(dir, file)} --tag latest --access public`));
  console.log('  ✓ each version npm lacks is published, in order, tagged latest; one npm has is skipped');

  rmSync(calls);
  assert.ok((await run({ dryRun: true })).every(({ published }) => !published));
  assert.deepEqual(npmCalls(), [packed[0], packed[2]].map(({ file }) => `publish ${join(dir, file)} --tag latest --access public --dry-run`));
  console.log('  ✓ a dry run publishes nothing');

  rmSync(calls, { force: true });
  writeFileSync(join(dir, packed[2].file), 'other bytes');
  await assert.rejects(run(), /is not the archive publish-pack packed; nothing was published/);
  assert.throws(() => readFileSync(calls), /ENOENT/, 'not one publish ran');
  console.log('  ✓ an archive that is not the one packed stops the whole set');

  const failing = [receipt('@nimbus-sh/fail', '1.0.0'), receipt('@nimbus-sh/after', '1.0.0')];
  await assert.rejects(publishPacked({ tarballs: failing, dir, registry: 'https://registry.test', fetch, npm: join(bin, 'npm'), log() {} }), /npm publish @nimbus-sh\/fail@1\.0\.0 exited 1; nothing after it was published/);
  assert.deepEqual(npmCalls(), [`publish ${join(dir, failing[0].file)} --tag latest --access public`]);
  console.log('  ✓ a publish that fails stops the ones after it');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('ci-publish: ok');
