#!/usr/bin/env bun
// The namespace lookup's dependencies and stop point, not a second resolver.
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const root = engine.as(CRED_KERNEL);
root.mkdir('slates/s', { recursive: true });
root.mkdir('home', { recursive: true });
root.symlink('/home/a.ts', 'slates/s/lib.ts');
root.symlink('/home/b/lib.ts', 'home/a.ts');
const ns = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
const options = { follow: true, creating: true, report: true };
const links = ['/slates/s/lib.ts', '/home/a.ts'];

const missing = await ns.mutationRoute('/slates/s/lib.ts', options);
assert.deepEqual(missing, { path: '/home/b/lib.ts', point: '/', readOnly: false, links });
const route = await ns.route('/slates/s/lib.ts', options);
assert.equal(route.path, '/home/b/lib.ts');
assert.deepEqual(route.links, links);
assert.equal(route.source, ns.mounts()[0].source);
assert.deepEqual(await ns.mutationRoute('/slates/s/lib.ts'), { path: '/slates/s/lib.ts', point: '/', readOnly: false });
assert.deepEqual((await ns.mutationRoute('/slates/s/lib.ts', { report: true })).links, [], 'unfollowed leaf is not read');

root.writeFile('home/b', 'obstruction');
for (const method of ['route', 'mutationRoute']) {
  assert.deepEqual(await ns[method]('/slates/s/lib.ts', options), { links, refusal: { code: 'ENOTDIR', at: '/home/b' } });
  await assert.rejects(async () => ns[method]('/slates/s/lib.ts', { follow: true, creating: true }), error => error.code === 'ENOTDIR');
}
root.unlink('home/b');
assert.deepEqual(await ns.mutationRoute('/slates/s/lib.ts', { follow: true, report: true }), { links, refusal: { code: 'ENOENT', at: '/home/b' } });
root.mkdir('home/b');
root.writeFile('home/b/lib.ts', 'old destination');
root.writeFile('home/other.ts', 'new destination');
const inputs = await ns.mutationRoute('/slates/s/lib.ts', options);
const changes = [];
const stop = ns.observeWrites(event => changes.push(event.path));
root.unlink('home/a.ts');
await ns.symlink('/home/other.ts', '/home/a.ts');
assert.ok(changes.some(path => inputs.links.includes(path)), 'repointing an intermediate external link invalidates the cached resolution');
stop();
assert.equal((await ns.mutationRoute('/slates/s/lib.ts', options)).path, '/home/other.ts');

root.unlink('home/a.ts');
root.symlink('/home/c.ts', 'home/a.ts');
root.symlink('/home/a.ts', 'home/c.ts');
const loop = await ns.mutationRoute('/slates/s/lib.ts', options);
assert.equal(loop.refusal.code, 'ELOOP');
assert.equal(loop.links.length, 40, 'record the link targets read before the hop limit');
assert.equal(loop.links[0], '/slates/s/lib.ts');
assert.equal(loop.links[1], '/home/a.ts');
assert.equal(loop.links[2], '/home/c.ts');
assert.equal(loop.refusal.at, '/home/c.ts');

root.symlink('/device/file', 'home/device.ts');
ns.mount('/device', () => null, { absentReason: () => 'disconnected' });
for (const method of ['route', 'mutationRoute']) {
  assert.deepEqual(await ns[method]('/home/device.ts', options), { links: ['/home/device.ts'], refusal: { code: 'ENXIO', at: '/device' } });
}
assert.equal((await ns.route('/home/device.ts', { follow: true })).source, null, 'legacy route still reports an absent backend as before');
await assert.rejects(async () => ns.mutationRoute('/home/device.ts', { follow: true }), error => error.code === 'ENXIO');

const secret = new MemoryVFS({ uid: 1000, gid: 1000 });
secret.chmod('/', 0o600);
secret.writeFile('/file', new TextEncoder().encode('secret'));
ns.mount('/secret', secret);
root.symlink('/secret/file', 'home/secret.ts');
const denied = await ns.as(user).mutationRoute('/home/secret.ts', options);
assert.deepEqual(denied, { links: ['/home/secret.ts'], refusal: { code: 'EACCES', at: '/secret' } });
await assert.rejects(async () => ns.as(user).mutationRoute('/home/secret.ts', { follow: true }), error => error.code === 'EACCES');
console.log('composite-route-traversal-report: links, refusal stops and invalidation passed');
