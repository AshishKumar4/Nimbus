#!/usr/bin/env bun
// A WASI guest reads a mount whose backend resolves its own paths (Kinu's
// ask 10, MountOptions.resolvesPaths). A device shows only the directory its
// user consented to: a stat of anything above /home/me is EACCES. The walk
// beneath a WASI preopen (walkBeneath, VFS-COMP-006) stat-ed every component,
// so python3, ruby and the wasm shell met that refusal at /pc/home and could
// not read the consented file at all. Past the mount point it now hands the
// rest to the backend: nothing there is looked up, searched or read as a link.
//
//   - Real bash and BusyBox over the runner's WASI layer: cat, ls, cd, pwd,
//     test -e and stat on the device.
//   - A process's two faces (the synchronous bridge, and the awaiting face
//     over an asynchronous-only device) resolve the exact call
//     readFile({ root: '', path: 'pc/home/me/f', beneath: true }), a root
//     inside the device, and `..` at that root (still ENOTCAPABLE).
//   - A preopen rooted inside the device hands nothing over: the device
//     would follow a link out of it. Absolute and climbing links there are
//     ENOTCAPABLE; from a preopen holding the mount point, they resolve.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A device over a MemoryVFS: every path outside /home/me is EACCES, the ones above it included. `sync`: it has a synchronous face. */
function device({ sync }) {
  const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
  backing.mkdir('/home/me/safe', { recursive: true });
  backing.writeFile('/home/me/f', enc.encode('hello\n'));
  // Links the device follows from its own root, out of the directory a preopen inside it names.
  backing.writeFile('/home/me/secret', enc.encode('secret\n'));
  backing.symlink('/home/me/secret', '/home/me/safe/out');
  backing.symlink('../secret', '/home/me/safe/up');
  backing.writeFile('/home/me/safe/in', enc.encode('in\n'));
  const calls = [];
  const consented = (path) => path === '/home/me' || path.startsWith('/home/me/');
  const face = (awaited) => new Proxy(backing, {
    get(target, key) {
      if (key === 'sync') return sync && awaited ? face(false) : undefined;
      const value = target[key];
      if (typeof value !== 'function' || key === 'as') return value;
      const run = (...args) => {
        calls.push(`${String(key)} ${args[0]}`);
        if (typeof args[0] === 'string' && !consented(args[0])) throw syscallError('EACCES', String(key), args[0], { detail: 'outside the consented directory' });
        return value.apply(target, args);
      };
      return awaited ? async (...args) => run(...args) : run;
    },
    has(target, key) { return key === 'sync' ? sync && awaited : key in target; },
  });
  return { vfs: face(true), calls };
}

// ── The wasm shell on the device ────────────────────────────────────────────
{
  const pc = device({ sync: true });
  const result = await runScript('cat /pc/home/me/f && ls /pc/home/me && cd /pc/home/me && pwd && cat f && test -e f && echo exists && stat -c %s f', {
    mounts: { '/pc': pc.vfs }, mountOptions: { '/pc': { resolvesPaths: true } },
  });
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'hello\nf\nsafe\nsecret\n/pc/home/me\nhello\nexists\n6\n');
  assert.equal(result.exitCode, 0);
}

