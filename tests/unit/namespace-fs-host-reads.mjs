#!/usr/bin/env bun
// Host code that reads user paths in one turn (running ./script, the
// esbuild service) reads the namespace: a script or source on an embedder's
// mount is found and run, exactly as one in SQLite, never refused as absent.

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const enc = new TextEncoder();
const tools = new MemoryVFS({ uid: 1000, gid: 1000 });
tools.writeFile('/hello.sh', enc.encode('echo from the mount\n'), { mode: 0o755 });
tools.chmod('/hello.sh', 0o755);
tools.symlink('hello.sh', '/linked');
const box = await testBox({ mounts: { '/mnt/tools': tools } });

// This workspace has no `sh` (the wasm runtimes need facets), so a found
// script stops at its interpreter; one that was not found is "not found".
const direct = await box.commands.run('/mnt/tools/hello.sh');
assert.match(direct.stderr, /^\/mnt\/tools\/hello\.sh: sh: bad interpreter/, 'found on the mount and its head read');
const viaLink = await box.commands.run('cd /mnt/tools && ./linked');
assert.match(viaLink.stderr, /bad interpreter/, 'a link on the mount resolves in the namespace');
assert.match((await box.commands.run('/mnt/tools/none.sh')).stderr, /No such file or directory|not found/);
assert.equal((await box.commands.run('/mnt/tools')).exitCode, 126, 'a mounted directory is not run');

// A directory above a mount is the namespace's: it lists the mount and cd works.
const above = await box.commands.run('cd /mnt && ls');
assert.equal(above.exitCode, 0, above.stderr);
assert.match(above.stdout, /\btools\b/);
// A SQLite row a mount covers is never followed, even a link.
box.root.mkdir('mnt/tools', { recursive: true });
box.root.symlink('/etc', 'mnt/tools/escape');
assert.equal((await box.commands.run('ls /mnt/tools/escape')).exitCode, 1, 'the covered link is not there');

// The synchronous namespace view host code gets: SQLite and mounts alike.
const ns = box.files.namespaceFs(CRED_KERNEL);
assert.equal(ns.readFileString('/mnt/tools/hello.sh'), 'echo from the mount\n');
assert.equal(ns.isDirectory('/mnt/tools'), true);
assert.equal(ns.exists('home/user'), true, 'a storage key without the slash');
assert.throws(() => ns.stat('/mnt/tools/none'), { code: 'ENOENT' });
assert.equal(ns.exists('/mnt/tools/hello.sh/under'), false, 'through a file is a miss');
assert.equal(ns.resolveSymlink('/mnt/tools/linked'), 'mnt/tools/hello.sh');
assert.equal(box.files.namespaceFs(CRED_KERNEL), ns, 'one per credential');

box.destroy();
console.log('namespace-fs-host-reads: ok');
