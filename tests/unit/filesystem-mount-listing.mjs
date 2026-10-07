#!/usr/bin/env bun
// The mount listing is what df, mount and /proc/mounts read. It is the
// namespace's mount table: SQLite at `/` with real usage, /proc and /dev,
// and every mount an embedder adds on the workspace's CompositeVFS (Kinu
// mounts /pc/<name>, /context, ...), each as its backend describes itself,
// in mount order, for the reading process's credential.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { DO_STORAGE_LIMIT_BYTES } from '../../packages/platform/src/limits.ts';

const GiB = 2 ** 30;
const creds = [];

const db = new Database(':memory:');
const harness = createSqliteVfsTestHarness(db);
// workerd's SqlStorage reports the database's size; bun:sqlite answers the same question by pragma.
const pragma = (name) => Number(Object.values(db.query(`PRAGMA ${name}`).get())[0]);
const databaseSize = () => pragma('page_count') * pragma('page_size');
const sql = { exec: harness.sql.exec, get databaseSize() { return databaseSize(); } };

const ws = await NimbusWorkspace.create({ sql, transactions: harness.ctx });
/** A backend that says what it is, as Kinu's adapters do. */
const described = (description, usage) => Object.assign(new MemoryVFS(), { describe: () => description, usage });
const table = ws.filesystem.vfs;
table.mount('/mnt/scratch', described(
  { source: 'tmpfs', type: 'tmpfs', options: ['rw', 'noexec'] },
  async () => ({ size: 64 * 2 ** 20, used: 2 ** 20, available: 63 * 2 ** 20 }),
));
const laptop = described(
  { source: 'laptop:/Users/me', type: 'kinu-pc', options: ['rw', 'nosuid'] },
  async () => ({ size: 500 * GiB, used: 123 * GiB, available: 377 * GiB }),
);
laptop.mkdir('/projects');
table.mount('/pc/laptop', laptop);
// A per-principal source: Kinu's /context is resolved for each reader.
const context = described({ source: 'kinu', type: 'kinu-context', options: ['ro'] }, async () => null);
table.mount('/context', (principal) => { creds.push(principal.cred?.uid); return context; });

const run = async (command) => {
  const result = await ws.exec(command);
  return { ...result, lines: result.stdout.split('\n').filter(Boolean) };
};
const columns = (line) => line.trim().split(/\s+/);
const kib = (bytes) => Math.ceil(bytes / 1024);

// ── df: every mount with usage, GNU columns, 1K blocks rounded up ──────────
{
  const df = await run('df');
  assert.equal(df.exitCode, 0, df.stderr);
  assert.equal(df.lines[0], 'Filesystem       1K-blocks      Used Available Use% Mounted on');
  assert.deepEqual(df.lines.slice(1).map((line) => columns(line).at(-1)), ['/', '/mnt/scratch', '/pc/laptop']);
  const root = columns(df.lines[1]);
  // The session's storage ledger (N18): Used is everything it counts, and
  // Available leaves the kernel's reserve out, as ext4 leaves root's out.
  const ledger = ws.vfs.ledger;
  const used = ledger.view().used;
  const available = DO_STORAGE_LIMIT_BYTES - ledger.kernelReserve - used;
  assert.deepEqual(root, [
    'nimbus',
    String(kib(DO_STORAGE_LIMIT_BYTES)),
    String(kib(used)),
    String(kib(available)),
    `${Math.ceil((used * 100) / (used + available))}%`,
    '/',
  ]);
  assert.equal(df.lines[2], 'tmpfs                65536      1024     64512   2% /mnt/scratch');
  assert.equal(df.lines[3], 'laptop:/Users/me 524288000 128974848 395313152  25% /pc/laptop');
}

// ── df -a: entries without usage too, unknown values as '-' ────────────────
{
  const df = await run('df -a');
  assert.equal(df.exitCode, 0, df.stderr);
  assert.deepEqual(
    df.lines.slice(1).map((line) => columns(line).at(-1)),
    ['/', '/proc', '/dev', '/mnt/scratch', '/pc/laptop', '/context'],
  );
  assert.deepEqual(columns(df.lines[2]), ['proc', '-', '-', '-', '-', '/proc']);
  assert.deepEqual(columns(df.lines[6]), ['kinu', '-', '-', '-', '-', '/context']);
}

