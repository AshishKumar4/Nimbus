#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { plugin } from 'bun';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// Supply the compiled asset that the host bundler supplies in production.
// The service, esbuild-wasm, its resolver plugin and the SQLite VFS stay real.
const resolveFromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const wasmModule = await WebAssembly.compile(
  await readFile(resolveFromCore.resolve('esbuild-wasm/esbuild.wasm')),
);
plugin({
  name: 'esbuild-wasm-asset',
  setup(build) {
    build.onLoad({ filter: /esbuild-wasm\/esbuild\.wasm$/ }, () => ({
      exports: { default: wasmModule },
      loader: 'object',
    }));
  },
});
const { EsbuildService, loadEsbuild } = await import('../../packages/core/src/runtime/esbuild-service.ts');
const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
const author = raw.as(CRED_SESSION_USER);

try {
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  kernel.mkdir('private', { mode: 0o755 });
  kernel.writeFile('private/secret.ts', 'export default "kernel-only-content";');
  kernel.chmod('private/secret.ts', 0o600);
  author.writeFile('home/user/direct.ts', 'export { default } from "/private/secret.ts";');
  author.writeFile('home/user/transitive.ts', 'export { default } from "./direct.ts";');
  assert.throws(() => author.readFileString('/private/secret.ts'), /EACCES/);

  const privilegedCompiler = new EsbuildService(kernel);
  for (const entry of ['/home/user/direct.ts', '/home/user/transitive.ts']) {
    const result = await privilegedCompiler.build([entry]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.outputFiles.length, 1);
    const bundled = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
    assert.equal(bundled.default, 'kernel-only-content');
  }
  console.log('esbuild-vfs-credentials: explicit kernel absolute and transitive imports succeed');

  // Exercise the restricted view after kernel reads have warmed the VFS cache.
  const compiler = new EsbuildService(author);
  await assert.rejects(
    compiler.build(['/home/user/direct.ts']),
    /File not found in VFS: \/private\/secret\.ts|EACCES/,
    'a compiler must not read an absolute import denied to its author',
  );
  console.log('esbuild-vfs-credentials: non-kernel absolute import denied');
  await assert.rejects(
    compiler.build(['/home/user/transitive.ts']),
    /File not found in VFS: \/private\/secret\.ts|EACCES/,
    'a readable intermediate module must not confer read authority',
  );
  console.log('esbuild-vfs-credentials: non-kernel transitive import denied');
} finally {
  (await loadEsbuild()).stop();
  harness.db.close();
}
