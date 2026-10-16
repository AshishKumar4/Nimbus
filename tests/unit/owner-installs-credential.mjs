#!/usr/bin/env bun
// What a user installed is read, and written, as that user, never as the
// kernel. The workspace reads no global package as it composes (npm's bins
// are found on PATH, as the caller), so a package.json linked to a file only
// root may read registers nothing; `npm install -g` writes its bin shims as
// the process that ran it. Red before: both acted as CRED_KERNEL, so the
// shims were root's, and a linked package.json was read past its permissions.

import assert from 'node:assert/strict';
import { NimbusWorkspace, seedBaseFilesystem } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createNpmInstallPort } from '../../packages/worker/src/session/npm-install-port.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = CRED_SESSION_USER.uid;

// ── the boot reads no global package ──────────────────────────────────────
{
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  const user = vfs.as(CRED_SESSION_USER);
  // The OS the workspace boots on: /usr is the user's, /etc root's.
  seedBaseFilesystem(vfs);
  kernel.writeFile('etc/secret.json', JSON.stringify({ name: 'leaky', bin: { 'leaked-name': 'cli.js' } }), { mode: 0o600 });
  // Packages the user put in the global folder (root's, as on Linux) through sudo.
  for (const name of ['leaky', 'fine']) {
    kernel.mkdir(`usr/lib/node_modules/${name}`, { mode: 0o755 });
    kernel.chown(`usr/lib/node_modules/${name}`, USER, USER);
    user.writeFile(`usr/lib/node_modules/${name}/cli.js`, 'console.log(1)\n');
  }
  user.symlink('/etc/secret.json', 'usr/lib/node_modules/leaky/package.json');
  user.writeFile('usr/lib/node_modules/fine/package.json', JSON.stringify({ name: 'fine', bin: { 'fine-name': 'cli.js' } }));
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs });
  try {
    assert.equal(ws.registry.has('fine-name'), false, 'the boot registers no global package\'s command: npm links bins onto PATH');
    assert.equal(ws.registry.has('leaked-name'), false, 'a package.json its user cannot read registers nothing');
  } finally {
    await ws.close();
  }
  console.log('  the boot reads no global package');
}

// ── npm install -g writes its bin shims as the process that ran it ────────
// Over a prefix of its own, and over one where a release through worker
// 0.17.0 left the shims and their manifest as root.
for (const legacy of [false, true]) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  const user = vfs.as(CRED_SESSION_USER);
  // The default prefix, /usr/local, is the user's.
  seedBaseFilesystem(vfs);
  user.mkdir('usr/local/lib/node_modules/tool');
  user.writeFile('usr/local/lib/node_modules/tool/package.json', JSON.stringify({ name: 'tool', version: '1.0.0', bin: { tool: 'cli.js' } }));
  user.writeFile('usr/local/lib/node_modules/tool/cli.js', 'console.log(1)\n');
  if (legacy) {
    kernel.writeFile('usr/local/bin/tool', '#!/bin/sh\n', { mode: 0o755 });
    kernel.writeFile('usr/local/bin/.nimbus-bin-map.json', '{}\n', { mode: 0o644 });
  }
  const processes = new SessionProcessSupervisor();
  const entry = processes.spawn('npm install -g tool', ['npm', 'install', '-g', 'tool'], '/home/user', { cred: CRED_SESSION_USER });
  const files = new ProcessFiles(vfs);
  const port = createNpmInstallPort({
    ensureSqliteFs: () => vfs,
    // The tree is already in place: this installer only links its bins.
    ensureNpmInstaller: async () => ({
      async install(_cwd, options) {
        return { installed: 1, failed: 0, totalFiles: 0, cachedHits: 0, linkedBins: await options.whileHeld({}) };
      },
    }),
    ensureGlobalPrefixDirs() {},
    processes,
  }, files);
  const result = await port.install({ projectDir: '/home/user', packages: ['tool'], global: true, globalPrefix: '/usr/local', pid: entry.pid });
  assert.equal(result.linkedBins, 1, 'one bin linked');
  const shim = kernel.stat('usr/local/bin/tool');
  assert.equal(shim.uid, USER, "the shim is the installing process's, not root's");
  assert.equal(shim.mode & 0o777, 0o755, 'and executable');
  assert.equal(kernel.stat('usr/local/bin/.nimbus-bin-map.json').uid, USER, 'and so is the manifest');
  assert.match(kernel.readFileString('usr/local/bin/tool'), /cli\.js/, 'the shim is the one this install wrote');
}
console.log('  npm install -g writes its bin shims as the process that ran it');

console.log('owner-installs-credential: ok');
