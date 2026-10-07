#!/usr/bin/env bun
// `git add -A` holds, for each file it stages, a few bytes beyond the index
// itself: the new entries as their bytes, nothing per file as objects. As
// objects, an entry (its path and id as strings, its stat), its sort key and
// its encoded piece were all alive as the index was encoded: about 900 bytes
// a file, 80 MiB at Linux's 96,000 files, over a Durable Object's 128 MiB
// with the two copies of the index.
//
// Measured where it peaks: the heap is collected and read as the index's
// checksum is taken (the moment the whole new index exists, and whatever
// staging and encoding hold is still alive), and on every 512th filesystem
// call. Two sizes, 2,000 and 20,000 files (far enough apart that the noise
// of a peak, a few hundred KiB, is a few bytes a file), every file new (no
// index, as after `git init` in a full directory) and then every file
// changed; the growth between them, less the
// two indexes' own growth (the one read, the one written), is what each file
// costs. It may be 256 bytes; the staged result agrees with real git's. And
// at the small size the peak beyond the indexes may be 8 MiB: what does not
// grow with the files (the waves its objects go in, two at most) stays
// small (each object of a wave once held deflate's 16 KiB buffer: 22 MiB).
// NIMBUS_GIT_ADD_HEAP_LARGE=96000 measures it at Linux's size.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';

const SIZES = [2_000, Number(process.env.NIMBUS_GIT_ADD_HEAP_LARGE) || 20_000];
const PER_FILE = 256;
const FIXED = 8 * 1024 * 1024;

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-add-heap-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

const ENV = {
  HOME: '/home/user', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
};
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_CEILING_DIRECTORIES: tmpdir(), ...ENV, HOME: '/nonexistent' };

function realGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString('latin1');
}

/** The checksum of an index file ('DIRC'...) is taken as it is read and as it is written: `onIndex` is called then. */
let onIndex = null;
const hashProto = Object.getPrototypeOf(createHash('sha1'));
const update = hashProto.update;
hashProto.update = function (data, encoding) {
  if (onIndex && data instanceof Uint8Array && data.length >= 12 && data[0] === 0x44 && data[1] === 0x49 && data[2] === 0x52 && data[3] === 0x43) onIndex();
  return update.call(this, data, encoding);
};

function newVfs() {
  const db = new Database(':memory:');
  const sql = {
    exec(query, ...params) {
      const prepared = db.query(query);
      if (prepared.columnNames.length === 0) {
        db.run(query, ...params);
        return [];
      }
      return prepared.all(...params);
    },
  };
  const vfs = new SqliteVFS(sql, { storage: { transactionSync: (callback) => db.transaction(callback)() } });
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  return vfs;
}

/** `count` files, two to a directory four levels deep, as the worktree scale test lays them out. */
const pathOf = (i) => {
  const d = Math.floor(i / 2);
  return `src/a${d % 16}/b${Math.floor(d / 16) % 64}/c${Math.floor(d / 1024)}/f${i}.txt`;
};

async function measure(count) {
  const disk = join(scratch, `repo-${count}`);
  mkdirSync(disk);
  realGit(disk, 'init', '-q', '-b', 'main');
  const vfs = newVfs();
  const user = vfs.as(CRED_SESSION_USER);
  const root = `home/user/repo-${count}`;
  user.mkdir(root, { recursive: true });
  const write = (i, content) => {
    const file = pathOf(i);
    mkdirSync(join(disk, file, '..'), { recursive: true });
    writeFileSync(join(disk, file), content);
    user.mkdir(`${root}/${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
    user.writeFile(`${root}/${file}`, content);
  };
  for (let i = 0; i < count; i++) write(i, `file ${i}\n${'x'.repeat(i % 97)}\n`);

  const view = new ProcessFiles(vfs).view({ pid: 1, cred: CRED_SESSION_USER });
  let calls = 0;
  let peak = 0;
  const sample = () => {
    Bun.gc(true);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  };
  const observed = new Proxy(view, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (++calls % 512 === 0) sample();
        return value.apply(target, args);
      };
    },
  });
  const git = async (...args) => {
    let stderr = '';
    let stdout = '';
    const code = await runGitCommand({
      pid: 1, cred: CRED_SESSION_USER, args, cwd: `/${root}`, env: ENV,
      stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString('latin1'); } },
      stderr: { write(s) { stderr += s; } },
      vfs: observed,
    }, vfs);
    assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
    return stdout;
  };
  const indexSize = () => { try { return user.stat(`${root}/.git/index`).size; } catch { return 0; } };
  /** add -A's peak over the heap before it, and the index it read and the one it wrote. */
  const add = async () => {
    const read = indexSize();
    Bun.gc(true);
    const base = process.memoryUsage().heapUsed;
    peak = base;
    onIndex = sample;
    const started = performance.now();
    try { await git('add', '-A'); } finally { onIndex = null; }
    const ms = Math.round(performance.now() - started);
    sample();
    return { peak: peak - base, read, written: indexSize(), ms };
  };

  await git('init', '-q');
  const fresh = await add();
  realGit(disk, 'add', '-A');
  assert.equal(await git('ls-files', '-s'), realGit(disk, 'ls-files', '-s'), `${count}: every file new, staged as real git stages it`);
  await git('commit', '-q', '-m', 'seed');
  for (let i = 0; i < count; i++) write(i, `changed ${i}\n`);
  const changed = await add();
  realGit(disk, 'add', '-A');
  assert.equal(await git('ls-files', '-s'), realGit(disk, 'ls-files', '-s'), `${count}: every file changed, staged as real git stages it`);
  return { count, fresh, changed };
}

// A first, small add pays what a process pays once (modules, caches), so neither size measured carries it.
await measure(200);
const [small, large] = [await measure(SIZES[0]), await measure(SIZES[1])];
const MB = 1024 * 1024;
for (const kind of ['fresh', 'changed']) {
  const a = small[kind];
  const b = large[kind];
  const files = large.count - small.count;
  // The index read and the one written are each the index's size: what remains is the staging's own.
  const indexes = (b.read - a.read) + (b.written - a.written);
  const perFile = (b.peak - a.peak - indexes) / files;
  console.log(`  add -A, every file ${kind === 'fresh' ? 'new' : 'changed'}: peak +${(a.peak / MB).toFixed(1)} MiB at ${small.count}, `
    + `+${(b.peak / MB).toFixed(1)} MiB at ${large.count} (${b.ms} ms); indexes ${(b.written / MB).toFixed(1)} MiB; ${perFile.toFixed(0)} bytes a file beyond them`);
  assert.ok(perFile <= PER_FILE, `add -A, every file ${kind}: ${perFile.toFixed(0)} bytes a file beyond the indexes (allowed ${PER_FILE})`);
  const fixed = a.peak - a.read - a.written;
  assert.ok(fixed <= FIXED, `add -A, every file ${kind}: ${(fixed / MB).toFixed(1)} MiB beyond the indexes at ${small.count} files (allowed ${FIXED / MB})`);
}
console.log(`git-add-heap: add -A holds at most ${PER_FILE} bytes a staged file beyond the index, every file new or changed; staged as real git`);
