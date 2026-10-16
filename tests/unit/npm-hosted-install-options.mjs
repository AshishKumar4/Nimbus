#!/usr/bin/env bun
// What `npm install` asks of an install reaches the session's installer
// through the hosted install port whole: the cache mode `--offline`,
// `--prefer-offline` and `--prefer-online` set, and every other option the
// command gave the port, as given. Core's command, the hosted port and an
// installer that records what it was asked, as hosted/commands.ts composes
// them.
//
// Red before: the port rebuilt the installer's options field by field and
// left the cache mode out, so every hosted install ran in the default mode.

import assert from 'node:assert/strict';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createNpmInstallPort } from '../../packages/worker/src/session/npm-install-port.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const processes = new SessionProcessSupervisor();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes });

/** What the session's installer was asked, each install. */
const asked = [];
const port = createNpmInstallPort({
  ensureSqliteFs: () => vfs,
  ensureNpmInstaller: async () => ({
    async install(_cwd, options) {
      asked.push(options);
      return { installed: [], failed: [], totalFiles: 0, cachedHits: 0, linkedBins: 0 };
    },
  }),
  ensureGlobalPrefixDirs() {},
  processes,
}, ws.filesystem);
/** What the command gave the port, each install. */
const given = [];
ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel, {
  installer: { ...port, install: (spec) => { given.push(spec); return port.install(spec); } },
}));

const run = async (line) => {
  const r = await ws.exec(line);
  assert.equal(r.exitCode, 0, `${line}: ${r.stdout}${r.stderr}`);
};
await run('mkdir -p /home/user/proj');
vfs.as(CRED_SESSION_USER).writeFile('home/user/proj/package.json', JSON.stringify({ name: 'p', dependencies: {} }));

for (const [flags, mode] of [['', 'default'], ['--prefer-online', 'no-cache'], ['--prefer-offline', 'force-cache'], ['--offline', 'only-if-cached']]) {
  await run(`cd /home/user/proj && npm install ${flags} example`);
  assert.equal(asked.at(-1).cache, mode, `npm install ${flags}: the installer was not asked in ${mode}`);
}
await run('cd /home/user/proj && npm_config_prefer_online=true npm install example');
assert.equal(asked.at(-1).cache, 'no-cache', 'npm_config_prefer_online');

// Every option the command gave the port, as given; the port's own (where
// it installs, the global prefix, the log sink) aside.
await run('cd /home/user/proj && npm install --offline --save-dev --force --legacy-peer-deps --prefer-dedupe --save-exact --omit=optional --omit=peer --no-save example');
const spec = given.at(-1);
const options = asked.at(-1);
for (const [key, value] of Object.entries(spec)) {
  if (['projectDir', 'global', 'globalPrefix', 'npmLog'].includes(key)) continue;
  assert.deepEqual(options[key], value, `the port did not hand on ${key}`);
}

console.log('npm-hosted-install-options: ok');
