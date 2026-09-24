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
  const installed = (await listInstalledManifestsView(fs, HOME));
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
  assert.equal((await listInstalledManifestsView(fs, HOME)).length, 0);
  console.log('  ok  a blob that does not match its digest is refused, and leaves no install');
}

// ── A blob that fails its digest once is read again ─────────────────────────
// A source fronted by a shared cache evicts an entry that fails and answers
// the second read from its origin; the install then succeeds with the real
// bytes, and the bad ones never reached the runtime's path.
{
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const pkg = fakePackage({ 'share/toy/toy.wasm': 'the real bytes\n' });
  const target = pkg.manifest.files[0];
  let reads = 0;
  const cached = {
    manifest: pkg.manifest,
    readBlob: (file) => (++reads === 1 ? encoder.encode('poisoned cache entry\n') : pkg.readBlob(file)),
  };

  const seeded = await seedRuntimePackage(fs, HOME, cached);
  assert.equal(reads, 2);
  assert.equal(fs.readFileString(`${seeded.root}/${target.path}`), 'the real bytes\n');
  console.log('  ok  a blob that fails its digest once is read again, and installs from the second read');
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

// ── A streamed blob is never held whole ─────────────────────────────────────
// Runtime blobs are tens of MiB and land in the session's own isolate. The
// install holds pieces, not blobs: bytes the source has handed over but the
// filesystem has not yet taken stay below the smallest blob here, however
// large the payload, with at most three blobs open at once.

const MiB = 1024 * 1024;
const byteAt = (i) => (Math.imul(i, 2654435761) >>> 24) & 0xff;
const generate = (from, length) => Uint8Array.from({ length }, (_, k) => byteAt(from + k));

function generatedDigest(size) {
  const hash = createHash('sha256');
  for (let at = 0; at < size; at += MiB) hash.update(generate(at, Math.min(MiB, size - at)));
  return hash.digest('hex');
}

/** A package whose blobs are generated as they are pulled, in odd-sized
 *  chunks — from a byte source (as workerd's R2 and cache bodies are) or not. */
function streamedPackage(sizes, { failAt = null, meter, bytes = false }) {
  const files = sizes.map((size, i) => {
    const sha256 = generatedDigest(size);
    return { path: `share/toy/blob-${i}.bin`, content: `blobs/toy-1.0.0/${sha256}/blob-${i}`, sha256, size };
  });
  return {
    manifest: {
      name: 'toy', version: '1.0.0', license: 'MIT', wasi_namespace: 'wasi_snapshot_preview1',
      files, entrypoints: [{ binName: 'toy', runner: 'toy-runner', args: [] }],
    },
    readBlob(file) {
      let at = 0;
      meter.open++;
      meter.peakOpen = Math.max(meter.peakOpen, meter.open);
      return new ReadableStream({
        type: bytes ? 'bytes' : undefined,
        pull(controller) {
          if (failAt !== null && at >= failAt) {
            meter.open--;
            controller.error(new Error('source dropped the connection'));
            return;
          }
          if (at >= file.size) {
            meter.open--;
            controller.close();
            controller.byobRequest?.respond(0);
            return;
          }
          const length = Math.min(100_003, file.size - at);
          controller.enqueue(generate(at, length));
          at += length;
          meter.pulled += length;
          meter.peakRetained = Math.max(meter.peakRetained, meter.pulled - meter.written);
        },
        cancel() {
          meter.open--;
          meter.cancelled++;
        },
      });
    },
  };
}

const newMeter = () => ({ pulled: 0, written: 0, peakRetained: 0, open: 0, peakOpen: 0, cancelled: 0 });

/** The kernel view of `vfs`, counting what each ranged write takes. */
function meteredFs(vfs, meter, { failAfterWrites = Infinity } = {}) {
  const fs = vfs.as(KERNEL);
  let writes = 0;
  return new Proxy(fs, {
    get(target, key) {
      if (key !== 'writeRange') return target[key];
      return (path, offset, bytes) => {
        if (++writes > failAfterWrites) throw new Error('ENOSPC: disk full');
        target.writeRange(path, offset, bytes);
        meter.written += bytes.length;
      };
    },
  });
}

const partialsUnder = (fs, dir) => fs.readdir(dir)
  .filter((entry) => entry.name.endsWith('.nimbus-partial'))
  .map((entry) => entry.name);

for (const bytes of [false, true]) {
  const meter = newMeter();
  const sizes = [18.41, 10.61, 3.67].map((m) => Math.round(m * MiB));
  const pkg = streamedPackage(sizes, { meter, bytes });
  const vfs = openVfs();
  const fs = meteredFs(vfs, meter);

  const seeded = await seedRuntimePackage(fs, HOME, pkg);

  const total = sizes.reduce((a, b) => a + b, 0);
  assert.equal(meter.written, total);
  assert.ok(meter.peakRetained <= 2.5 * MiB,
    `the install held ${(meter.peakRetained / MiB).toFixed(2)} MiB of a ${(total / MiB).toFixed(2)} MiB payload at once`);
  assert.ok(meter.peakOpen <= 3, `${meter.peakOpen} blobs were being read at once`);
  for (const file of pkg.manifest.files) {
    assert.equal(createHash('sha256').update(vfs.as(KERNEL).readFile(`${seeded.root}/${file.path}`)).digest('hex'), file.sha256);
  }
  assert.deepEqual(partialsUnder(vfs.as(KERNEL), `${seeded.root}/share/toy`), []);
  assert.equal((await seedRuntimePackage(fs, HOME, pkg)).written, false, 'a streamed install did not verify as installed');
  console.log(`  ok  a ${(total / MiB).toFixed(1)} MiB ${bytes ? 'byte ' : ''}stream installs holding at most ${(meter.peakRetained / MiB).toFixed(2)} MiB at once`);
}

// ── A streamed blob that fails its digest never reaches its path ────────────
{
  const meter = newMeter();
  const pkg = streamedPackage([3 * MiB], { meter });
  pkg.manifest.files[0].sha256 = generatedDigest(3 * MiB - 1);
  const vfs = openVfs();
  const fs = vfs.as(KERNEL);
  const root = 'home/user/.nimbus/runtimes/toy/1.0.0';

  await assert.rejects(() => seedRuntimePackage(fs, HOME, pkg), /sha256 mismatch for share\/toy\/blob-0\.bin/);
  assert.equal(fs.exists(`${root}/share/toy/blob-0.bin`), false, 'bytes that failed their digest sit at the runtime path');
  assert.deepEqual(partialsUnder(fs, `${root}/share/toy`), []);
  assert.equal((await listInstalledManifestsView(fs, HOME)).length, 0);
  console.log('  ok  a streamed blob that fails its digest is refused and leaves nothing at its path');
}

// ── A source or a write failing partway leaves nothing installed ────────────
for (const [label, failure, bytes] of [
  ['the source fails', { failAt: 2 * MiB }, false],
  ['a write fails', { failAfterWrites: 9 }, false],
  ['a write fails', { failAfterWrites: 9 }, true],
]) {
  const meter = newMeter();
  const pkg = streamedPackage([MiB, 4 * MiB], { meter, failAt: failure.failAt ?? null, bytes });
  // The first blob is fine; only the second one fails.
  if (failure.failAt) {
    const readBlob = pkg.readBlob;
    let calls = 0;
    pkg.readBlob = (file) => (calls++ === 0 ? streamedPackage([MiB], { meter }).readBlob(file) : readBlob(file));
  }
  const vfs = openVfs();
  const fs = meteredFs(vfs, meter, { failAfterWrites: failure.failAfterWrites });
  const root = 'home/user/.nimbus/runtimes/toy/1.0.0';

  await assert.rejects(() => seedRuntimePackage(fs, HOME, pkg), /source dropped the connection|ENOSPC/);
  assert.equal((await listInstalledManifestsView(fs, HOME)).length, 0, `${label}: a partial install lists as installed`);
  assert.equal(vfs.as(KERNEL).exists(`${root}/share/toy/blob-1.bin`), false, `${label}: a partial blob reached its path`);
  assert.deepEqual(partialsUnder(vfs.as(KERNEL), `${root}/share/toy`), []);
  assert.equal(meter.open, 0, `${label}: a blob read outlived the failed install`);
  console.log(`  ok  when ${label} partway${bytes ? ' (byte stream)' : ''}, nothing is installed and no read is left open`);
}

console.log('runtime-package-seed: ok');
