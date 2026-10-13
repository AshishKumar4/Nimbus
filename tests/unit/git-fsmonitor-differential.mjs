#!/usr/bin/env bun
// Every native hook invocation reopens Nimbus's DB: token persistence and
// the SQL journal's wake path are exercised, not a retained JS map.
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const work = mkdtempSync(join(tmpdir(), 'git-fsmonitor-differential-'));
const database = join(work, 'session.sqlite');
const monitored = join(work, 'monitored'), baseline = join(work, 'baseline');
const identity = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.test', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const env = { ...process.env, ...identity, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
const db = new Database(database);
const harness = createSqliteVfsTestHarness(db);
let vfs = new SqliteVFS(harness.sql, harness.ctx);
const sqlFiles = () => vfs.as(CRED_KERNEL);
const root = 'home/user/repo/';
let checks = 0;
const compare = (label) => {
  assert.equal(git(monitored, 'status', '--porcelain=v2', '--untracked-files=all'), git(baseline, 'status', '--porcelain=v2', '--untracked-files=all'), label);
  checks++;
};
const file = (path, text) => {
  for (const dir of [monitored, baseline]) {
    mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text);
  }
  const target = root + path;
  sqlFiles().mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  sqlFiles().writeFile(target, text);
};
try {
  for (const dir of [monitored, baseline]) { mkdirSync(dir); git(dir, 'init', '-q', '-b', 'main'); }
  sqlFiles().mkdir(root + '.git', { recursive: true });
  file('src/a.txt', 'one\n'); file('src/b.txt', 'two\n'); file('top.txt', 'top\n');
  vfs.snapshot('fsmonitor-native-base');
  for (const dir of [monitored, baseline]) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base'); }
  const hook = new URL('./lib/git-fsmonitor-nimbus.mjs', import.meta.url).pathname;
  git(monitored, 'config', 'core.fsmonitor', `bun '${hook}' '${database}'`);
  git(monitored, 'config', 'core.fsmonitorHookVersion', '2');
  git(monitored, 'config', 'core.untrackedCache', 'true');
  compare('initial clean'); compare('wake with unchanged durable token');
  file('src/a.txt', 'ONE\n'); compare('same-size tracked edit');
  file('new\nname.txt', 'new\n'); compare('NUL protocol preserves newline paths');
  for (const dir of [monitored, baseline]) renameSync(join(dir, 'src/b.txt'), join(dir, 'src/renamed.txt'));
  sqlFiles().rename(root + 'src/b.txt', root + 'src/renamed.txt'); compare('rename reports both names');
  for (const dir of [monitored, baseline]) unlinkSync(join(dir, 'top.txt'));
  sqlFiles().unlink(root + 'top.txt'); compare('deletion survives cold journal reconstruction');
  for (const dir of [monitored, baseline]) chmodSync(join(dir, 'src/a.txt'), 0o755);
  sqlFiles().chmod(root + 'src/a.txt', 0o755); compare('mode change');

  // A different OS process publishes the write; the hook's own fresh VFS
  // sees it through the credential-bound acquisition barrier.
  const vfsModule = new URL('../../packages/core/src/vfs/sqlite-vfs.ts', import.meta.url).pathname;
  const harnessModule = new URL('./lib/sqlite-vfs-test-harness.mjs', import.meta.url).pathname;
  const credModule = new URL('../../packages/core/src/runtime/os-contracts.ts', import.meta.url).pathname;
  const peer = `import {Database} from 'bun:sqlite';import {SqliteVFS} from ${JSON.stringify(vfsModule)};import {createSqliteVfsTestHarness} from ${JSON.stringify(harnessModule)};import {CRED_KERNEL} from ${JSON.stringify(credModule)};const db=new Database(process.argv[1]);const h=createSqliteVfsTestHarness(db);new SqliteVFS(h.sql,h.ctx).as(CRED_KERNEL).writeFile('home/user/repo/src/a.txt','peer\\n');db.close();`;
  execFileSync('bun', ['-e', peer, database], { stdio: 'pipe' });
  for (const dir of [monitored, baseline]) writeFileSync(join(dir, 'src/a.txt'), 'peer\n');
  vfs = new SqliteVFS(harness.sql, harness.ctx); compare('another process writes before the hook acquires');
  vfs.restore('fsmonitor-native-base', { subtree: 'home/user/repo' });
  for (const dir of [monitored, baseline]) { git(dir, 'reset', '--hard', '-q', 'HEAD'); git(dir, 'clean', '-fdq'); }
  compare('snapshot-restored working tree');
  vfs.rotateIncarnation(); compare('restore/new epoch poisons the old Git index token');
  file('after-restore.txt', 'fresh\n'); compare('new clock publication becomes trusted'); compare('second wake after restore');
  assert.ok([...harness.sql.exec('SELECT value FROM nimbus_git_fsmonitor')].length > 0, 'native Git used the durable hook');
  console.log(`git-fsmonitor-differential: ${checks} native Git comparisons; durable wakes, restore and OS-process writes passed`);
} finally { db.close(); rmSync(work, { recursive: true, force: true }); }
