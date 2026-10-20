#!/usr/bin/env bun
// @tier slow — builds 2,000- and 20,000-file repositories with real git and mirrors them
// git status holds what its comparisons need of the worktree, not the
// worktree: its heap grows with the index alone, however many files the
// tree has. Status reads the worktree in one ordered scan; holding that scan
// whole (every entry's path, stat and listing row) cost about 0.9 KiB an
// entry: 8.6 to 12.5 MiB of growth from 3,000 to 12,000 files (armada, 3
// runs at 6f04a9229) against 1.5 to 4.4 before it, about 30 MiB on
// next.js's 34,000 files (measured from 3,000 to 24,000 files here: 706
// bytes a file, against 162 with the scan merged as it goes). Here a status
// that compares every entry, at 2,000 and at 20,000 files (the layout
// git-worktree-scale uses, two files a directory), may grow by the index's
// own growth and the pack's page cache, and its growth per file is reported. The heap
// is sampled after a full collection on every 1,024 scanned entries and
// every filesystem call.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';

const MB = 1024 * 1024;

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-status-flat-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C', GIT_CEILING_DIRECTORIES: tmpdir(),
};

function realGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString('latin1');
}

/** A SqliteVFS over bun:sqlite that records nothing (the test harness keeps every statement). */
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

/**
 * The repository: `count` files four levels deep, two to a directory as in
 * next.js (34k files in 17k directories), packed; branch `other` changes 40
 * of them. Directories cost a walk too: a cache tree has a node for each.
 */
function build(disk, count) {
  mkdirSync(disk);
  realGit(disk, 'init', '-q', '-b', 'main');
  const path = (i) => {
    const d = Math.floor(i / 2);
    return `src/a${d % 16}/b${Math.floor(d / 16) % 64}/c${Math.floor(d / 1024)}/f${i}.txt`;
  };
  for (let i = 0; i < count; i++) {
    const file = join(disk, path(i));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `file ${i}\n${'x'.repeat(i % 97)}\n`);
  }
  writeFileSync(join(disk, '.gitignore'), '*.log\nbuild/\n');
  // An empty file and a link: a clean status reads neither (the empty blob's size 0 is no smudge).
  writeFileSync(join(disk, 'src/empty'), '');
  symlinkSync('m0', join(disk, 'src/link'));
  realGit(disk, 'add', '-A');
  realGit(disk, 'commit', '-q', '-m', 'seed');
  realGit(disk, 'gc', '-q', '--prune=now');
  return path;
}

function mirror(user, from, to) {
  user.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const st = lstatSync(src);
    if (st.isDirectory()) mirror(user, src, `${to}/${name}`);
    else if (st.isSymbolicLink()) user.symlink(readlinkSync(src), `${to}/${name}`);
    else {
      user.writeFile(`${to}/${name}`, new Uint8Array(readFileSync(src)));
      user.chmod(`${to}/${name}`, st.mode & 0o777);
    }
  }
}


const SMALL = 2_000;
const LARGE = 20_000;

async function cleanStatusPeak(count) {
  const disk = join(scratch, `repo-${count}`);
  build(disk, count);
  const vfs = newVfs();
  const user = vfs.as(CRED_SESSION_USER);
  const virtual = `/home/user/repo-${count}`;
  mirror(user, disk, virtual.slice(1));
  const files = new ProcessFiles(vfs);
  let peak = 0;
  // Only the measured status samples: a full collection on each of the first status's 20,000 file reads is minutes.
  let measuring = false;
  const sample = () => {
    if (!measuring) return;
    Bun.gc(true);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  };
  const view = files.view({ pid: 1, cred: CRED_SESSION_USER });
  const observed = new Proxy(view, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key === 'scan') {
        return async function* (...args) {
          let n = 0;
          for await (const entry of value.apply(target, args)) {
            if (++n % 1024 === 0) sample();
            yield entry;
          }
          sample();
        };
      }
      return (...args) => { sample(); return value.apply(target, args); };
    },
  });
  // The heap before any git ran: what a status holds is measured from it, what an earlier one kept included.
  Bun.gc(true);
  const base = process.memoryUsage().heapUsed;
  const status = async (measured) => {
    measuring = measured;
    let stdout = '';
    let stderr = '';
    peak = base;
    const code = await runGitCommand({
      pid: 1, cred: CRED_SESSION_USER, args: ['status', '--porcelain'], cwd: virtual,
      env: { HOME: '/home/user', NIMBUS_GIT_COUNTERS: '1' },
      stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString('latin1'); } },
      stderr: { write(s) { stderr += s; } },
      vfs: observed,
    }, vfs);
    sample();
    measuring = false;
    assert.equal(code, 0, stderr);
    assert.equal(stdout, realGit(disk, 'status', '--porcelain'), `${count} files: status as git's`);
    const counters = JSON.parse(/\[git\] (\{.*\})/.exec(stderr)?.[1] ?? '{}');
    return { growth: (peak - base) / MB, counters };
  };
  // The first status refreshes the mirrored index's stat. The next, a second later, compares every entry
  // (those written in the index's second were racily clean) and writes the index again: the one measured.
  // (A status after that, with nothing changed since the index, compares nothing.)
  await status(false);
  await Bun.sleep(1100);
  const { growth, counters } = await status(true);
  // What is measured is the scan's walk: one scan of every entry, nothing asked by name.
  assert.ok(counters.scans === 1 && counters.lstats === 0 && counters.scanned >= count, `${count} files: status read one scan: ${JSON.stringify(counters)}`);
  return { growth, indexBytes: user.stat(`${virtual.slice(1)}/.git/index`).size };
}

const small = await cleanStatusPeak(SMALL);
const large = await cleanStatusPeak(LARGE);
// What may grow with the tree: the index status read and the one it writes, each with its cache tree (3x
// the index's growth), and the pack store's idx page cache, which fills up to 4 MiB with a pack that grows
// with the repository. The two sizes' constant costs cancel in the difference.
const PACK_PAGE_CACHE_MB = 4;
const allowance = (3 * (large.indexBytes - small.indexBytes)) / MB + PACK_PAGE_CACHE_MB;
const growth = large.growth - small.growth;
const perFile = (growth * MB) / (LARGE - SMALL);
console.log(`git-status-flat-heap: clean status peak +${small.growth.toFixed(1)} MiB at ${SMALL} files, +${large.growth.toFixed(1)} MiB at ${LARGE}: ${perFile.toFixed(0)} bytes a file (allowed ${allowance.toFixed(1)} MiB)`);
assert.ok(growth <= allowance, `git status: its peak heap grew ${growth.toFixed(1)} MiB from ${SMALL} to ${LARGE} files, ${perFile.toFixed(0)} bytes a file (allowed ${allowance.toFixed(1)} MiB)`);
