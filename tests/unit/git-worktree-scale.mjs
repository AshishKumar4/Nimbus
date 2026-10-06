#!/usr/bin/env bun
// git's worktree commands hold memory that does not grow with the
// repository, beyond the index itself, and read no file whose stat matches
// the index. A repository of SMALL and then LARGE files (real git builds
// it, packed, and it is mirrored into a SqliteVFS) goes through status,
// edits, status, diff, add -A, commit, a branch switch and back, reset and
// reset --hard. Each command's output agrees with real git's on the same
// repository, and for each the JS heap it retains is sampled (collected,
// then measured) on every 4096th filesystem call and at its end: the peak at
// LARGE files may exceed SMALL's by little more than the index's growth.
// Clean, `status` reads no file; after edits, only the same-size ones.
// Then every file changes, and status, diff, add -A and commit run over
// all of them: each change may cost ~1 KiB of heap, nothing more.

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

const SMALL = Number(process.env.NIMBUS_GIT_SCALE_SMALL) || 3_000;
const LARGE = Number(process.env.NIMBUS_GIT_SCALE_LARGE) || 30_000;
const MB = 1024 * 1024;

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-scale-'));
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
  realGit(disk, 'checkout', '-q', '-b', 'other');
  for (let i = 0; i < 40; i++) {
    const at = (i * 7919) % count;
    if (i % 4 === 0) rmSync(join(disk, path(at)));
    else writeFileSync(join(disk, path(at)), `other ${i}\n`);
  }
  mkdirSync(join(disk, 'added/deep'), { recursive: true });
  writeFileSync(join(disk, 'added/deep/new.txt'), 'new\n');
  realGit(disk, 'add', '-A');
  realGit(disk, 'commit', '-q', '-m', 'other');
  realGit(disk, 'checkout', '-q', 'main');
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

