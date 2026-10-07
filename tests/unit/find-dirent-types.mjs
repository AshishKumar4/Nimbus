#!/usr/bin/env bun
// readdir's entry types are exact, as d_type is: a device is a character
// device, not a file, and a backend that cannot tell says 'unknown'. So find
// answers -type from the listing, as GNU does with d_type, and stats only
// the entries their backend could not type.
//
// The mounts here answer every readdir and stat through a proxy that counts
// the stats by the path asked for (the composite resolves each component of
// a path with a stat of its own, so a directory's stats are counted too; a
// regular file's are what -type must not cost).

import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { createFs } from '../../packages/core/src/substrate/lifo/node-compat/fs.ts';
import { synchronousFilesystem } from '../../packages/core/src/substrate/lifo/node-compat/filesystem.ts';
import { createRimraf } from '../../packages/core/src/substrate/lifo/node-compat/rimraf.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processBridge } from './lib/process-bridge.mjs';
import { complete } from '../../packages/core/src/substrate/lifo/shell/completer.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const view = new ProcessView(ws.filesystem.bind({ pid: ws.shellProcessPid, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } }));

// ── /dev lists its devices as character devices ────────────────────────────
{
  const devices = await view.readdir('/dev');
  const nul = devices.find((entry) => entry.name === 'null');
  assert.equal(nul?.type, 'character', '/dev/null is a character device in its listing');
  const typed = await ws.exec('find /dev -maxdepth 1 -name null -type c; find /dev -maxdepth 1 -name null -type f; find /dev/null -printf "%y\\n"');
  assert.deepEqual([typed.stdout, typed.exitCode], ['/dev/null\nc\n', 0]);
}

/** A MemoryVFS tree, 3 levels of 4 directories with 5 files each, mounted at `at` behind a counting proxy. */
function mountTree(at, retype) {
  const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
  const fill = (dir, level) => {
    for (let i = 0; i < 5; i++) backing.writeFile(`${dir}/f${i}`, new Uint8Array(1));
    if (level === 2) return;
    for (let i = 0; i < 4; i++) {
      backing.mkdir(`${dir}/d${i}`);
      fill(`${dir}/d${i}`, level + 1);
    }
  };
  fill('', 0);
  const stats = [];
  const mount = new Proxy(backing, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'stat') return async (...args) => { stats.push(args[0]); return value.apply(target, args); };
      if (key === 'readdir') return async (...args) => retype(value.apply(target, args));
      return value.bind(target);
    },
    has(target, key) { return key !== 'sync' && key in target; },
  });
  ws.filesystem.vfs.mount(at, mount);
  return stats;
}
const isFile = (path) => /\/f\d$/.test(path);

// ── -type f reads the listing, and stats no regular file ───────────────────
{
  const stats = mountTree('/typed', (entries) => entries);
  const files = await ws.exec('find /typed -type f | wc -l');
  assert.equal(files.stdout.trim(), String(5 * (1 + 4 + 16)));
  assert.deepEqual(stats.filter(isFile), [], '-type f stats no file');
  stats.length = 0;
  const printed = await ws.exec('find /typed -printf "%y %p\\n" | grep -c "^f "');
  assert.equal(printed.stdout.trim(), '105');
  assert.deepEqual(stats.filter(isFile), [], '%y stats no file');
}

// ── A backend that cannot type its entries: each is stat'ed, once, and only it ──
{
  const stats = mountTree('/untyped', (entries) => entries.map((entry) => ({ name: entry.name, type: 'unknown' })));
  const quick = await ws.exec('find /untyped -type f | sort');
  const statted = new Set(stats.filter(isFile));
  assert.equal(quick.stdout.split('\n').filter(Boolean).length, 105, 'every file found');
  assert.equal(statted.size, 105, 'each untyped file is stat\'ed');
  const directories = await ws.exec('find /untyped -type d | wc -l');
  assert.equal(directories.stdout.trim(), String(1 + 4 + 16), 'and every directory is entered');
  const serial = await ws.exec("find /untyped -type f -print -o -false -exec true ';' | sort");
  assert.equal(quick.stdout, serial.stdout, 'the same with read-ahead and without');

  // The typed tree costs no file stat for the same answer.
  const typed = await ws.exec('find /typed -type f | sed s,^/typed,, | sort');
  assert.equal(typed.stdout, quick.stdout.replaceAll('/untyped', ''));
}

