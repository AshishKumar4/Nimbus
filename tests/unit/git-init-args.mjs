#!/usr/bin/env bun
// git init takes its options as git 2.53 does: the initial branch (-b <name>,
// -b<name>, --initial-branch[=]<name>) names HEAD's branch and is never the
// directory (`git init -b main` used to initialize ./main), --bare makes the
// directory the git directory, -q is quiet; an option with no value or one
// git does not know fails as git's does. Each against real git: the exit
// code, what is printed (paths but the root alike) and HEAD.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-init-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_CEILING_DIRECTORIES: tmpdir() };

const db = new Database(':memory:');
const vfs = new SqliteVFS({
  exec(query, ...params) {
    const prepared = db.query(query);
    if (prepared.columnNames.length === 0) { db.run(query, ...params); return []; }
    return prepared.all(...params);
  },
}, { storage: { transactionSync: (callback) => db.transaction(callback)() } });
vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true, mode: 0o755 });
vfs.as(CRED_KERNEL).chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);

const cases = [
  ['-q', '-b', 'main'],
  ['-q', '--initial-branch=trunk', 'sub'],
  ['-q', '--initial-branch', 'dev', 'sub2'],
  ['-q', '-btopic', 'sub3'],
  ['-b', 'feature', 'loud'],
  ['--bare', '-q', '-b', 'trunk', 'z.git'],
  ['--bare', 'bare.git'],
  ['-b'],
  ['--initial-branch'],
  ['--bogus'],
  ['-x'],
  ['one', 'two'],
];
for (const [n, args] of cases.entries()) {
  const host = join(scratch, `host-${n}`);
  mkdirSync(host);
  const real = spawnSync('git', ['init', ...args], { cwd: host, env: GIT_ENV, encoding: 'utf8' });
  const cwd = `/home/user/ours-${n}`;
  user.mkdir(cwd.slice(1));
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args: ['init', ...args], cwd, env: { HOME: '/home/user' },
    stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } }, vfs: user,
  }, vfs);
  const label = `git init ${args.join(' ')}`;
  assert.equal(code, real.status, `${label}: exit code`);
  assert.equal(stdout.replaceAll(cwd, '<root>'), real.stdout.replaceAll(host, '<root>'), `${label}: stdout`);
  if (real.status !== 0) {
    assert.equal(stderr, real.stderr, `${label}: stderr`);
    continue;
  }
  const directory = args.filter((arg, i) => !arg.startsWith('-') && !['-b', '--initial-branch'].includes(args[i - 1])).at(-1) ?? '';
  const gitdir = (root) => join(root, directory, args.includes('--bare') ? '' : '.git');
  assert.equal(new TextDecoder().decode(user.readFile(gitdir(cwd).slice(1) + '/HEAD')), readFileSync(join(gitdir(host), 'HEAD'), 'utf8'), `${label}: HEAD`);
}
console.log(`git-init-args: ${cases.length} git init argument lists answer as git ${spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim().split(' ')[2]}`);
