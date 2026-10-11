// Canonical publisher metadata for the private real-Git latency audit; never publishes to R2/npm.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'nimbus-git-audit-package-'));
try {
  const pkg = join(dir, 'git');
  execFileSync('node', ['packages/worker/scripts/bundle-runtime.mjs', 'git', '2.53.0', '--npm-package', pkg], { cwd: root, stdio: 'pipe' });
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'));
  const blobs = [];
  for (const file of manifest.files) {
    const bytes = readFileSync(join(pkg, file.content));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(bytes.byteLength, file.size);
    if (!blobs.some((blob) => blob.key === file.content)) blobs.push({ key: file.content, sha256: file.sha256, size: file.size, ...(file.size < 32768 ? { base64: bytes.toString('base64') } : {}) });
  }
  console.log('GIT_AUDIT_PACKAGE ' + JSON.stringify({ manifest, blobs }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
