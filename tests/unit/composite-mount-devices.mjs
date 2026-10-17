#!/usr/bin/env bun
// Two mounts are two devices, whichever view of the namespace made them: a
// mount made through a principal's view and one made through the root share
// the namespace's table, and st_dev too is the table's to give. Each mount
// here holds one file, the first its backend numbered (the same ino in
// both); their (dev, ino) differ, and a move of one over the other, across
// the two filesystems, replaces the destination as mv(1) does on Linux.
//
// Red before: each view counted devices from 0x10001 on its own, so the two
// mounts were one device, the two files one file by (dev, ino), and the
// move was refused EINVAL ("source and destination are the same file").

import assert from 'node:assert/strict';

import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { move } from '../../packages/core/src/vfs/move.ts';

const USER = { uid: 1000, gid: 1000 };
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const text = (bytes) => new TextDecoder().decode(bytes);

const root = new CompositeVFS(new MemoryVFS(USER));
root.mkdir('/a');
root.mkdir('/b');
const one = new MemoryVFS(USER);
const two = new MemoryVFS(USER);
one.writeFile('/f', new TextEncoder().encode('one'));
two.writeFile('/f', new TextEncoder().encode('two'));
assert.equal(one.stat('/f').ino, two.stat('/f').ino, 'each backend numbers its first file alike');

root.mount('/a', one);
const view = root.as(cred);
view.mount('/b', two);

const a = await root.stat('/a/f');
const b = await view.stat('/b/f');
assert.notEqual(a.dev, b.dev, `two mounts are two devices: ${a.dev}, ${b.dev}`);
assert.notDeepEqual([a.dev, a.ino], [b.dev, b.ino], 'two files are two (dev, ino)');

await move(view, '/a/f', '/b/f');
assert.equal(text(await view.readFile('/b/f')), 'one', 'the move replaced the destination');
assert.equal(await view.stat('/a/f'), null, 'and the source is gone');

console.log('composite-mount-devices: ok');
