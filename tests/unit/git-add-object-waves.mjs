#!/usr/bin/env bun
// git add's objects, written as git writes them by one flow, in waves or one
// at a time (the egress review of d9dc4ef8e, EconomicStarfish):
//
//   (1) a repository whose .git/objects links elsewhere (on the engine): the
//       waves go to the objects directory where it is, the link stays a
//       link, and real git reads every object through it (fsck --strict);
//   (2) each loose object is published read-only (0444), as git leaves one;
//   (3) a blob staged twice while its first wave is still unpublished (two
//       files with one content, a wave cut between them, the first wave held
//       back) is written once;
//   (4) an objects directory holding a link of its own (a fan-out directory
//       linked away) has its objects written one at a time, through the
//       command's view, by the same flow: the same bytes and mode, and real
//       git reads them.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { WAVE_PATHS } from '../../packages/platform/src/wave-writer.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-add-object-waves-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const GIT_ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A session filesystem, its engine's waves observed: each object path a wave publishes, and a hold on the next wave. */
function setup() {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const user = vfs.as(CRED_SESSION_USER);
  const published = [];
  const state = { hold: null };
  const engineAs = vfs.as.bind(vfs);
  vfs.as = (cred) => new Proxy(engineAs(cred), {
    get(target, key) {
      if (key !== 'writeStream') return Reflect.get(target, key, target);
      return async (stream, options) => {
        const hold = state.hold;
        state.hold = null;
        if (hold) await hold;
        const result = await target.writeStream(stream, options);
        for (const { path } of result.receipts) published.push(path);
        return result;
      };
    },
  });
  const view = new ProcessFiles(vfs).view({ pid: 1, cred: CRED_SESSION_USER });
  const git = async (cwd, ...args) => {
    let stderr = '';
    const code = await runGitCommand({
      pid: 1, cred: CRED_SESSION_USER, args, cwd: `/${cwd}`, env: { USER: 'a', GIT_AUTHOR_EMAIL: 'a@example.com' },
      stdout: { write() {} }, stderr: { write(s) { stderr += s; } }, vfs: view,
    }, vfs);
    assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
  };
  return { vfs, user, published, state, git };
}

/** `from` in the session (links kept) copied to `to` on disk, modes kept; real git's verdict on it. */
function realGitReads(user, from, to) {
  const copy = (src, dst) => {
    mkdirSync(dst, { recursive: true });
    for (const entry of user.readdir(src)) {
      const path = `${src}/${entry.name}`;
      const st = user.lstat(path);
      if (st.type === 'directory') copy(path, join(dst, entry.name));
      else if (st.type === 'symlink') symlinkSync(user.readlink(path), join(dst, entry.name));
      else {
        writeFileSync(join(dst, entry.name), user.readFile(path));
        chmodSync(join(dst, entry.name), st.mode & 0o777);
      }
    }
  };
  copy(from, to);
  return spawnSync('git', ['fsck', '--strict', '--no-progress'], { cwd: join(to, 'repo'), env: GIT_ENV, encoding: 'utf8' });
}

const objectPath = (oid) => `${oid.slice(0, 2)}/${oid.slice(2)}`;
const blobId = (text) => spawnSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).stdout.trim();

// ── (1)-(3) .git/objects a link; read-only objects; a duplicate across waves ──
{
  const { user, published, state, git } = setup();
  user.mkdir('home/user/work/repo', { recursive: true });
  await git('home/user/work/repo', 'init', '-q');
  // The objects elsewhere on the engine, .git/objects a link to them.
  user.rename('home/user/work/repo/.git/objects', 'home/user/work/store');
  user.symlink('../../store', 'home/user/work/repo/.git/objects');
  // One content first and last, and more than a wave's worth between: the second copy comes while the first's wave is held.
  const same = 'the same content\n';
  user.writeFile('home/user/work/repo/a0.txt', same);
  for (let i = 0; i < WAVE_PATHS + 50; i++) user.writeFile(`home/user/work/repo/b${String(i).padStart(5, '0')}.txt`, `file ${i}\n`);
  user.writeFile('home/user/work/repo/c0.txt', same);
  let release;
  state.hold = new Promise((resolve) => { release = resolve; });
  setTimeout(release, 300);
  await git('home/user/work/repo', 'add', '-A');

  assert.equal(user.lstat('home/user/work/repo/.git/objects').type, 'symlink', '(1) .git/objects is still a link');
  const oid = blobId(same);
  const written = published.filter((path) => path.endsWith(objectPath(oid)));
  assert.equal(written.length, 1, `(3) a blob staged twice while its wave was held is written once (${written.length})`);
  assert.ok(written[0].startsWith('home/user/work/store/'), `(1) the waves wrote to the objects where they are (${written[0]})`);
  assert.equal(user.stat(`home/user/work/store/${objectPath(oid)}`).mode & 0o777, 0o444, '(2) a loose object is read-only, as git leaves one');
  assert.equal(published.filter((path) => path.includes('/objects/') || path.includes('/store/')).length, WAVE_PATHS + 52 - 1, 'every other blob once');

  const fsck = realGitReads(user, 'home/user/work', join(scratch, 'one'));
  assert.equal(fsck.status, 0, `(1) real git reads every object through the link: ${fsck.stderr}`);
  console.log('  ok  (1)-(3) objects through a linked .git/objects, read-only, a duplicate across a held wave written once');
}

// ── (4) a fan-out directory linked away: one at a time, the same flow ──────
{
  const { user, published, git } = setup();
  user.mkdir('home/user/work/repo', { recursive: true });
  await git('home/user/work/repo', 'init', '-q');
  const text = 'linked fan-out\n';
  const oid = blobId(text);
  user.mkdir('home/user/work/elsewhere', { recursive: true });
  user.symlink('../../../elsewhere', `home/user/work/repo/.git/objects/${oid.slice(0, 2)}`);
  user.writeFile('home/user/work/repo/one.txt', text);
  user.writeFile('home/user/work/repo/two.txt', 'another\n');
  await git('home/user/work/repo', 'add', '-A');
  assert.equal(published.length, 0, 'no wave: the objects went one at a time');
  assert.equal(user.lstat(`home/user/work/repo/.git/objects/${oid.slice(0, 2)}`).type, 'symlink');
  assert.equal(user.stat(`home/user/work/elsewhere/${oid.slice(2)}`).mode & 0o777, 0o444, 'written through the link, read-only');
  await git('home/user/work/repo', 'commit', '-qm', 'one');
  const fsck = realGitReads(user, 'home/user/work', join(scratch, 'four'));
  assert.equal(fsck.status, 0, `(4) real git reads the objects written one at a time: ${fsck.stderr}`);
  console.log('  ok  (4) a linked fan-out directory: objects one at a time by the same flow, read-only, read by real git');
}

console.log('git-add-object-waves: objects follow a linked objects directory, read-only, written once across waves; one flow for both sinks');
