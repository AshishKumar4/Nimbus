#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { makeCPythonRunnerFactory } from '../../packages/core/src/runtime/cpython-runner.ts';
import { loaderFacetHost } from '../../packages/worker/src/runtime/facet-loader-host.ts';
import { makeRubyRunnerFactory } from '../../packages/core/src/runtime/ruby-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { ExecutionFs } from '../../packages/core/src/shell/execution-fs.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

/** A session whose runtime blobs are installed, as the supervisor installs them. */
function installedRuntime(files) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  root.mkdir('home/user', { recursive: true, mode: 0o755 });
  root.chown('home/user', USER.uid, USER.gid);
  for (const [path, bytes] of Object.entries(files)) {
    const clean = path.replace(/^\/+/, '');
    root.mkdir(clean.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o755 });
    root.writeFile(clean, bytes, { mode: 0o644 });
  }
  return new SqliteFilesystemAuthority(raw);
}

function loaderHarness() {
  const calls = [];
  const env = {
    LOADER: {
      get() {
        return {
          getEntrypoint() {
            return {
              async execute(args) {
                calls.push(args);
                return { exitCode: 0, stdout: '', stderr: '' };
              },
            };
          },
        };
      },
    },
  };
  const ctx = { id: { toString: () => 'unit-runtime-home' }, waitUntil() {} };
  return { calls, env, ctx, facetMgr: { env, ctx } };
}

function commandContext(filesystem, env, cred = USER) {
  return {
    pid: 41,
    cred,
    vfs: new ExecutionFs(filesystem.bind({ pid: 41, cred })),
    args: ['-e', 'puts ENV["HOME"]'],
    cwd: '/home/user',
    env,
    stdin: '',
    stdout: { write() {} },
    stderr: { write() {} },
  };
}

{
  const harness = loaderHarness();
  const filesystem = installedRuntime({
    '/runtime/python/share/cpython/python.wasm': new Uint8Array([0]),
    '/runtime/python/lib/python313.zip': new Uint8Array(),
  });
  const manifest = {
    version: '0.29.4',
    files: [
      { path: 'share/cpython/python.wasm' },
      { path: 'lib/python313.zip' },
    ],
    runtime_artifacts: [{
      id: 'pyodide-0.29.4-workerd-adapter-v2',
      kind: 'workerd-adapter',
    }],
  };
  const run = makeCPythonRunnerFactory({ facets: loaderFacetHost(harness.env, harness.ctx) })(
    manifest,
    '/runtime/python',
    'python',
    undefined,
  );
  const ctx = commandContext(filesystem, { HOME: '/home/pyodide' });
  ctx.args = ['-c', 'print(1)'];
  assert.equal(await run(ctx), 0);
  assert.equal(harness.calls[0].userEnv.HOME, '/home/pyodide');
  const defaultCtx = commandContext(filesystem, {});
  defaultCtx.args = ['-c', 'print(1)'];
  assert.equal(await run(defaultCtx), 0);
  assert.equal(harness.calls[1].userEnv.HOME, '/home/user');
}

{
  const harness = loaderHarness();
  const filesystem = installedRuntime({
    '/runtime/ruby/share/ruby/ruby+stdlib.wasm': new Uint8Array([0]),
  });
  const manifest = {
    files: [{ path: 'share/ruby/ruby+stdlib.wasm' }],
  };
  const run = await makeRubyRunnerFactory({ facets: loaderFacetHost(harness.env, harness.ctx), filesystem })(
    manifest,
    '/runtime/ruby',
    'ruby',
    undefined,
  );
  assert.equal(await run(commandContext(filesystem, { HOME: '/home/ruby' })), 0);
  assert.equal(harness.calls[0].userEnv.HOME, '/home/ruby');
  assert.equal(await run(commandContext(filesystem, {})), 0);
  assert.equal(harness.calls[1].userEnv.HOME, '/home/user');
}

console.log('runtime-home-env: ok');
