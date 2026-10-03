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

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A device over a MemoryVFS: every path outside /home/me is EACCES, the ones above it included. `sync`: it has a synchronous face. */
function device({ sync }) {
  const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
  backing.mkdir('/home/me', { recursive: true });
  backing.writeFile('/home/me/f', enc.encode('hello\n'));
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
  assert.equal(result.stdout, 'hello\nf\n/pc/home/me\nhello\nexists\n6\n');
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
  assert.deepEqual((await fs.readdir(beneath('', 'pc/home/me'))).map((entry) => entry.name), ['f'], `${face}: readdir`);
  assert.equal(dec.decode(await fs.readFile(beneath('pc/home/me', 'f'))), 'hello\n', `${face}: a preopen inside the device`);
  await assert.rejects(async () => fs.stat(beneath('pc/home/me', '..')), { code: 'ENOTCAPABLE' }, `${face}: .. at the root`);
  assert.ok(!pc.calls.some((call) => / \/home$/.test(call)), `${face}: no stat of /home: ${pc.calls.join(', ')}`);
  await files.releaseProcess(7);
  harness.db.close();
}

console.log('wasi-resolves-paths: a WASI guest reads the device past what it refuses');
