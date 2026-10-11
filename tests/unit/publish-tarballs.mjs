import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTarball, verifyPublishedTarballs } from '../../scripts/ci/lib/publish-tarballs.mjs';
import { packageTarball } from './lib/tarball-fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'nimbus-pack-once-'));
const before = process.env.PATH;
try {
  const bin = join(root, 'bin'), pkg = join(root, 'pkg'), out = join(root, 'out');
  for (const dir of [bin, pkg, out]) mkdirSync(dir);
  const manifest = { name: '@fixture/one', version: '1.0.0' };
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  const bytes = packageTarball({ 'package/package.json': JSON.stringify(manifest, null, 2), 'package/main.js': 'module.exports = 1;' });
  writeFileSync(join(root, 'fixture.tgz'), bytes);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho packed >> '${root}/calls'\ncp '${root}/fixture.tgz' "$5/fixture.tgz"\necho '[{"filename":"fixture.tgz"}]'\n`);
  chmodSync(join(bin, 'npm'), 0o700);
  process.env.PATH = bin + ':' + before;
  const prepared = prepareTarball(pkg, out);
  const messages = [];
  const request = async url => url.endsWith('/1.0.0')
    ? Response.json({ dist: { tarball: 'https://registry.test/archive' } }) : new Response(bytes);
  await verifyPublishedTarballs([prepared], { registry: 'https://registry.test', fetch: request, log: text => messages.push(text) });
  assert.match(messages[0], /unchanged/);
  assert.equal(readFileSync(join(root, 'calls'), 'utf8').trim(), 'packed', 'comparison never calls npm pack again');
  assert.equal(Buffer.from(prepared.base64, 'base64').compare(readFileSync(prepared.path)), 0, 'the signing payload is the archive compared');
  await assert.rejects(verifyPublishedTarballs([prepared], {
    registry: 'https://registry.test', log() {}, fetch: async url => url.endsWith('/1.0.0')
      ? Response.json({ dist: { tarball: 'https://registry.test/archive' } })
      : new Response(packageTarball({ 'package/package.json': JSON.stringify(manifest), 'package/main.js': 'different' })),
  }), /changed since their version was published/);
  writeFileSync(prepared.path, 'tampered');
  await assert.rejects(verifyPublishedTarballs([prepared], { fetch: request, log() {} }), /changed after packing/);
} finally {
  process.env.PATH = before;
  rmSync(root, { recursive: true, force: true });
}
console.log('publish-tarballs: compare and signing use one prepared archive; changed bytes fail closed');