/** One size: every command, with what it cost. */
async function run(count) {
  const disk = join(scratch, `repo-${count}`);
  const path = build(disk, count);
  const vfs = newVfs();
  const user = vfs.as(CRED_SESSION_USER);
  const virtual = `/home/user/repo-${count}`;
  mirror(user, disk, virtual.slice(1));
  const files = new ProcessFiles(vfs);
  // Every filesystem call samples the heap now and then; reads of worktree files are counted.
  let calls = 0;
  let peak = 0;
  let reads = 0;
  // What is retained, not what is garbage yet to be collected: the garbage's peak is the collector's schedule.
  const sample = () => {
    if (++calls % 4096 !== 0) return;
    Bun.gc(true);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  };
  const view = files.view({ pid: 1, cred: CRED_SESSION_USER });
  const observed = new Proxy(view, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        sample();
        if (/^read(File|Range)(Uncached)?$/.test(String(key)) && typeof args[0] === 'string'
          && args[0].startsWith(`${virtual}/`) && !args[0].includes('/.git/') && !args[0].endsWith('/.gitignore')) reads++;
        return value.apply(target, args);
      };
    },
  });
  const costs = [];
  const git = async (...args) => {
    let stdout = '';
    let stderr = '';
    Bun.gc(true);
    const base = process.memoryUsage().heapUsed;
    peak = base;
    reads = 0;
    const started = performance.now();
    const code = await runGitCommand({
      pid: 1, cred: CRED_SESSION_USER, args, cwd: virtual,
      env: { HOME: '/home/user', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
        GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000' },
      stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString('latin1'); } },
      stderr: { write(s) { stderr += s; } },
      vfs: observed,
    }, vfs);
    Bun.gc(true);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    costs.push({ command: args.join(' '), ms: Math.round(performance.now() - started), peakMB: (peak - base) / MB, reads });
    assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
    return stdout;
  };
  const both = async (...args) => {
    const ours = await git(...args);
    assert.equal(ours, realGit(disk, ...args), `${count} files: git ${args.join(' ')}`);
  };
  const edit = (file, content) => {
    writeFileSync(join(disk, file), content);
    user.writeFile(`${virtual.slice(1)}/${file}`, content);
  };

  // The mirrored index carries the host's stat: the first status refreshes every entry. The files
  // written in the second the index was are racily clean: the next status checks them and writes
  // the index again, later, after which nothing is racy.
  await both('status', '--porcelain');
  const indexBytes = user.stat(`${virtual.slice(1)}/.git/index`).size;
  await Bun.sleep(1100);
  await both('status', '--porcelain');
  await both('status', '--porcelain');
  assert.equal(costs.at(-1).reads, 0, `${count} files: a clean status reads no file`);
  for (let i = 0; i < 5; i++) edit(path(i * 31), `grown, a different size ${i}\n`);
  for (let i = 0; i < 5; i++) {
    const file = path(i * 37 + 3);
    edit(file, readFileSync(join(disk, file), 'latin1').replace('file', 'FILE'));
  }
  for (const file of [path(11), path(12)]) {
    rmSync(join(disk, file));
    user.unlink(`${virtual.slice(1)}/${file}`);
  }
  mkdirSync(join(disk, 'newdir'));
  user.mkdir(`${virtual.slice(1)}/newdir`);
  edit('newdir/n.txt', 'n\n');
  edit('debug.log', 'ignored\n');
  await both('status', '--porcelain');
  assert.equal(costs.at(-1).reads, 5, `${count} files: status after edits reads the 5 same-size files only`);
  await both('status', '-s', '-uall');
  await both('diff', '--stat');
  await both('diff', 'HEAD', '--name-status');
  await both('ls-files', '-m');
  realGit(disk, 'add', '-A');
  await git('add', '-A');
  await both('diff', '--cached', '--name-status');
  realGit(disk, 'commit', '-q', '-m', 'edits');
  await git('commit', '-q', '-m', 'edits');
  await both('rev-parse', 'HEAD');
  await Bun.sleep(1100);
  realGit(disk, 'checkout', '-q', 'other');
  await git('checkout', '-q', 'other');
  await both('status', '--porcelain');
  await both('ls-files', '-s');
  realGit(disk, 'checkout', '-q', 'main');
  await git('checkout', '-q', 'main');
  await both('status', '--porcelain');
  edit(path(5), 'dirty again\n');
  const seed = realGit(disk, 'rev-parse', 'HEAD~1').trim();
  realGit(disk, 'reset', '-q', seed);
  await git('reset', '-q', seed);
  await both('status', '--porcelain');
  realGit(disk, 'reset', '-q', '--hard', 'main');
  await git('reset', '-q', '--hard', 'main');
  await both('status', '--porcelain');

  // Every file changed: half grow (the size says so), half keep their size (each is hashed).
  const everyFile = costs.length;
  await Bun.sleep(1100);
  for (const file of realGit(disk, 'ls-files', '-z').split('\0').filter(Boolean)) {
    if (file === '.gitignore' || lstatSync(join(disk, file)).isSymbolicLink()) continue;
    const text = readFileSync(join(disk, file), 'latin1');
    edit(file, text.length % 2 ? `${text}grown\n` : text.replace(/^./, (c) => (c === 'X' ? 'Y' : 'X')));
  }
  await both('status', '--porcelain');
  await both('diff', '--stat');
  realGit(disk, 'add', '-A');
  await git('add', '-A');
  await both('diff', '--cached', '--name-status');
  realGit(disk, 'commit', '-q', '-m', 'everything');
  await git('commit', '-q', '-m', 'everything');
  await both('rev-parse', 'HEAD');
  await both('status', '--porcelain');
  return { count, indexBytes, costs, everyFile };
}

const small = await run(SMALL);
const large = await run(LARGE);
for (const { count, indexBytes, costs } of [small, large]) {
  console.log(`${count} files, index ${(indexBytes / MB).toFixed(1)} MiB:`);
  for (const { command, ms, peakMB, reads } of costs) {
    console.log(`  ${command.padEnd(32)} ${String(ms).padStart(6)} ms  peak +${peakMB.toFixed(1).padStart(6)} MiB  ${reads} files read`);
  }
}
// The heap may grow with the index (held as its bytes, and written as a copy) and little else: not
// with the directories (a cache tree of objects held 14 MiB more at 15,000 directories than at 1,500).
// With every file changed, each change may hold a little more: its line, its pair, its new entry.
const allowance = (2 * (large.indexBytes - small.indexBytes)) / MB + 4;
const perChange = Number(process.env.NIMBUS_GIT_SCALE_PER_CHANGE) || 1024;
const changeAllowance = allowance + ((LARGE - SMALL) * perChange) / MB;
for (const [i, { command, peakMB }] of large.costs.entries()) {
  const growth = peakMB - small.costs[i].peakMB;
  const allowed = i >= large.everyFile ? changeAllowance : allowance;
  assert.ok(growth <= allowed,
    `git ${command}${i >= large.everyFile ? ' (every file changed)' : ''}: its peak heap grew ${growth.toFixed(1)} MiB from ${SMALL} to ${LARGE} files (allowed ${allowed.toFixed(1)})`);
}
console.log(`git-worktree-scale: ${large.costs.length} commands at ${SMALL} and ${LARGE} files agree with real git; peak heap growth within ${allowance.toFixed(1)} MiB, ${changeAllowance.toFixed(1)} MiB with every file changed`);
