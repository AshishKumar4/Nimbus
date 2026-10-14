#!/usr/bin/env bun
/**
 * The shell's built-in node's fs.watch hears the process's namespace
 * (VFS-2b), as Node's does: 'rename' when an entry appears or goes,
 * 'change' when one changes, named from the watched directory (its direct
 * entries; any depth when recursive) or as the watched file, and nothing
 * once closed. It watched the whole filesystem coarsely, through a watch of
 * the root that never fired; a program that watches stays until it closes
 * its watch, as Node keeps it.
 */

import assert from 'node:assert/strict';
import { Buffer } from '../../packages/core/src/substrate/lifo/node-compat/buffer.ts';
import { createFs } from '../../packages/core/src/substrate/lifo/node-compat/fs.ts';
import { synchronousFilesystem } from '../../packages/core/src/substrate/lifo/node-compat/filesystem.ts';
import { isHostEvent } from '../../packages/core/src/substrate/lifo/commands/system/node-realm.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { hostSqlite } from './lib/host-sqlite.mjs';

const failed = [];
let checks = 0;
const check = async (name, run) => {
  checks++;
  try { await run(); } catch (error) { failed.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 4).join(' | ')}`); }
};

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
kernel.mkdir('w/d', { recursive: true });
kernel.writeFile('w/watched.txt', 'w');
const files = new ProcessFiles(rawVfs);
const fs = createFs(synchronousFilesystem({ process: files.bind({ pid: 4301, cred: CRED_KERNEL }) })(), '/');
/** Node tells a watch's changes on a later turn. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const hearing = (path, options) => {
  const heard = [];
  const watcher = fs.watch(path, options ?? {}, (type, name) => heard.push(`${type} ${name}`));
  return { heard, watcher };
};

await check('a directory\'s direct entries, as Node names them', async () => {
  const { heard, watcher } = hearing('/w');
  kernel.writeFile('w/a.txt', 'a');
  kernel.writeFile('w/a.txt', 'b');
  kernel.writeFile('w/d/deep.txt', 'deep');
  kernel.rename('w/a.txt', 'w/b.txt');
  kernel.unlink('w/b.txt');
  kernel.writeFile('elsewhere.txt', 'e');
  await settled();
  watcher.close();
  kernel.writeFile('w/after-close.txt', 'c');
  await settled();
  assert.deepEqual(heard, ['rename a.txt', 'change a.txt', 'rename a.txt', 'rename b.txt', 'rename b.txt']);
});

await check('recursive: every entry under it, named from it', async () => {
  const { heard, watcher } = hearing('/w', { recursive: true });
  kernel.writeFile('w/d/deeper.txt', 'x');
  await settled();
  watcher.close();
  assert.deepEqual(heard, ['rename d/deeper.txt']);
});

await check('a file: itself, by its own name', async () => {
  const { heard, watcher } = hearing('/w/watched.txt');
  kernel.writeFile('w/watched.txt', 'changed');
  kernel.writeFile('w/other.txt', 'o');
  await settled();
  watcher.close();
  assert.deepEqual(heard, ['change watched.txt']);
});

await check('close is idempotent, deferred, and suppresses pending and later changes', async () => {
  const { heard, watcher } = hearing('/w');
  const closed = [];
  let synchronous = true;
  watcher.on('close', () => closed.push(synchronous));
  kernel.writeFile('w/close-pending.txt', 'pending');
  watcher.close();
  watcher.close();
  assert.deepEqual(closed, []);
  synchronous = false;
  await settled();
  kernel.writeFile('w/close-later.txt', 'later');
  watcher.close();
  await settled();
  assert.deepEqual(closed, [false]);
  assert.deepEqual(heard, []);
});

await check('closing in the first callback stops the rest of its batch', async () => {
  const heard = [];
  const watcher = fs.watch('/w', (type, name) => {
    heard.push(`${type} ${name}`);
    watcher.close();
  });
  kernel.writeFile('w/batch-first.txt', 'one');
  kernel.writeFile('w/batch-second.txt', 'two');
  await settled();
  watcher.close();
  assert.deepEqual(heard, ['rename batch-first.txt']);
});

await check('closing in a rename callback suppresses its second name', async () => {
  kernel.writeFile('w/close-rename.txt', 'one');
  const heard = [];
  const watcher = fs.watch('/w', (type, name) => {
    heard.push(`${type} ${name}`);
    watcher.close();
  });
  kernel.rename('w/close-rename.txt', 'w/close-renamed.txt');
  await settled();
  watcher.close();
  assert.deepEqual(heard, ['rename close-rename.txt']);
});

await check('ref and unref return the watcher, also after close', async () => {
  const watcher = fs.watch('/w', { persistent: false });
  try {
    assert.equal(watcher.ref(), watcher);
    assert.equal(watcher.ref(), watcher);
    assert.equal(watcher.unref(), watcher);
    assert.equal(watcher.unref(), watcher);
  } finally { watcher.close(); }
  assert.equal(watcher.ref(), watcher);
  assert.equal(watcher.unref(), watcher);
});

await check('a process subscription stopped in its first callback stops the batch', async () => {
  const heard = [];
  const stop = files.bind({ pid: 4302, cred: CRED_KERNEL }).subscribe('/', (event) => {
    heard.push(event.path);
    stop();
  });
  kernel.writeFile('w/process-first.txt', 'one');
  kernel.writeFile('w/process-second.txt', 'two');
  await settled();
  stop();
  kernel.writeFile('w/process-later.txt', 'three');
  await settled();
  assert.deepEqual(heard, ['w/process-first.txt']);
});

await check('a missing watch target throws ENOENT synchronously with the given path', () => {
  for (const path of ['w/absent.txt', '/w/absent.txt']) {
    assert.throws(() => {
      const watcher = fs.watch(path);
      watcher.close();
    }, {
      message: `ENOENT: no such file or directory, watch '${path}'`,
      code: 'ENOENT', errno: -2, syscall: 'watch', path,
    });
  }
});

await check('a symlink watches its file target under the link name', async () => {
  kernel.writeFile('w/link-target.txt', 'one');
  kernel.symlink('link-target.txt', 'w/link-name.txt');
  const { heard, watcher } = hearing('/w/link-name.txt');
  kernel.writeFile('w/link-target.txt', 'two');
  await settled();
  watcher.close();
  assert.deepEqual(heard, ['change link-name.txt']);
});

await check('a symlink watches its directory target with relative names', async () => {
  kernel.mkdir('w/link-directory');
  kernel.symlink('link-directory', 'w/directory-link');
  const { heard, watcher } = hearing('/w/directory-link');
  kernel.writeFile('w/link-directory/child.txt', 'one');
  await settled();
  watcher.close();
  assert.deepEqual(heard, ['rename child.txt']);
});

await check('renamed files and directories stay watched under their original names', async () => {
  kernel.writeFile('w/moving.txt', 'one');
  const file = hearing('/w/moving.txt');
  kernel.mkdir('w/moving-directory');
  kernel.writeFile('w/moving-directory/child.txt', 'one');
  const directory = hearing('/w/moving-directory');
  try {
    // In one turn: the writes after the renames are told in the same batch, by the names the watches had.
    kernel.rename('w/moving.txt', 'moved.txt');
    kernel.rename('w/moving-directory', 'moved-directory');
    kernel.writeFile('moved.txt', 'two');
    kernel.writeFile('moved-directory/child.txt', 'two');
    await settled();
    assert.deepEqual(file.heard, ['rename moving.txt', 'change moving.txt']);
    assert.deepEqual(directory.heard, ['rename moving-directory', 'change child.txt']);
  } finally { file.watcher.close(); directory.watcher.close(); }
});

await check('a file stays watched through the directories above it renamed twice, then written and removed, in one turn', async () => {
  kernel.mkdir('before/sub', { recursive: true });
  kernel.writeFile('before/sub/file', 'one');
  const file = hearing('/before/sub/file');
  try {
    kernel.rename('before', 'middle');
    kernel.rename('middle', 'after');
    kernel.writeFile('after/sub/file', 'two');
    kernel.unlink('after/sub/file');
    await settled();
    assert.deepEqual(file.heard, ['rename file', 'rename file', 'change file', 'rename file']);
  } finally { file.watcher.close(); }
});

await check('buffer encoding gives listeners and change events UTF-8 Buffers', async () => {
  for (const options of ['buffer', { encoding: 'buffer' }]) {
    const heard = [];
    const emitted = [];
    const watcher = fs.watch('/w', options, (type, name) => heard.push([type, name]));
    watcher.on('change', (type, name) => emitted.push([type, name]));
    kernel.writeFile('w/caf\u00e9.txt', 'one');
    await settled();
    watcher.close();
    assert.equal(heard.length, 1);
    assert.ok(Buffer.isBuffer(heard[0][1]));
    assert.equal(heard[0][1].toString(), 'caf\u00e9.txt');
    assert.deepEqual(emitted, heard);
  }
});

await check('other filename encodings use the UTF-8 filename bytes', async () => {
  for (const options of ['hex', { encoding: 'base64' }]) {
    const { heard, watcher } = hearing('/w/watched.txt', options);
    kernel.writeFile('w/watched.txt', 'encoded');
    await settled();
    watcher.close();
    const encoding = typeof options === 'string' ? options : options.encoding;
    assert.deepEqual(heard, [`change ${Buffer.from('watched.txt').toString(encoding)}`]);
  }
});

await check('an encoding Node does not know is refused at the call, as Node refuses it, not at a change', async () => {
  for (const options of ['bogus', { encoding: 'utf-9' }]) {
    const encoding = typeof options === 'string' ? options : options.encoding;
    assert.throws(() => fs.watch('/w', options, () => {}), {
      name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE', message: `The argument 'encoding' is invalid encoding. Received '${encoding}'`,
    });
    // Before the path is looked at, as Node checks its options first.
    assert.throws(() => fs.watch('/missing', options), { code: 'ERR_INVALID_ARG_VALUE' });
  }
  kernel.writeFile('w/after-refusal.txt', 'x');
  await settled();
});

await check('the realm accepts only complete filesystem change events', () => {
  const changed = (event, id = 1) => ({ type: 'changed', id, event });
  for (const type of ['add', 'change', 'unlink', 'addDir', 'unlinkDir', 'rename']) {
    assert.equal(isHostEvent(changed({ type, path: '/x', timestamp: 1 })), true);
  }
  const valid = { type: 'rename', path: '/x', oldPath: '/y', timestamp: 1 };
  assert.equal(isHostEvent(changed(valid)), true);
  for (const event of [
    { ...valid, oldPath: 42 }, { ...valid, type: 'other' },
    { type: 'change', path: '/x' }, { ...valid, timestamp: '1' }, { ...valid, path: 42 },
  ]) assert.equal(isHostEvent(changed(event)), false, JSON.stringify(event));
  for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1']) {
    assert.equal(isHostEvent(changed(valid, id)), false, String(id));
  }
});

await check('a node program that watches hears its own writes, and stays until it closes the watch', async () => {
  const { sql, transactions } = await hostSqlite();
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
  await ws.fs.mkdir('/home/user/w', { recursive: true });
  await ws.fs.writeFile('/home/user/watch.js', [
    "const fs = require('fs');",
    "const seen = [];",
    "const watcher = fs.watch('/home/user/w', (type, name) => {",
    "  seen.push(type + ' ' + name);",
    "  if (name === 'b.txt') { watcher.close(); console.log(seen.join(',')); }",
    "});",
    "fs.writeFileSync('/home/user/w/a.txt', 'a');",
    "fs.writeFileSync('/home/user/w/b.txt', 'b');",
  ].join('\n'));
  const run = await ws.exec('node watch.js', { cwd: '/home/user', timeout: 10_000 });
  assert.equal(run.stdout, 'rename a.txt,rename b.txt\n', run.stderr);
  assert.equal(run.exitCode, 0);
});

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
await ws.fs.mkdir('/home/user/w', { recursive: true });
const runProgram = async (source, options = {}) => {
  await ws.fs.writeFile('/home/user/watch.js', source.join('\n'));
  return ws.exec('node watch.js', { cwd: '/home/user', timeout: 10_000, ...options });
};

await check('a node program exits with its only watch unrefed, without closing it', async () => {
  const run = await runProgram([
    "const watcher = require('fs').watch('/home/user/w');",
    "console.log(watcher.unref() === watcher, watcher.unref() === watcher);",
  ]);
  assert.equal(run.stdout, 'true true\n', run.stderr);
  assert.equal(run.exitCode, 0, run.stderr);
});

await check('persistent false starts a watch unrefed', async () => {
  const run = await runProgram([
    "require('fs').watch('/home/user/w', { persistent: false });",
    "console.log('done');",
  ]);
  assert.equal(run.stdout, 'done\n', run.stderr);
  assert.equal(run.exitCode, 0, run.stderr);
});

await check('ref keeps a node program for a host write until close, idempotently', async () => {
  let write;
  const run = await runProgram([
    "const fs = require('fs');",
    "const watcher = fs.watch('/home/user/w', { persistent: false }, (type, name) => {",
    "  console.log(type + ' ' + name); watcher.close(); watcher.close();",
    "  watcher.ref(); watcher.unref();",
    "});",
    "console.log(watcher.ref() === watcher, watcher.ref() === watcher);",
    "watcher.on('close', () => console.log('closed'));",
  ], { onStdout: () => { write ??= ws.fs.writeFile('/home/user/w/host-write.txt', 'one'); } });
  await write;
  assert.equal(run.stdout, 'true true\nrename host-write.txt\nclosed\n', run.stderr);
  assert.equal(run.exitCode, 0, run.stderr);
});

await check('unref and closing an unrefed watch do not release another live watch', async () => {
  let write;
  const run = await runProgram([
    "const fs = require('fs');",
    "const keeper = fs.watch('/home/user/w', (type, name) => { console.log(name); keeper.close(); });",
    "const other = fs.watch('/home/user/w');",
    "other.unref(); other.unref(); other.close(); other.close();",
    "console.log('ready');",
  ], { onStdout: () => { write ??= ws.fs.writeFile('/home/user/w/keeper.txt', 'one'); } });
  await write;
  assert.equal(run.stdout, 'ready\nkeeper.txt\n', run.stderr);
  assert.equal(run.exitCode, 0, run.stderr);
});

await check('the node realm watches symlink targets and preserves buffer names', async () => {
  await ws.fs.writeFile('/home/user/target.txt', 'one');
  await ws.fs.symlink('target.txt', '/home/user/link.txt');
  const run = await runProgram([
    "const fs = require('fs');",
    "const watcher = fs.watch('link.txt', 'buffer', (type, name) => {",
    "  console.log(type, Buffer.isBuffer(name), name.toString()); watcher.close();",
    "});",
    "fs.writeFileSync('target.txt', 'two');",
  ]);
  assert.equal(run.stdout, 'change true link.txt\n', run.stderr);
  assert.equal(run.exitCode, 0, run.stderr);
});

console.log(`lifo-node-watch: ${checks - failed.length}/${checks} passed`);
if (failed.length > 0) {
  console.error(failed.join('\n'));
  process.exit(1);
}
console.log('lifo-node-watch: ok');
