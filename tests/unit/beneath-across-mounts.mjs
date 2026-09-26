#!/usr/bin/env bun
// SECURITY: a beneath-rooted path (a WASI preopen, openat with
// RESOLVE_BENEATH) never leaves its root, whatever mounts the namespace has.
// Under a directory that is an ancestor of a mount, `..`, an absolute link
// and a link to `..` inside the mount are each ENOTCAPABLE when they would
// escape (the reviewer's qr2/beneath.mjs read the file outside).

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

const enc = new TextEncoder();
const pc = new MemoryVFS({ uid: 1000, gid: 1000 });
pc.writeFile('/note', enc.encode('mounted'));
pc.symlink('/home/user/secret', '/abs');
pc.symlink('../../secret', '/up');
pc.symlink('note', '/near');
pc.mkdir('/sub');
pc.symlink('..', '/sub/parent');
const box = await testBox({ mounts: { '/home/user/proj/pc': pc } });
box.root.mkdir('home/user/proj', { recursive: true });
box.root.chown('home/user/proj', 1000, 1000);
box.root.writeFile('home/user/secret', 'OUTSIDE THE PREOPEN');
const proc = box.files.bind({ pid: 42, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
const read = (root, path) => {
  try {
    const bytes = proc.readFile({ root, path, beneath: true });
    return bytes === null ? null : new TextDecoder().decode(bytes);
  } catch (error) {
    return error.code;
  }
};

// Inside the root: allowed, mounts and links on them included.
assert.equal(read('/home/user/proj', 'pc/note'), 'mounted');
assert.equal(read('/home/user/proj', 'pc/near'), 'mounted');
assert.equal(read('/home/user/proj', 'pc/sub/parent/note'), 'mounted', 'a link to .. that stays inside');
assert.equal(read('/home/user/proj/pc', 'sub/../note'), 'mounted');

// Every escape is refused.
for (const [root, path] of [
  ['/home/user/proj', '../secret'],
  ['/home/user/proj', 'pc/../../secret'],
  ['/home/user/proj/pc', '../../secret'],
  ['/home/user/proj/pc', '../note'],
  ['/home/user/proj', 'pc/abs'],
  ['/home/user/proj', 'pc/up'],
  ['/home/user/proj/pc', 'sub/parent/../x'],
  ['/home/user/proj/pc', 'up'],
]) {
  assert.equal(read(root, path), 'ENOTCAPABLE', `beneath ${root}: ${path}`);
}

box.destroy();
console.log('beneath-across-mounts: ok');
