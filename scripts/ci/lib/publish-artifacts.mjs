import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishPackages } from './publish-packages.mjs';

export function verifiedPublishArtifacts(root, dir, commit, supplied) {
  const manifest = supplied ?? JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'));
  const expected = [{ name: '@nimbus-sh/runtime-cpython', version: '3.13.14-1' }, ...publishPackages(root, commit)];
  if (manifest.commit !== commit || !manifest.job || !manifest.rows?.length || manifest.rows.some((row) => row.exitCode !== 0)
    || manifest.tarballs?.length !== expected.length) throw new Error('publish manifest is incomplete or not a verified result for this commit');
  for (let index = 0; index < expected.length; index++) {
    const artifact = manifest.tarballs[index];
    const pkg = expected[index];
    if (artifact.name !== pkg.name || artifact.version !== pkg.version || !/^[A-Za-z0-9._-]+\.tgz$/.test(artifact.file)) throw new Error(`publish artifact ${index} has wrong identity or dependency order`);
    const bytes = readFileSync(join(dir, artifact.file));
    const hash = (algorithm) => createHash(algorithm).update(bytes);
    if (bytes.length !== artifact.bytes || hash('sha256').digest('hex') !== artifact.sha256 || hash('sha1').digest('hex') !== artifact.shasum
      || 'sha512-' + hash('sha512').digest('base64') !== artifact.integrity) throw new Error(`publish artifact ${artifact.file} failed its byte-integrity receipt`);
  }
  return manifest.tarballs;
}