// ── df <path>: the mount the path lives on, by longest prefix ──────────────
{
  const df = await run('df -h /pc/laptop/projects');
  assert.equal(df.exitCode, 0, df.stderr);
  assert.equal(df.stdout, [
    'Filesystem        Size  Used Avail Use% Mounted on',
    'laptop:/Users/me  500G  123G  377G  25% /pc/laptop',
    '',
  ].join('\n'));

  const proc = await run('df /proc/uptime');
  assert.equal(proc.exitCode, 0, proc.stderr);
  assert.deepEqual(columns(proc.lines[1]), ['proc', '-', '-', '-', '-', '/proc']);

  const home = await run('df .');
  assert.equal(home.exitCode, 0, home.stderr);
  assert.equal(columns(home.lines[1]).at(-1), '/');

  // Named explicitly, a mount without usage is shown.
  const typed = await run('df -T /context');
  assert.equal(typed.exitCode, 0, typed.stderr);
  assert.equal(typed.stdout, [
    'Filesystem     Type         1K-blocks  Used Available Use% Mounted on',
    'kinu           kinu-context         -     -         -    - /context',
    '',
  ].join('\n'));

  const missing = await run('df /nowhere');
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, "df: /nowhere: No such file or directory\n");
}

// ── df -h -T -a combine as one flag cluster ────────────────────────────────
{
  const df = await run('df -haT');
  assert.equal(df.exitCode, 0, df.stderr);
  assert.match(df.lines[0], /^Filesystem\s+Type\s+Size\s+Used\s+Avail\s+Use%\s+Mounted on$/);
  assert.deepEqual(columns(df.lines[5]), ['laptop:/Users/me', 'kinu-pc', '500G', '123G', '377G', '25%', '/pc/laptop']);
  assert.deepEqual(columns(df.lines[4]), ['tmpfs', 'tmpfs', '64M', '1.0M', '63M', '2%', '/mnt/scratch']);
  assert.equal(columns(df.lines[1])[2], '9.4G', 'the 10 GB store limit in binary units, rounded up');
}

// ── mount: util-linux's listing ─────────────────────────────────────────────
{
  const mount = await run('mount');
  assert.equal(mount.exitCode, 0, mount.stderr);
  assert.equal(mount.stdout, [
    'nimbus on / type nimbus-sqlite (rw)',
    'proc on /proc type proc (ro)',
    'devtmpfs on /dev type devtmpfs (rw)',
    'tmpfs on /mnt/scratch type tmpfs (rw,noexec)',
    'laptop:/Users/me on /pc/laptop type kinu-pc (rw,nosuid)',
    'kinu on /context type kinu-context (ro)',
    '',
  ].join('\n'));
  const filtered = await run('mount -t kinu-pc');
  assert.equal(filtered.stdout, 'laptop:/Users/me on /pc/laptop type kinu-pc (rw,nosuid)\n');
  const refused = await run('mount /dev/sdb /mnt');
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /^mount: /);
}

// ── /proc/mounts: the kernel's format, from the same listing, no usage ─────────────────────────────
{
  creds.length = 0;
  const proc = await run('cat /proc/mounts');
  assert.equal(proc.exitCode, 0, proc.stderr);
  assert.equal(proc.stdout, [
    'nimbus / nimbus-sqlite rw 0 0',
    'proc /proc proc ro 0 0',
    'devtmpfs /dev devtmpfs rw 0 0',
    'tmpfs /mnt/scratch tmpfs rw,noexec 0 0',
    'laptop:/Users/me /pc/laptop kinu-pc rw,nosuid 0 0',
    'kinu /context kinu-context ro 0 0',
    '',
  ].join('\n'));
  // Listed for the reading process's credential, as the embedder's per-user table needs.
  assert.ok(creds.length > 0 && creds.every((uid) => uid === 1000), `listed for uids ${creds}`);
}

await ws.close();
console.log('filesystem-mount-listing: all assertions passed');
