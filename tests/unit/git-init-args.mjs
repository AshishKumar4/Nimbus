#!/usr/bin/env bun
// git init takes its options as git 2.53 does: the initial branch (-b <name>,
// -b<name>, --initial-branch[=]<name>) names HEAD's branch and is never the
// directory (`git init -b main` used to initialize ./main), a name git's
// check-ref-format refuses is refused (128), short options cluster (-qq,
// -qbmain), --bare makes the directory the git directory, -q is quiet, a
// repository already there is re-initialized (its HEAD kept, the branch
// ignored with git's warning); an option with no value or one git does not
// know fails as git's does. Each against real git: the exit code, what is
// printed (paths but the root alike) and HEAD.

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
// git's hint about the default branch's name is advice Nimbus does not give: switched off for the comparison.
const GIT_ENV = {
  PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_CEILING_DIRECTORIES: tmpdir(),
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'advice.defaultBranchName', GIT_CONFIG_VALUE_0: 'false',
};

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

/** Each case: git init's arguments, after an init with `before` when re-initializing. */
const cases = [
  { args: ['-q', '-b', 'main'] },
  { args: ['-q', '--initial-branch=trunk', 'sub'] },
  { args: ['-q', '--initial-branch', 'dev', 'sub2'] },
  { args: ['-q', '-btopic', 'sub3'] },
  { args: ['-b', 'feature', 'loud'] },
  { args: ['--bare', '-q', '-b', 'trunk', 'z.git'] },
  { args: ['--bare', 'bare.git'] },
  { args: ['-qq'] },
  { args: ['-qbmain', 'c1'] },
  { args: ['-qb', 'trunk', 'c2'] },
  { args: ['-bq', 'c3'] },
  { args: ['-q', '--no-initial-branch', 'c4'] },
  { args: ['-q', '-b', 'main', '--no-initial-branch', 'c5'] },
  { args: ['-q', '-b', 'a/b', 'n1'] },
  { args: ['-q', '-b', 'HEAD', 'n2'] },
  { args: ['-q', '-b', '@', 'n3'] },
  { args: ['-q', '-b', 'é', 'n4'] },
  ...['bad..name', '', 'with space', 'main.lock', 'a//b', 'a/', '.a', 'a/.b', 'a.', 'a@{b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\tb', 'a.lock/b', '/a']
    .map((name) => ({ args: ['-q', '-b', name, 'bad'] })),
  { args: ['--initial-branch=', 'bad'] },
  { before: ['-q'], args: ['-b', 'other'] },
  { before: ['-q'], args: ['-q', '-b', 'bad..name'] },
  { before: ['-q'], args: [] },
  { before: ['--bare', '-q', 'r.git'], args: ['--bare', '-b', 'x', 'r.git'] },
  { args: ['-b'] },
  { args: ['--initial-branch'] },
  { args: ['--bogus'] },
  { args: ['-x'] },
  { args: ['-qx'] },
  { args: ['--quiet=1'] },
  { args: ['one', 'two'] },
];
for (const [n, { before, args }] of cases.entries()) {
  const host = join(scratch, `host-${n}`);
  mkdirSync(host);
  const cwd = `/home/user/ours-${n}`;
  user.mkdir(cwd.slice(1));
  const ours = async (initArgs) => {
    let stdout = '';
    let stderr = '';
    const code = await runGitCommand({
      pid: 1, cred: CRED_SESSION_USER, args: ['init', ...initArgs], cwd, env: { HOME: '/home/user' },
      stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } }, vfs: user,
    }, vfs);
    return { code, stdout, stderr };
  };
  if (before) {
    assert.equal(spawnSync('git', ['init', ...before], { cwd: host, env: GIT_ENV }).status, 0);
    assert.equal((await ours(before)).code, 0);
  }
  const real = spawnSync('git', ['init', ...args], { cwd: host, env: GIT_ENV, encoding: 'utf8' });
  const { code, stdout, stderr } = await ours(args);
  const label = `git init ${args.map((arg) => JSON.stringify(arg)).join(' ')}${before ? ' (re-init)' : ''}`;
  assert.equal(code, real.status, `${label}: exit code`);
  assert.equal(stdout.replaceAll(cwd, '<root>'), real.stdout.replaceAll(host, '<root>'), `${label}: stdout`);
  assert.equal(stderr.replaceAll(cwd, '<root>'), real.stderr.replaceAll(host, '<root>'), `${label}: stderr`);
  if (real.status !== 0) continue;
  const directory = args.filter((arg, i) => !arg.startsWith('-') && !['-b', '-qb', '--initial-branch'].includes(args[i - 1])).at(-1) ?? '';
  const gitdir = (root) => join(root, directory, args.includes('--bare') ? '' : '.git');
  assert.equal(new TextDecoder().decode(user.readFile(gitdir(cwd).slice(1) + '/HEAD')), readFileSync(join(gitdir(host), 'HEAD'), 'utf8'), `${label}: HEAD`);
}
console.log(`git-init-args: ${cases.length} git init argument lists answer as git ${spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim().split(' ')[2]}`);
