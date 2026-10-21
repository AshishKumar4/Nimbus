#!/usr/bin/env bun
// `@nimbus-sh/core/node-compat` is Node's fs alone (Kinu ask 67): bundled
// for a client's isolate, it reaches its leaf modules (vfs-error,
// dirent-type, node-arguments, node-error, bytes, path, encoding) and the
// host's node: builtins, and nothing of the kernel, SQLite, the shell or a
// wasm loader.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'nimbus-node-compat-graph-'));
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['packages/core/src/node-compat/index.ts'],
    bundle: true, format: 'esm', platform: 'browser', outdir: scratch, metafile: true, logLevel: 'silent',
    external: ['node:*'],
  });
  const inputs = Object.keys(result.metafile.inputs);
  const reached = inputs.filter((input) => /kernel|sqlite|wasi|wasm|substrate\/lifo\/(shell|commands|kernel)|workspace\//i.test(input));
  assert.deepEqual(reached, [], `node-compat reaches no kernel, SQLite, shell or wasm module: ${reached.join(', ')}`);
  assert.ok(inputs.some((input) => input.endsWith('node-compat/fs.ts')), 'and it is the shared fs');
  console.log(`  ok  ${inputs.length} modules, none of the kernel, SQLite, the shell or wasm`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log('node-compat-graph OK');
