#!/usr/bin/env bun
// Native Git's v2 hook over the test's durable Nimbus SQLite filesystem.
import { Database } from 'bun:sqlite';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { CRED_SESSION_USER } from '../../../packages/core/src/runtime/os-contracts.ts';
import { makeGitFsmonitor, sqliteGitFsmonitorState } from '../../../packages/core/src/runtime/git-fsmonitor.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const [database, version, token] = process.argv.slice(2);
if (version !== '2') throw new Error('expected fsmonitor v2');
const db = new Database(database);
const harness = createSqliteVfsTestHarness(db);
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const lease = new ProcessFiles(vfs).openHost(CRED_SESSION_USER);
try {
  const monitor = makeGitFsmonitor(sqliteGitFsmonitorState(harness.sql, 'native-fsmonitor'));
  process.stdout.write(await monitor.query({ fs: lease.fs, cwd: '/home/user/repo', cred: CRED_SESSION_USER, token, mounts: [] }));
} finally { lease.dispose(); db.close(); }
