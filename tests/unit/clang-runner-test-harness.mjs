// Shared harness for the clang-runner unit tests.
//
// Builds a session VFS with an installed clang runtime (the three blobs the
// manifest names) and a loader whose facet returns a plausible object file, so
// a test can drive the real `clangBinHandler` end to end without a wasm boot.

import { makeClangRunnerFactory } from '../../packages/worker/src/runtime/clang-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

export const USER = Object.freeze({
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

export function makeInvocationVfs() {
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
      ctx: { id: { toString: () => 'clang-runner-test' } },
    },
    vfs: raw,
  })(MANIFEST, '/runtime/clang', 'clang', undefined);

  return { root, run, user };
}

export function commandContext(args) {
  let stderr = '';
  let stdout = '';
  return {
    ctx: {
      cred: USER,
      args,
      cwd: '/home/user',
      env: {},
      stdin: '',
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } },
    },
    stderr: () => stderr,
    stdout: () => stdout,
  };
}
