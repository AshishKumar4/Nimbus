#!/usr/bin/env bun
// `git -c <name>=<value>` and `git config --get`, against host git doing the
// same in a repository each makes alike (host git on disk, ours in a
// SqliteVFS, read back by host git from a copy):
//   - -c sets a setting for that command only, over the files': the
//     author of a commit, the branch `git init` starts on, what `git config
//     --get` answers; nothing of it is written (a later read does not see
//     it), and a later -c of the same key wins;
//   - a key -c cannot parse is git's error, then "fatal: unable to parse
//     command-line config", 128;
//   - `git config <key> <value>` prints nothing; `git config --get <key>`
//     and `git config <key>` of a key not set print nothing and exit 1;
//   - `git fetch <name>` in a repository on master with no remotes at all
//     is git's "does not appear to be a git repository", 128, the network
//     not tried.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-config-params-'));
const ENV = {
  PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C',
  GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000',
};
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true, mode: 0o755 });
vfs.as(CRED_KERNEL).chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);
const files = new ProcessFiles(vfs);

/** Host git in `cwd`. */
function realGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Ours in `cwd`. */
async function nimbusGit(cwd, args) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd,
    env: { GIT_AUTHOR_DATE: ENV.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: ENV.GIT_COMMITTER_DATE },
    stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString('utf8'); } },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 1, cred: CRED_SESSION_USER }),
  }, vfs);
  return { code, stdout, stderr };
}
/** The same in both: exit code, and stdout and stderr where asked. */
async function both(name, host, ours, args, { stdout = false, stderr = true } = {}) {
  const h = realGit(host, args);
  const o = await nimbusGit(ours, args);
  assert.equal(o.code, h.code, `${name}: exit (git's ${h.stderr}; ours ${o.stderr})`);
  if (stdout) assert.equal(o.stdout, h.stdout, `${name}: stdout`);
  if (stderr) assert.equal(o.stderr, h.stderr, `${name}: stderr`);
  return o;
}
/** Ours copied out, for host git to read. */
function copyOut(from, to) {
  mkdirSync(to, { recursive: true });
  for (const { name, type } of user.readdir(from)) {
    const src = `${from}/${name}`;
    if (type === 'directory') copyOut(src, join(to, name));
    else writeFileSync(join(to, name), user.readFile(src));
  }
}

try {
  // -c init.defaultBranch: the branch init starts on.
  await both('init', work, '/home/user', ['-c', 'init.defaultBranch=trunk', 'init', '-q', 'r']);
  const host = join(work, 'r');
  const ours = '/home/user/r';
  assert.equal(new TextDecoder().decode(user.readFile('home/user/r/.git/HEAD')), 'ref: refs/heads/trunk\n', 'ours starts on trunk');
  assert.equal(realGit(host, ['symbolic-ref', 'HEAD']).stdout, 'refs/heads/trunk\n', 'as git\'s does');
  console.log('  ok  -c init.defaultBranch: init starts on its branch');

  // -c user.name and user.email: the commit's author and committer; nothing written.
  writeFileSync(join(host, 'a.txt'), 'a\n');
  user.writeFile('home/user/r/a.txt', 'a\n');
  await both('add', host, ours, ['add', 'a.txt']);
  await both('commit', host, ours, ['-c', 'user.name=C Name', '-c', 'user.email=c@example.com', '-c', 'user.name=Last Name', 'commit', '-q', '-m', 'one']);
  const copied = join(work, 'ours');
  copyOut(ours, copied);
  const log = (dir) => realGit(dir, ['log', '-1', '--format=%an <%ae> %cn <%ce>']).stdout;
  assert.equal(log(copied), log(host), 'the commit\'s identities: the last -c of a key wins');
  assert.equal(log(copied), 'Last Name <c@example.com> Last Name <c@example.com>\n');
  await both('config --get of what -c set', host, ours, ['-c', 'a.b=c', 'config', '--get', 'a.b'], { stdout: true });
  await both('nothing of it written', host, ours, ['config', '--get', 'user.name'], { stdout: true });
  await both('-c of a subsection, case kept', host, ours, ['-c', 'remote.Up.url=x', 'config', '--get', 'remote.Up.url'], { stdout: true });
  console.log('  ok  -c user.name and user.email: the commit\'s identities, the last -c winning; nothing written');

  // config <key> <value>: set, nothing printed; read back.
  await both('config set', host, ours, ['config', 'set.me', 'v'], { stdout: true });
  await both('config --get of what was set', host, ours, ['config', '--get', 'set.me'], { stdout: true });
  console.log('  ok  config <key> <value>: nothing printed; read back by --get');

  // config --get, and config <key>, of a key not set.
  await both('config --get missing', host, ours, ['config', '--get', 'no.such'], { stdout: true });
  await both('config missing', host, ours, ['config', 'no.such'], { stdout: true });
  console.log('  ok  config --get (and config <key>) of a key not set: nothing printed, exit 1');

  // Keys -c cannot parse.
  for (const text of ['foo=bar', 'foo.=bar', '.foo=bar', 'a.1b=c', 'a_b.c=d', '=x']) {
    await both(`-c ${text}`, host, ours, ['-c', text, 'status'], { stdout: true });
  }
  console.log('  ok  keys -c cannot parse: git\'s error, "unable to parse command-line config", 128');

  // fetch of a name in a repository on master with no remotes.
  const bare = join(work, 'bare-host');
  realGit(work, ['init', '-q', bare]);
  await nimbusGit('/home/user', ['init', '-q', '/home/user/bare']);
  assert.equal(new TextDecoder().decode(user.readFile('home/user/bare/.git/HEAD')), 'ref: refs/heads/master\n');
  // A commit on master in each, so a push's refspec matches and what is refused is the remote.
  writeFileSync(join(bare, 'a.txt'), 'a\n');
  user.writeFile('home/user/bare/a.txt', 'a\n');
  for (const args of [['add', 'a.txt'], ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '-m', 'one']]) {
    assert.equal(realGit(bare, args).code, 0);
    assert.equal((await nimbusGit('/home/user/bare', args)).code, 0);
  }
  for (const args of [['fetch', 'nosuch'], ['push', 'nosuch', 'master']]) {
    const h = realGit(bare, args);
    const o = await nimbusGit('/home/user/bare', args);
    const quiet = (text) => text.split('\n').filter((line) => !/^(Fetching|Pushing) /.test(line)).join('\n').trim();
    assert.deepEqual([o.code, quiet(o.stderr)], [h.code, h.stderr.trim()], `${args.join(' ')} on master with no remotes (git's ${h.stderr}; ours ${o.stderr})`);
  }
  console.log('  ok  fetch and push of a remote on master with no remotes: git\'s refusal, the network not tried');
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('git-config-params: ok');
