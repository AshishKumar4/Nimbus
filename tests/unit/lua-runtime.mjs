#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { seedRuntime } from './lib/wasm-runtimes.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SPECS } from '../../packages/worker/scripts/runtime-specs.mjs';
import { files, successCommand, failureCommand, success, failure, version } from '../fixtures/lua-cli.mjs';

const dir = new URL('../../packages/worker/wasm/lua/', import.meta.url).pathname;
const spec = SPECS[`lua/${version}`];
const nativeLua = process.env.NIMBUS_NATIVE_LUA;
const { src, vfs, runner, binName, sha256 } = spec.files[0];
assert.equal(createHash('sha256').update(readFileSync(join(dir, src))).digest('hex'), sha256, 'test the pinned guest');

const scratch = mkdtempSync(join(tmpdir(), 'lua-diff-'));
const cwd = '/home/user/lua-project';
const db = new Database(':memory:');
const harness = createSqliteVfsTestHarness(db);
const open = (options) => NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, generation: 1, cwd: '/home/user', ...options });
let ws;
try {
  if (nativeLua) for (const [file, content] of Object.entries(files)) writeFileSync(join(scratch, file), content);

  ws = await open({});
  seedRuntime(ws.vfs, {
    name: 'lua', version, license: spec.license, entrypoints: [{ binName, runner, args: [] }],
    files: [[vfs, join(dir, src)], ['LICENSE', join(dir, 'LICENSE')]],
  });
  const root = ws.vfs.as(CRED_KERNEL);
  root.mkdir(cwd.slice(1), { recursive: true });
  root.chown(cwd.slice(1), 1000, 1000);
  for (const [file, content] of Object.entries(files)) await ws.fs.writeFile(`${cwd}/${file}`, content);
  await ws.close();
  ws = await open({ facets: localFacetHost(ISOLATE_NETWORK) });

  for (const [command, expected] of [[successCommand, success], [failureCommand, failure]]) {
    let oracle = expected;
    if (nativeLua) {
      const native = spawnSync('bash', ['-c', `lua() { "$NIMBUS_NATIVE_LUA" "$@"; }; ${command}`], {
        cwd: scratch, encoding: 'utf8', timeout: 5_000,
      });
      assert.ifError(native.error);
      oracle = { exitCode: native.status, stdout: native.stdout, stderr: native.stderr };
      assert.deepEqual(oracle, expected, `native Lua: ${command}`);
    }
    const { exitCode, stdout, stderr } = await ws.exec(command, { cwd, timeout: 15_000 });
    assert.deepEqual({ exitCode, stdout, stderr }, oracle, `Nimbus: ${command}`);
    console.log(`ok: exit ${exitCode}, stdout and stderr match ${nativeLua ? 'native Lua' : 'fixture'}: ${command}`);
  }
} finally {
  try { await ws?.close(); } finally {
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
