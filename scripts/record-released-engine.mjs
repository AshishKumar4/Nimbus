#!/usr/bin/env bun
// Record tests/fixtures/released-engine/sqlite-vfs-<sha>.mjs: the durable
// filesystem (SqliteVFS and CRED_KERNEL) as a release had it, bundled into
// one module, for tests of what a rollback runs. Production rolls back with
// `wrangler versions deploy <previous>`, which puts that release's engine
// over the database this one wrote; a test imports the fixture to run it.
//
//   bun scripts/record-released-engine.mjs <commit>
//
// The commit's packages/core/src and packages/platform/src are extracted
// from git and bundled with esbuild; zod stays an import (the repository's
// own), node builtins stay builtins. The fixture names its commit in its
// first line.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ref = process.argv[2];
if (!ref) {
  console.error('usage: bun scripts/record-released-engine.mjs <commit>');
  process.exit(2);
}
const sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'released-engine-'));
try {
  const archive = execFileSync('git', ['-C', REPO, 'archive', sha, 'packages/core/src', 'packages/platform/src', 'packages/platform/package.json'], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', work], { input: archive });
  mkdirSync(join(work, 'packages/core/node_modules/@nimbus-sh'), { recursive: true });
  symlinkSync('../../../platform', join(work, 'packages/core/node_modules/@nimbus-sh/platform'));
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, [
    "export { SqliteVFS } from './packages/core/src/vfs/sqlite-vfs.ts';",
    "export { CRED_KERNEL } from './packages/core/src/runtime/os-contracts.ts';",
    '',
  ].join('\n'));
  const outfile = join(work, 'engine.mjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    conditions: ['workspace'],
    external: ['zod', 'zod/*'],
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    outfile,
  });
  const fixtures = join(REPO, 'tests/fixtures/released-engine');
  mkdirSync(fixtures, { recursive: true });
  const target = join(fixtures, `sqlite-vfs-${sha.slice(0, 12)}.mjs`);
  writeFileSync(target, `// SqliteVFS as commit ${sha} had it: recorded by scripts/record-released-engine.mjs. Do not edit.\n${readFileSync(outfile, 'utf8')}`);
  console.log(`recorded ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
