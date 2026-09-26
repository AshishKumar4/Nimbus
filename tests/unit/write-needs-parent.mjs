#!/usr/bin/env bun
// Creating a file never creates its directory: open(O_CREAT) under a missing
// parent is ENOENT, whoever asks (the workspace's fs, a shell redirect, tee,
// a process's bridge, on SQLite or on a mount). `createParents` is the one
// explicit mkdir -p. Before, writeFile and redirects made the parents.
import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { readText } from '../../packages/core/src/vfs/vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
ws.filesystem.vfs.mount('/mnt/m', new MemoryVFS({ uid: 1000, gid: 1000 }));
const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);

for (const dir of ['/home/user', '/mnt/m']) {
  assert.equal(await code(() => ws.fs.writeFile(`${dir}/a/b/x.txt`, 'hi')), 'ENOENT', `${dir}: writeFile`);
  assert.equal(await code(() => ws.fs.writeFile(`${dir}/c/d/y.txt`, 'hi', { mode: 0o644 })), 'ENOENT', `${dir}: writeFile with a mode`);
  assert.equal(await ws.fs.stat(`${dir}/a`), null, `${dir}: no parent was made`);
  assert.equal(await ws.fs.stat(`${dir}/c`), null);

  const r = await ws.exec(`echo hi > ${dir}/g/h.txt; echo rc=$?; printf x | tee ${dir}/t/f ${dir}/tee.txt; s=$?; echo; echo tee=$s`);
  assert.equal(r.stdout, 'rc=1\nx\ntee=1\n', `${dir}: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`${dir}/g/h.txt: No such file or directory`));
  assert.match(r.stderr, new RegExp(`tee: ${dir}/t/f: No such file or directory`));
  assert.equal(await readText(ws.fs, `${dir}/tee.txt`), 'x', 'tee still writes the files it can');
  assert.equal(await ws.fs.stat(`${dir}/g`), null);

  // A process's bridge: the same, unless it asks for its parents.
  const fs = ws.filesystem.bind({ pid: dir === '/mnt/m' ? 71 : 70, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  assert.equal(await code(() => fs.writeFile(`${dir}/p/q.txt`, 'x')), 'ENOENT');
  assert.equal(await code(() => fs.open(`${dir}/p/q.txt`, { write: true, create: true })), 'ENOENT');
  await fs.writeFile(`${dir}/p/q.txt`, 'x', { createParents: true });
  assert.equal(await readText(ws.fs, `${dir}/p/q.txt`), 'x');
}

await ws.close();
console.log('write-needs-parent: ok');
