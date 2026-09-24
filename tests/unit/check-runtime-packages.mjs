#!/usr/bin/env bun
// core's prepublishOnly gate, decision by decision, over a fake registry and
// the real core: a runtime package core needs is either on npm as `latest`
// with the manifest this tree builds, or core does not publish.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRuntimePackage,
  publishCommand,
  runThroughCore,
} from '../../packages/core/scripts/check-runtime-packages.mjs';
import { BASH_RUNNER } from '../../packages/core/src/runtime/os-contracts.ts';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NAME = '@nimbus-sh/runtime-toy';
const root = mkdtempSync(join(tmpdir(), 'nimbus-gate-test-'));

/** A runtime package directory in the shape bundle-runtime.mjs writes. */
function packageDir(label, runner) {
  const dir = join(root, label);
  const bytes = Buffer.from('# marker\n');
  const content = `blobs/toy-1.0.0-2/${sha256(bytes)}/BIN_MARKER`;
  mkdirSync(join(dir, content, '..'), { recursive: true });
  writeFileSync(join(dir, content), bytes);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    name: 'toy', version: '1.0.0-2', license: 'MIT', wasi_namespace: 'wasi_snapshot_preview1',
    files: [{ path: 'bin/toy', content, sha256: sha256(bytes), size: bytes.length, mode: 'exec' }],
    entrypoints: [{ binName: 'toy', runner, args: [] }],
  }, null, 2));
  writeFileSync(join(dir, 'index.js'), `import { readFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
export const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
export function readBlob(file) { return new Uint8Array(readFileSync(new URL(file.content, root))); }
export default { manifest, readBlob };
`);
  return dir;
}

/** A registry holding `versions` (version → manifest sha256) under `latest`. */
const fakeRegistry = (versions, latest) => ({
  packument: async (name) => (name === NAME && versions
    ? { 'dist-tags': { latest }, versions: Object.fromEntries(Object.entries(versions).map(([v, sha]) => [v, { sha }])) }
    : null),
  manifestSha256: async (record) => record.sha,
});

try {
  const good = packageDir('good', BASH_RUNNER);
  const builtSha = sha256(readFileSync(join(good, 'manifest.json')));
  const check = (dir, registry) =>
    checkRuntimePackage({ name: NAME, version: '1.0.0-2', dir, registry, runThroughCore });

  // ── Released: on the registry, same manifest, latest ───────────────────
  assert.deepEqual(await check(good, fakeRegistry({ '1.0.0': 'old', '1.0.0-2': builtSha }, '1.0.0-2')), []);

  // ── Not published: the fix is the publish, tagged latest ───────────────
  for (const registry of [fakeRegistry(null), fakeRegistry({ '1.0.0': 'old' }, '1.0.0')]) {
    const problems = await check(good, registry);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0].problem, /@nimbus-sh\/runtime-toy@1\.0\.0-2 is not on the registry/);
    assert.equal(problems[0].fix, publishCommand(good));
    assert.equal(problems[0].fix, `cd ${good} && npm publish --tag latest --access public --auth-type=web`);
  }

  // ── Published under that version with other bytes ──────────────────────
  {
    const problems = await check(good, fakeRegistry({ '1.0.0-2': 'f'.repeat(64) }, '1.0.0-2'));
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0].problem, new RegExp(`sha256 f{64}; this tree builds ${builtSha}`));
    assert.match(problems[0].fix, /new build number/);
  }

  // ── Published, but `latest` still serves the older build ───────────────
  // 1.0.0-2 sorts below 1.0.0: without the tag, `^1.0.0-0` installs build 1.
  {
    const problems = await check(good, fakeRegistry({ '1.0.0': 'old', '1.0.0-2': builtSha }, '1.0.0'));
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0].problem, /latest of @nimbus-sh\/runtime-toy is 1\.0\.0, not 1\.0\.0-2/);
    assert.equal(problems[0].fix, 'npm dist-tag add @nimbus-sh/runtime-toy@1.0.0-2 latest --auth-type=web');
  }

  // ── A runner this core does not register: refused, even when released ─
  {
    const stale = packageDir('stale', 'bash-runner');
    const staleSha = sha256(readFileSync(join(stale, 'manifest.json')));
    const problems = await check(stale, fakeRegistry({ '1.0.0-2': staleSha }, '1.0.0-2'));
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0].problem, /refuses it: .*toy@1\.0\.0-2 needs runner 'bash-runner'/);
    assert.ok(problems[0].problem.includes(`'${BASH_RUNNER}'`), problems[0].problem);
    assert.match(problems[0].fix, /no publish fixes this/);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('check-runtime-packages: all assertions passed');