// ── A process's faces, beneath a preopen ────────────────────────────────────
for (const [face, sync] of [['synchronous', true], ['awaiting', false]]) {
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const pc = device({ sync });
  files.vfs.mount('/pc', pc.vfs, { resolvesPaths: true });
  const bound = files.bind({ pid: 7, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  const fs = face === 'synchronous' ? bound.synchronous : bound;
  const beneath = (root, path) => ({ root, path, beneath: true });
  assert.equal(dec.decode(await fs.readFile(beneath('', 'pc/home/me/f'))), 'hello\n', `${face}: the reviewer's call`);
  assert.equal((await fs.stat(beneath('', 'pc/home/me/f'))).size, 6, `${face}: stat`);
  assert.deepEqual((await fs.readdir(beneath('', 'pc/home/me'))).map((entry) => entry.name).sort(), ['f', 'safe', 'secret'], `${face}: readdir`);
  assert.equal(dec.decode(await fs.readFile(beneath('pc/home/me', 'f'))), 'hello\n', `${face}: a preopen inside the device`);
  await assert.rejects(async () => fs.stat(beneath('pc/home/me', '..')), { code: 'ENOTCAPABLE' }, `${face}: .. at the root`);
  // A preopen inside the device is walked from its root, links read: the
  // device would follow these out of it (review of 0fc74b66e).
  assert.equal(dec.decode(await fs.readFile(beneath('pc/home/me/safe', 'in'))), 'in\n', `${face}: a file beneath that preopen`);
  assert.ok(!pc.calls.some((call) => / \/home$/.test(call)), `${face}: no stat of /home: ${pc.calls.join(', ')}`);
  // A link read there leads from the namespace's `/`, where this device refuses /pc/home.
  for (const link of ['out', 'up']) {
    await assert.rejects(async () => fs.readFile(beneath('pc/home/me/safe', link)), { code: 'EACCES' }, `${face}: ${link} is refused`);
  }
  await files.releaseProcess(7);
  harness.db.close();
}

// ── A sibling of a mount nested in the device ───────────────────────────────
// A mount nested at /pc/home/me/inner makes /pc/home a directory on the way
// to it. A lookup that stays on the device (/pc/home/me/f) is the device's
// alone: no face asks it for /pc/home (review of aa68fc27a). The way into the
// nested mount is still searched, and this device refuses /pc/home.
for (const [face, sync] of [['synchronous', true], ['awaiting', false]]) {
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const pc = device({ sync });
  files.vfs.mount('/pc', pc.vfs, { resolvesPaths: true });
  const inner = new MemoryVFS({ uid: 1000, gid: 1000 });
  inner.writeFile('/x', enc.encode('inner\n'));
  files.vfs.mount('/pc/home/me/inner', inner);
  const bound = files.bind({ pid: 11, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  const fs = face === 'synchronous' ? bound.synchronous : bound;
  assert.equal(dec.decode(await files.vfs.readFile('/pc/home/me/f')), 'hello\n', `${face}: the namespace`);
  assert.equal(dec.decode(await fs.readFile('/pc/home/me/f')), 'hello\n', `${face}: the process's own path walk`);
  assert.equal(dec.decode(await fs.readFile({ root: '', path: 'pc/home/me/f', beneath: true })), 'hello\n', `${face}: beneath a preopen`);
  assert.ok(!pc.calls.some((call) => / \/home$/.test(call)), `${face}: no face asks the device for /home: ${pc.calls.join(', ')}`);
  await assert.rejects(files.vfs.readFile('/pc/home/me/inner/x'), { code: 'EACCES' }, `${face}: the way into the nested mount is searched`);
  await files.releaseProcess(11);
  harness.db.close();
}

// ── A preopen inside a resolvesPaths mount hands nothing over ───────────────
// The backend follows /safe/out -> /secret and /safe/up -> ../secret in its
// own tree, out of a preopen at /pc/safe: handed '/safe/out' whole, it
// returned the secret through both faces (review of 0fc74b66e).
for (const [face, sync] of [['synchronous', true], ['awaiting', false]]) {
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
  backing.mkdir('/safe/sub', { recursive: true });
  backing.writeFile('/secret', enc.encode('secret\n'));
  backing.writeFile('/safe/sub/in', enc.encode('in\n'));
  backing.symlink('/secret', '/safe/out');
  backing.symlink('../secret', '/safe/up');
  backing.symlink('sub/in', '/safe/near');
  const awaitingOnly = new Proxy(backing, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = target[key];
      return typeof value === 'function' && key !== 'as' ? async (...args) => value.apply(target, args) : value;
    },
    has(target, key) { return key !== 'sync' && key in target; },
  });
  files.vfs.mount('/pc', sync ? backing : awaitingOnly, { resolvesPaths: true });
  const bound = files.bind({ pid: 9, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  const fs = face === 'synchronous' ? bound.synchronous : bound;
  const beneath = (root, path) => ({ root, path, beneath: true });
  for (const link of ['out', 'up']) {
    await assert.rejects(async () => fs.readFile(beneath('pc/safe', link)), { code: 'ENOTCAPABLE' }, `${face}: ${link} leads out of the preopen`);
  }
  assert.equal(dec.decode(await fs.readFile(beneath('pc/safe', 'near'))), 'in\n', `${face}: a link that stays beneath it resolves`);
  assert.equal(dec.decode(await fs.readFile(beneath('pc/safe', 'sub/in'))), 'in\n', `${face}: and so does a plain path`);
  // A preopen that holds the mount point: whatever the backend follows stays in its tree, beneath it.
  assert.equal(dec.decode(await fs.readFile(beneath('pc', 'safe/out'))), 'secret\n', `${face}: the whole mount as the preopen`);
  assert.equal(dec.decode(await fs.readFile(beneath('', 'pc/safe/up'))), 'secret\n', `${face}: the namespace as the preopen`);
  await files.releaseProcess(9);
  harness.db.close();
}

console.log('wasi-resolves-paths: a WASI guest reads the device past what it refuses');
