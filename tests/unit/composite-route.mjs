#!/usr/bin/env bun
// CompositeVFS.route (Kinu's ask 23): where an operation on a path lands for
// a view's principal — the mount point, that backend as the principal sees
// it, and the path the backend is handed — so an embedder calls a backend's
// own extras (a device's writeFileWithReport) without re-parsing paths. The
// lookup is every operation's: root links on the way are followed, `..`
// inside a resolvesPaths mount is lexical, and an absent mount answers a
// null source with its absentReason.

import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

const enc = new TextEncoder();
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/** A backend with a credentialed view (`as`), as a device plane has. */
function plane() {
  const files = new MemoryVFS();
  const views = [];
  files.as = (asCred) => {
    const view = Object.create(files);
    view.asCred = asCred;
    views.push(view);
    return view;
  };
  return { files, views };
}

const root = new MemoryVFS();
root.mkdir('/home', { mode: 0o755 });
root.mkdir('/home/user', { mode: 0o777 });
root.symlink('/pc/docs', '/home/user/docs');
root.writeFile('/home/user/notes.txt', enc.encode('notes'));
const vfs = new CompositeVFS(root);
const pc = plane();
pc.files.mkdir('/docs');
pc.files.mkdir('/b');
let connected = true;
vfs.mount('/pc', () => (connected ? pc.files : null), { resolvesPaths: true, absentReason: () => 'no device connected' });
vfs.mount('/gone', () => null, { absentReason: () => 'the container stopped' });
vfs.mount('/gone/inner', new MemoryVFS());

// A resolvesPaths mount: `..` inside it is lexical, the path is mount-relative.
{
  const route = await vfs.route('/pc/a/../b');
  assert.equal(route.point, '/pc');
  assert.equal(route.path, '/b');
  assert.equal(route.source, pc.files, "the embedder's view is the backend itself");
  assert.equal(route.absentReason, undefined);
}

// A principal's view: the backend as that principal sees it (its `as`), the
// same view the namespace's own operations use.
{
  const view = vfs.as(cred);
  const route = await view.route('/pc/b/f.txt');
  assert.equal(route.path, '/b/f.txt');
  assert.notEqual(route.source, pc.files);
  assert.equal(route.source.asCred, cred, "the source is not the principal's view of the backend");
  await view.writeFile('/pc/b/f.txt', enc.encode('x'));
  assert.equal(pc.views.length, 1, 'route and the operations made different views of the backend');
}

// A path on no mount: the root's source, the path as given (normalized).
{
  const route = await vfs.route('/home/user/./notes.txt');
  assert.deepEqual({ point: route.point, path: route.path }, { point: '/', path: '/home/user/notes.txt' });
  assert.equal(route.source, root);
}

// The mount point itself is the backend's root.
{
  const route = await vfs.route('/pc');
  assert.deepEqual({ point: route.point, path: route.path }, { point: '/pc', path: '/' });
}

// A root link on the way is followed as an operation follows it: a write
// through /home/user/docs lands on the device.
{
  const through = await vfs.route('/home/user/docs/report.md');
  assert.deepEqual({ point: through.point, path: through.path }, { point: '/pc', path: '/docs/report.md' });
  // The last component is followed only with `follow`.
  const link = await vfs.route('/home/user/docs');
  assert.deepEqual({ point: link.point, path: link.path }, { point: '/', path: '/home/user/docs' });
  const followed = await vfs.route('/home/user/docs', { follow: true });
  assert.deepEqual({ point: followed.point, path: followed.path }, { point: '/pc', path: '/docs' });
}

// An absent source answers null, with the mount's absentReason.
{
  connected = false;
  const route = await vfs.route('/pc/b');
  assert.deepEqual(route, { point: '/pc', source: null, path: '/b', absentReason: 'no device connected' });
  connected = true;
}

// Rule 1: a live mount under an absent one is unreachable; the route is the
// absent mount's.
{
  const route = await vfs.route('/gone/inner/x');
  assert.deepEqual(route, { point: '/gone', source: null, path: '/inner/x', absentReason: 'the container stopped' });
}

// A lookup the operation would refuse is refused here, as that operation's error.
await assert.rejects(vfs.route('/home/missing/x'), (error) => error.code === 'ENOENT' && /route '\/home\/missing\/x'/.test(error.message));
await assert.rejects(vfs.route('/home/user/notes.txt/x'), (error) => error.code === 'ENOTDIR');

console.log('composite route: ok');
