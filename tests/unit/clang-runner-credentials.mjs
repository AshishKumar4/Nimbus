#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { makeClangRunnerFactory } from '../../packages/worker/src/runtime/clang-runner.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({
  uid: 1000,
  gid: 1000,
  groups: Object.freeze([1000]),
  umask: 0o022,
});

const MANIFEST = {
  files: [
    { path: 'bin/clang' },
    { path: 'bin/wasm-ld' },
    { path: 'share/clang/sysroot.tar' },
  ],
};

function makeInvocationVfs() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  const user = raw.as(USER);

  root.mkdir('runtime/clang/bin', { recursive: true });
  root.mkdir('runtime/clang/share/clang', { recursive: true });
  root.writeFile('runtime/clang/bin/clang', new Uint8Array([0]), { mode: 0o600 });
  root.writeFile('runtime/clang/bin/wasm-ld', new Uint8Array([0]), { mode: 0o600 });
  root.writeFile('runtime/clang/share/clang/sysroot.tar', new Uint8Array(1024), { mode: 0o600 });

  root.mkdir('home/user', { recursive: true, mode: 0o777 });
  root.chown('home/user', USER.uid, USER.gid);
  root.chmod('home/user', 0o755);

  const loader = {
    get() {
      return {
        getEntrypoint() {
          return {
            async execute(args) {
              const outputPath = args.outputPaths[0];
              return {
                exitCode: 0,
                stdout: '',
                stderr: '',
                outputFiles: { [outputPath]: btoa('\0asm') },
              };
            },
          };
        },
      };
    },
  };
  const run = makeClangRunnerFactory({
    facetMgr: {
      env: { LOADER: loader },
      ctx: { id: { toString: () => 'clang-credential-test' } },
    },
    vfs: raw,
  })(MANIFEST, '/runtime/clang', 'clang', undefined);

  return { root, run, user };
}

function commandContext(args) {
  let stderr = '';
  return {
    ctx: {
      cred: USER,
      args,
      cwd: '/home/user',
      env: {},
      stdin: '',
      stdout: { write() {} },
      stderr: { write(value) { stderr += String(value); } },
    },
    stderr: () => stderr,
  };
}

async function expectEacces(run, args) {
  const invocation = commandContext(args);
  assert.equal(await run(invocation.ctx), 1);
  assert.match(invocation.stderr(), /EACCES:/);
}

// Installed runtime blobs are supervisor-owned assets and remain readable through the kernel view.
{
  const { run, user } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  assert.equal(await run(commandContext(['main.c', '-o', 'main.wasm']).ctx), 0);
  assert.equal(user.exists('home/user/main.wasm'), true);
}

// Source lookup must not use the kernel view to traverse a directory hidden from the caller.
{
  const { root, run } = makeInvocationVfs();
  root.mkdir('home/user/private', { mode: 0o700 });
  root.writeFile('home/user/private/main.c', 'int main(void) { return 0; }', { mode: 0o644 });
  await expectEacces(run, ['private/main.c']);
}

// Source reads must enforce the caller's read permission after a successful lookup.
{
  const { root, run } = makeInvocationVfs();
  root.writeFile('home/user/main.c', 'int main(void) { return 0; }', { mode: 0o600 });
  await expectEacces(run, ['main.c']);
}

// Compiler outputs must be authorized as the caller, not as the supervisor.
{
  const { root, run, user } = makeInvocationVfs();
  user.writeFile('home/user/main.c', 'int main(void) { return 0; }');
  root.mkdir('home/user/locked', { mode: 0o555 });
  await expectEacces(run, ['main.c', '-o', 'locked/main.wasm']);
  assert.equal(root.exists('home/user/locked/main.wasm'), false);
}

console.log('clang-runner credentials: ok');