// ── Every other command that decides by an entry's type asks lstat of an untyped one ──
{
  const untyped = await ws.exec('tree -L 5 /untyped');
  const typed = await ws.exec('tree -L 5 /typed');
  assert.equal(untyped.stdout.split('\n').at(-2), '20 directories, 105 files', 'tree walks an untyped directory as a directory');
  assert.equal(untyped.stdout.replace(/^\/untyped/, ''), typed.stdout.replace(/^\/typed/, ''), 'and draws the tree a typed listing gives');
  const completion = await complete({
    line: 'cd /untyped/', cursorPos: 'cd /untyped/'.length, cwd: '/', env: {}, vfs: view, registry: ws.registry, builtinNames: [],
  });
  assert.deepEqual(completion.completions, ['/untyped/d0/', '/untyped/d1/', '/untyped/d2/', '/untyped/d3/'], 'cd completes untyped directories');
}

// ── Node's Dirent says what d_type says, and stats only where it cannot ────
{
  const stats = [];
  const fs = createFs({
    readdir: () => [{ name: 'null', type: 'character' }, { name: 'link', type: 'symlink' }, { name: 'u', type: 'unknown' }],
    lstat: (path) => { stats.push(path); return { type: 'directory' }; },
  }, '/');
  const [nul, link, unknown] = fs.readdirSync('/dev', { withFileTypes: true });
  assert.deepEqual([nul.isCharacterDevice(), nul.isFile(), link.isSymbolicLink(), unknown.isDirectory()], [true, false, true, true]);
  assert.deepEqual(stats, ['/dev/u']);
}

// ── Node's Dirent over the real bridge: an untyped link is a link, dangling or not ──
{
  const bridgeHarness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(bridgeHarness.sql, bridgeHarness.ctx);
  const kernel = rawVfs.as(CRED_KERNEL);
  kernel.mkdir('links/target', { recursive: true });
  kernel.symlink('target', 'links/to-dir');
  kernel.symlink('nowhere', 'links/dangling');
  const bridge = processBridge(rawVfs, CRED_KERNEL);
  // The bridge as a mount that cannot type its entries would answer.
  const untyped = new Proxy(bridge, {
    get(target, key) {
      if (key === 'synchronous') return untyped;
      if (key === 'readdir') return (path, options) => target.readdir(path, options).map((entry) => ({ name: entry.name, type: 'unknown' }));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const filesystem = synchronousFilesystem({ process: untyped })();
  const nodeFs = createFs(filesystem, '/');
  const byName = Object.fromEntries(nodeFs.readdirSync('/links', { withFileTypes: true }).map((d) => [d.name, [d.isSymbolicLink(), d.isDirectory(), d.isFile()]]));
  assert.deepEqual(byName, {
    dangling: [true, false, false],
    target: [false, true, false],
    'to-dir': [true, false, false],
  }, 'an untyped link is lstat\'ed: a link to a directory is a link, and a dangling one does not fail the listing');
  assert.equal(nodeFs.lstatSync('/links/to-dir').isSymbolicLink(), true, 'lstatSync does not follow the link');
  assert.equal(nodeFs.statSync('/links/to-dir').isDirectory(), true, 'statSync does');
  createRimraf(filesystem, '/').sync('/links/dangling');
  assert.deepEqual(kernel.readdir('links').map((entry) => entry.name).sort(), ['target', 'to-dir'], 'rimraf removes a dangling link');
  createRimraf(filesystem, '/').sync('/links/to-dir');
  assert.deepEqual(kernel.readdir('links').map((entry) => entry.name), ['target'], 'and a link to a directory, not what it leads to');
}

await ws.close();
console.log('find-dirent-types: readdir types devices exactly; find stats only what its backend cannot type');
