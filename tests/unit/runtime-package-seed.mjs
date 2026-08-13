#!/usr/bin/env bun
// A runtime package installs like an install, and refuses like one.
//
// `seedRuntimePackage` is the second publisher behind `~/.nimbus/runtimes`:
// npm carries the bytes where Cloudflare's package manager carries them out of
// R2. Both write the same tree, so what is asserted here is the tree — the
// layout `installed-runtimes.ts` reads back — rather than any call it made.
//
// The digest check is the half that matters most. The blobs are interpreters,
// so bytes that reach the filesystem are bytes that execute; the R2 path
// verifies every one against its manifest entry and this one must not be
// weaker just because npm handed it a directory instead of a bucket.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { seedRuntimePackage } from '../../packages/core/src/runtime/runtime-package.ts';
import { listInstalledManifestsView } from '../../packages/core/src/runtime/installed-runtimes.ts';

const KERNEL = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const HOME = '/home/user';
const encoder = new TextEncoder();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A runtime package, in the shape the generated `index.js` exports. */
function fakePackage(contents) {
  const files = Object.entries(contents).map(([path, text], i) => {
    const bytes = encoder.encode(text);
    return {
      path,
      content: `blobs/toy-1.0.0/${sha256(bytes)}/file-${i}`,
      sha256: sha256(bytes),
      size: bytes.length,
      ...(path.startsWith('bin/') ? { mode: 'exec' } : {}),
    };
  });
  const blobs = new Map(files.map((file, i) => [file.content, encoder.encode(Object.values(contents)[i])]));
  return {
    manifest: {
      name: 'toy',
      version: '1.0.0',
      license: 'MIT',
      wasi_namespace: 'wasi_snapshot_preview1',
      files,
      entrypoints: [{ binName: 'toy', runner: 'toy-runner', args: [] }],
    },
    readBlob: (file) => blobs.get(file.content),
    blobs,
  };
}

const openVfs = () => {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  return new SqliteVFS(harness.sql, harness.ctx);
};

// ── The tree an install leaves ──────────────────────────────────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({
    'bin/toy': '# marker\n',
    'share/toy/toy.wasm': 'not really wasm, but its own bytes\n',
    'LICENSE': 'MIT\n',
  });

  const seeded = await seedRuntimePackage(fs, HOME, pkg);
  assert.deepEqual(seeded, {
    name: 'toy', version: '1.0.0', root: 'home/user/.nimbus/runtimes/toy/1.0.0', written: true,
  });

  for (const file of pkg.manifest.files) {
    assert.equal(fs.readFileString(`${seeded.root}/${file.path}`),
      new TextDecoder().decode(pkg.blobs.get(file.content)), file.path);
  }

  // The point of the shared layout: the reader that rehydrates a Durable
  // Object after eviction finds this exactly as it finds an R2 install.
  const installed = listInstalledManifestsView(fs, HOME);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].root, seeded.root);
  assert.equal(installed[0].manifest.entrypoints[0].binName, 'toy');
  console.log('  ok  a package installs at ~/.nimbus/runtimes/<name>/<version>/ and reads back');

  // Idempotent on the rule the package manager uses: a manifest already there
  // means the install completed.
  const again = await seedRuntimePackage(fs, HOME, pkg);
  assert.equal(again.written, false);
  console.log('  ok  seeding twice installs once');
}

// ── A blob that is not what the manifest says it is ─────────────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'share/toy/toy.wasm': 'the real bytes\n' });
  const target = pkg.manifest.files[0];
  pkg.blobs.set(target.content, encoder.encode('substituted bytes\n'));

  await assert.rejects(
    () => seedRuntimePackage(fs, HOME, pkg),
    (error) => {
      assert.match(error.message, /toy@1\.0\.0: sha256 mismatch for share\/toy\/toy\.wasm/);
      assert.match(error.message, new RegExp(target.sha256));
      return true;
    },
    'a substituted blob must be refused by name',
  );

  // And nothing claims the install completed, so the next attempt refetches
  // rather than reporting a runtime that is half there.
  assert.equal(fs.exists('home/user/.nimbus/runtimes/toy/1.0.0/manifest.json'), false);
  assert.equal(listInstalledManifestsView(fs, HOME).length, 0);
  console.log('  ok  a blob that does not match its digest is refused, and leaves no install');
}

// ── A manifest that is not a manifest ───────────────────────────────────────
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'share/toy/toy.wasm': 'bytes\n' });
  pkg.manifest.files[0].sha256 = 'not-a-digest';

  await assert.rejects(() => seedRuntimePackage(fs, HOME, pkg));
  console.log('  ok  a manifest core cannot parse is refused before anything is written');
}

console.log('runtime-package-seed: ok');
