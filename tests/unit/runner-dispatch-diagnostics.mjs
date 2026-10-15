#!/usr/bin/env bun
// A runtime that cannot start says why the way every command does
// (_shared/error-text.ts): an Error's message, a thrown object's `message`,
// and an Error with no message by its name, never "[object Object]" or
// nothing at all.
//
// The workspace's facet host refuses to open a facet, throwing each kind of
// value; python and bash are installed from a catalog and run through
// ws.exec, so each runner's own dispatch path reports the refusal.
//
// Red before: the CPython and Bash runners each had their own formatter
// (instanceof Error, else String), which printed "[object Object]" for a
// thrown object and an empty reason for Error('').

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const bytes = new Uint8Array([10]);
const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
/** A one-byte package: what a runner checks before it opens its facet is there, and nothing runs. */
const build = (name, version, paths, entrypoints) => ({
  manifest: {
    name, version, license: 'MIT', wasi_namespace: 'wasi_snapshot_preview1', entrypoints,
    files: paths.map((path) => ({ path, content: `blobs/${name}-${version}/${path}`, sha256, size: 1, ...(path.startsWith('bin/') ? { mode: 'exec' } : {}) })),
  },
  readBlob: () => bytes,
});
const builds = [
  build('cpython', '3.13.14-2', ['bin/python', 'share/cpython/python.wasm', 'lib/python313.zip'], [{ binName: 'python', runner: 'cpython-runner@2', args: [] }]),
  build('bash', '5.2.37-6', ['bin/bash', 'share/bash/bash.async.wasm'], [{ binName: 'bash', runner: 'bash-runner@5', args: [] }]),
];
const runtimeSource = {
  async list() {
    return builds.map((b) => ({ name: b.manifest.name, abi: 'wasm32-wasi-nimbus', defaultVersion: b.manifest.version, versions: [{ version: b.manifest.version, sizeBytes: 1, license: 'MIT' }] }));
  },
  async resolve(spec) {
    return builds.find((b) => spec === b.manifest.name || spec === `${b.manifest.name}@${b.manifest.version}`) ?? null;
  },
};

let refusal = null;
const facets = { parking: 'none', open() { throw refusal; } };
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, runtimeSource, facets });
try {
  await ws.runtimes.install('cpython');
  await ws.runtimes.install('bash');
  for (const [thrown, reason, what] of [
    [new Error('boom'), 'boom', 'an Error, by its message'],
    [{ message: 'refused' }, 'refused', 'a thrown object, by its message'],
    [new Error(''), 'Error', 'an Error with no message, by its name'],
    ['plain', 'plain', 'a thrown string, as itself'],
  ]) {
    refusal = thrown;
    const python = await ws.exec('python -c pass', { cwd: '/home/user' });
    assert.deepEqual({ exitCode: python.exitCode, stderr: python.stderr }, { exitCode: 1, stderr: `python: ${reason}\n` }, `python reports ${what}`);
    const bash = await ws.exec('bash -c true', { cwd: '/home/user' });
    assert.deepEqual({ exitCode: bash.exitCode, stderr: bash.stderr }, { exitCode: 1, stderr: `bash: dispatch failed: ${reason}\n` }, `bash reports ${what}`);
    console.log(`  ✓ python and bash report ${what}`);
  }
} finally {
  await ws.close();
}
console.log('runner-dispatch-diagnostics: ok');
