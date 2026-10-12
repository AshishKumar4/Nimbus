#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
const namespace = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
const backend = new MemoryVFS();
namespace.mount('/m', backend);
await namespace.mkdir('/m/real');
await namespace.writeFile('/m/real/f', new TextEncoder().encode('file'));
await namespace.symlink('/m/real', '/m/link');

for (const path of ['/m/link/.', '/m/link//', '/m/link/../real', '/m/real/.']) {
  const route = await namespace.route(path, { follow: false });
  const asynchronous = await namespace.stat(path, { follow: false });
  const synchronous = namespace.sync.stat(path, { follow: false });
  assert.equal(route.path, '/real', JSON.stringify({ path, route: { path: route.path }, asynchronous, synchronous }));
  assert.equal(asynchronous?.type, 'directory', JSON.stringify({ path, asynchronous, synchronous }));
  assert.equal(synchronous?.type, 'directory');
}
assert.equal(await namespace.realpathAsync('/m/link/./f'), '/m/real/f');
assert.equal(new TextDecoder().decode(await namespace.readFile('/m/link/../real/f')), 'file');
assert.equal(backend.stat('/link', { follow: false }).type, 'symlink');
kernel.mkdir('home/user', { recursive: true });
assert.equal((await namespace.stat('/home/user/.')).type, 'directory');
harness.db.close();
console.log('vfs-shared-path-walk: ok');
