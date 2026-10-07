// A repository built on disk by host git and mirrored into a SqliteVFS (its
// .git included), each step run by host git there and by Nimbus's git here
// (runGitCommand), then compared: the exit code, git's messages, the
// worktree, the index (entries, stages, skip-worktree bits as read and as
// written) and status. For worktree commands, whose results host git can
// read back from a copy of the VFS.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

export const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C',
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

/** Host git in `cwd`. */
export function realGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Host git commands that must succeed. */
export function sh(cwd, ...commands) {
  for (const args of commands) {
    const r = realGit(cwd, args);
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
}

/** A worktree as a sorted list: each path (but .git), its kind and contents. */
export function worktreeOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (rel === '' && name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out.push([path, 'link', readlinkSync(join(dir, path))]);
      else if (st.isDirectory()) { out.push([path, 'dir']); walk(path); }
      else out.push([path, 'file', readFileSync(join(dir, path), 'utf8')]);
    }
  };
  walk('');
  return out;
}

/** What git prints on stderr that this git prints on stdout, or not at all: the branch a checkout is on. */
export const branchNotes = (text) => text.split('\n').filter((line) => !/^(Switched to|Already on|HEAD is now at)/.test(line)).join('\n');

/** A scratch directory and a session's VFS, as the session user, for one test file. */
export function createMirror(label) {
  const scratch = mkdtempSync(join(tmpdir(), `nimbus-${label}-`));
  process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true, mode: 0o755 });
  vfs.as(CRED_KERNEL).chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const user = vfs.as(CRED_SESSION_USER);
  const files = new ProcessFiles(vfs);
  const counts = { checks: 0, copies: 0 };

  /** Copy a disk tree (its .git included) into the VFS at `to`, modes and all. */
  const mirror = (from, to) => {
    user.mkdir(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const src = join(from, name);
      const dst = `${to}/${name}`;
      const st = lstatSync(src);
      if (st.isDirectory()) mirror(src, dst);
      else if (st.isSymbolicLink()) user.symlink(readlinkSync(src), dst);
      else {
        user.writeFile(dst, new Uint8Array(readFileSync(src)));
        user.chmod(dst, st.mode & 0o777);
      }
    }
  };

  /** Copy a VFS tree (its .git included) back to disk, links as links. */
  const copyOut = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const { name, type } of user.readdir(from)) {
      const src = `${from}/${name}`;
      const dst = join(to, name);
      if (type === 'directory') copyOut(src, dst);
      else if (type === 'symlink') symlinkSync(user.readlink(src), dst);
      else {
        writeFileSync(dst, user.readFile(src));
        chmodSync(dst, user.lstat(src).mode & 0o777);
      }
    }
  };

  const nimbusGit = async (cwd, args) => {
    let stdout = '';
    let stderr = '';
    const code = await runGitCommand({
      pid: 1,
      cred: CRED_SESSION_USER,
      args,
      cwd,
      env: { USER: 'a', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
      stdout: { write(s) { stdout += s; }, writeBytes(bytes) { stdout += Buffer.from(bytes).toString('utf8'); } },
      stderr: { write(s) { stderr += s; } },
      vfs: files.view({ pid: 1, cred: CRED_SESSION_USER }),
    }, vfs);
    return { code, stdout, stderr };
  };

  /** One repository, on disk for host git and in the VFS for ours, each step run in both. */
  class Pair {
    constructor(name, disk) {
      this.name = name;
      this.disk = disk;
      this.virtual = `/home/user/${name}`;
      mirror(disk, this.virtual);
    }

    /**
     * `args` in both, in the repository or `sub` below it: the same exit code;
     * git's stderr (but what `branchNotes` drops), and stdout, where asked.
     */
    async run(args, { stderr = true, stdout = false, sub = '' } = {}) {
      const label = `${this.name}: git ${args.join(' ')}`;
      const host = realGit(sub ? join(this.disk, sub) : this.disk, args);
      const ours = await nimbusGit(sub ? `${this.virtual}/${sub}` : this.virtual, args);
      assert.equal(ours.code, host.code, `${label}: exit code (ours: ${ours.stderr}; git's: ${host.stderr})`);
      if (stderr) assert.equal(branchNotes(ours.stderr), branchNotes(host.stderr), `${label}: stderr`);
      if (stdout) assert.equal(ours.stdout, host.stdout, `${label}: stdout`);
      counts.checks++;
      return ours;
    }

    /** A file written (or removed, `text` null) in both worktrees. */
    write(path, text) {
      const disk = join(this.disk, path);
      const virtual = `${this.virtual}/${path}`;
      if (text === null) {
        rmSync(disk, { force: true });
        if (user.exists(virtual)) user.unlink(virtual);
        return;
      }
      mkdirSync(join(disk, '..'), { recursive: true });
      writeFileSync(disk, text);
      user.mkdir(virtual.slice(0, virtual.lastIndexOf('/')), { recursive: true });
      user.writeFile(virtual, new TextEncoder().encode(text));
    }

    /** Ours copied out to disk, for host git to read. */
    copy() {
      const ours = join(scratch, `ours-${this.name}-${counts.copies++}`);
      copyOut(this.virtual, ours);
      return ours;
    }

    /** The same worktree and index: entries, stages and skip-worktree bits, as read and as written. */
    same(step) {
      const label = `${this.name}: after ${step}`;
      const ours = this.copy();
      assert.deepEqual(worktreeOf(ours), worktreeOf(this.disk), `${label}: the worktree`);
      for (const args of [['ls-files', '-s', '-t'], ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t'], ['status', '--porcelain']]) {
        assert.equal(realGit(ours, args).stdout, realGit(this.disk, args).stdout, `${label}: git ${args.join(' ')}`);
      }
      counts.checks++;
      return ours;
    }
  }

  return { scratch, user, nimbusGit, Pair, counts };
}
