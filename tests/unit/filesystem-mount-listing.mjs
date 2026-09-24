#!/usr/bin/env bun
// The filesystem authority's mount listing is what df, mount and /proc/mounts
// read. It derives from the kernel mount table: the SQLite directories are one
// `/` entry with real usage, /proc, /dev and any kernel mount an embedder adds
// are listed as their providers describe them. An embedder wrapping the
// authority (Kinu mounts /pc/<name>, /context, ...) extends the listing by
// overriding `mounts` and calling super.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { DO_STORAGE_LIMIT_BYTES } from '../../packages/platform/src/limits.ts';

const GiB = 2 ** 30;
const creds = [];

// Kinu's shape: a subclass constructed over the base authority's disk.
class HostMountsAuthority extends SqliteFilesystemAuthority {
  mounts(cred) {
    creds.push(cred.uid);
    return [
      ...super.mounts(cred),
      {
        mountPoint: '/pc/laptop',
        source: 'laptop:/Users/me',
        type: 'kinu-pc',
        options: ['rw', 'nosuid'],
        usage: async () => ({ size: 500 * GiB, used: 123 * GiB, available: 377 * GiB }),
      },
      { mountPoint: '/context', source: 'kinu', type: 'kinu-context', options: ['ro'], usage: async () => null },
    ];
  }
}

const db = new Database(':memory:');
const harness = createSqliteVfsTestHarness(db);
// workerd's SqlStorage reports the database's size; bun:sqlite answers the same question by pragma.
const pragma = (name) => Number(Object.values(db.query(`PRAGMA ${name}`).get())[0]);
const databaseSize = () => pragma('page_count') * pragma('page_size');
const sql = { exec: harness.sql.exec, get databaseSize() { return databaseSize(); } };

const ws = await NimbusWorkspace.create({
  sql,
  transactions: harness.ctx,
  filesystem: (base) => new HostMountsAuthority(base.vfs),
});
ws.vfs.as(CRED_KERNEL).mkdir('/pc/laptop/projects', { recursive: true });
ws.vfs.as(CRED_KERNEL).mkdir('/context', { recursive: true });
// An embedder's kernel mount, whose provider reports usage.
ws.kernel.vfs.mount('/mnt/scratch', {
  exists: (subpath) => subpath === '/' || subpath === '',
  stat: () => ({ type: 'directory', size: 0, ctime: 0, mtime: 0, mode: 0o755 }),
  readdir: () => [],
  readFile: () => new Uint8Array(0),
  readFileString: () => '',
  describeMount: () => ({
    source: 'tmpfs', type: 'tmpfs', options: ['rw', 'noexec'],
    usage: async () => ({ size: 64 * 2 ** 20, used: 2 ** 20, available: 63 * 2 ** 20 }),
  }),
});

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
  const used = ws.stats().usedBytes;
  const available = DO_STORAGE_LIMIT_BYTES - databaseSize();
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
    ['/', '/dev', '/mnt/scratch', '/proc', '/pc/laptop', '/context'],
  );
  assert.deepEqual(columns(df.lines[4]), ['proc', '-', '-', '-', '-', '/proc']);
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
  assert.deepEqual(columns(df.lines[3]), ['tmpfs', 'tmpfs', '64M', '1.0M', '63M', '2%', '/mnt/scratch']);
  assert.equal(columns(df.lines[1])[2], '9.4G', 'the 10 GB store limit in binary units, rounded up');
}

// ── mount: util-linux's listing ─────────────────────────────────────────────
{
  const mount = await run('mount');
  assert.equal(mount.exitCode, 0, mount.stderr);
  assert.equal(mount.stdout, [
    'nimbus on / type nimbus-sqlite (rw)',
    'devtmpfs on /dev type devtmpfs (rw)',
    'tmpfs on /mnt/scratch type tmpfs (rw,noexec)',
    'proc on /proc type proc (ro)',
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
    'devtmpfs /dev devtmpfs rw 0 0',
    'tmpfs /mnt/scratch tmpfs rw,noexec 0 0',
    'proc /proc proc ro 0 0',
    'laptop:/Users/me /pc/laptop kinu-pc rw,nosuid 0 0',
    'kinu /context kinu-context ro 0 0',
    '',
  ].join('\n'));
  // Listed for the reading process's credential, as the embedder's per-user table needs.
  assert.ok(creds.length > 0 && creds.every((uid) => uid === 1000), `listed for uids ${creds}`);
}

await ws.close();
console.log('filesystem-mount-listing: all assertions passed');
