#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { registerUnixCommands } from '../../packages/worker/src/shell/unix-commands.ts';
import { createDefaultRegistry } from '../../packages/worker/src/substrate/lifo/commands/registry.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-session-seed-test-'));

try {
  const build = await Bun.build({
    entrypoints: ['./packages/worker/src/session/nimbus-session.ts'],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'cloudflare-workers',
          namespace: 'test',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
          loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));

  const entry = build.outputs.find((output) => output.path.endsWith('/nimbus-session.js'));
  assert.ok(entry, 'the session entry bundle was emitted');
  const { NimbusSession } = await import(pathToFileURL(entry.path).href);

  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const insecureUserVfs = rawVfs.as(USER);
  insecureUserVfs.mkdir('etc', { mode: 0o777 });
  insecureUserVfs.writeFile(
    'etc/passwd',
    'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:User:/home/user:/bin/sh\n',
  );
  insecureUserVfs.writeFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');
  insecureUserVfs.chmod('etc/passwd', 0o666);
  insecureUserVfs.chmod('etc/group', 0o666);

  const session = Object.create(NimbusSession.prototype);
  session.sqliteFs = rawVfs;
  session.seedFilesystem();

  const rootVfs = rawVfs.as(CRED_KERNEL);
  const userVfs = rawVfs.as(USER);
  const etc = rootVfs.stat('etc');
  assert.deepEqual(
    { uid: etc.uid, gid: etc.gid, mode: etc.mode & 0o7777 },
    { uid: 0, gid: 0, mode: 0o755 },
    '/etc is a root-owned non-writable system directory',
  );
  for (const accountFile of ['etc/passwd', 'etc/group']) {
    const stat = rootVfs.stat(accountFile);
    assert.deepEqual(
      { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 },
      { uid: 0, gid: 0, mode: 0o644 },
      `${accountFile} is repaired to the canonical root-owned seed metadata`,
    );
  }
  assert.deepEqual(
    { uid: rootVfs.stat('bin').uid, gid: rootVfs.stat('bin').gid },
    { uid: 1000, gid: 1000 },
    'other system trees retain user ownership',
  );
  assert.deepEqual(
    { uid: rootVfs.stat('usr').uid, gid: rootVfs.stat('usr').gid },
    { uid: 1000, gid: 1000 },
    'only /etc is special-cased',
  );

  const registry = createDefaultRegistry();
  registerUnixCommands(registry, rawVfs);

  const deniedAppend = await run('tee', ['-a', '/etc/passwd'], USER, 'tampered\n');
  assert.equal(deniedAppend.exitCode, 1, 'user cannot append to /etc/passwd');
  assert.match(deniedAppend.stderr, /EACCES|Permission denied/);
  assert.doesNotMatch(rootVfs.readFileString('etc/passwd'), /tampered/);

  const deniedRm = await run('rm', ['/etc/passwd'], USER);
  assert.equal(deniedRm.exitCode, 1, 'user cannot unlink /etc/passwd');
  assert.match(deniedRm.stderr, /EACCES|Permission denied/);
  assert.equal(rootVfs.exists('etc/passwd'), true, 'denied unlink leaves passwd intact');

  const elevatedAppend = await run('sudo', ['tee', '-a', '/etc/passwd'], USER, 'root append\n');
  assert.equal(elevatedAppend.exitCode, 0, 'sudo may append to /etc/passwd');
  assert.match(rootVfs.readFileString('etc/passwd'), /root append\n$/);

  const elevatedRm = await run('sudo', ['rm', '/etc/passwd'], USER);
  assert.equal(elevatedRm.exitCode, 0, 'sudo may unlink /etc/passwd');
  assert.equal(rootVfs.exists('etc/passwd'), false);

  async function run(name, args, cred, stdin = '') {
    const command = await registry.resolve(name);
    assert.ok(command, `${name} is registered`);
    let stdout = '';
    let stderr = '';
    const exitCode = await command({
      pid: cred.uid === 0 ? 2 : 1,
      cred,
      args,
      env: {},
      cwd: '/',
      stdin,
      vfs: rawVfs.as(cred),
      stdout: { write: (value) => { stdout += String(value); } },
      stderr: { write: (value) => { stderr += String(value); } },
      signal: new AbortController().signal,
      setUmask() {},
      runAs: async (targetCred, targetArgv) => {
        const result = await run(targetArgv[0], targetArgv.slice(1), targetCred, stdin);
        stdout += result.stdout;
        stderr += result.stderr;
        return result.exitCode;
      },
    });
    return { exitCode, stdout, stderr };
  }
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

console.log('session filesystem seed permissions: ok');
