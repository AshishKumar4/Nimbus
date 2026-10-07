#!/usr/bin/env bun
// The mount example in packages/core/README.md and the docs site's
// sdk/library.mdx is one example, and it runs: the code block is taken from
// both files, checked identical, and run against a workspace, and `mount`
// prints what its comment says.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const root = new URL('../../', import.meta.url).pathname;
const block = (file, heading) => {
  const text = readFileSync(join(root, file), 'utf8');
  const section = text.slice(text.indexOf(heading));
  const match = section.match(/```ts\n([\s\S]*?)```/);
  assert.ok(match, `${file}: a ts block under ${heading}`);
  return match[1];
};
const readme = block('packages/core/README.md', '## Mounts in df, mount and /proc/mounts');
const site = block('apps/docs/src/content/docs/sdk/library.mdx', '## Host mounts in df and mount');
assert.equal(site, readme, 'the README and the docs site show the same example');

// Run it as written, with the host's sql, transactions and generation in scope.
// Inside a package that depends on @nimbus-sh/core, so its imports resolve as an embedder's do.
const dir = mkdtempSync(join(root, 'packages/worker/.docs-example-'));
try {
  const file = join(dir, 'example.ts');
  const body = readme.replace("await ws.exec('mount');", "globalThis.__mount = await ws.exec('mount');");
  const imports = body.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  const rest = body.split('\n').filter((line) => !line.startsWith('import ')).join('\n');
  writeFileSync(file, `${imports}\nconst { sql, transactions, generation } = globalThis.__host;\n${rest}\n`);
  const harness = createSqliteVfsTestHarness();
  globalThis.__host = { sql: harness.sql, transactions: harness.ctx, generation: 1 };
  await import(file);
  const mount = globalThis.__mount;
  assert.equal(mount.exitCode, 0, mount.stderr);
  assert.match(mount.stdout, /^r2:team-bucket on \/shared type r2 \(rw\)$/m);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('docs-mount-example: ok');
