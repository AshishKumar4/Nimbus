// Shared harness for the clang-runner unit tests.
//
// Builds a session VFS with an installed clang runtime (the three blobs the
// manifest names, the sysroot a real ustar archive) and a facet host whose
// facet does what the toolchain does through its supervisor — read every
// input and write the -o path AS THE CALLER — so a test can drive the real
// `clangBinHandler` end to end without a wasm boot.

import { makeClangRunnerFactory } from '../../packages/core/src/runtime/clang-runner.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { ExecutionFs } from '../../packages/core/src/shell/execution-fs.ts';
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

/** What clang-runner insists the archive carries before it unpacks it. */
export const SYSROOT_FILES = Object.freeze({
  'include/stdio.h': 'int printf(const char *, ...);\n',
  'include/c++/v1/vector': '// libc++\n',
  'lib/clang/8.0.1/include/stddef.h': 'typedef unsigned long size_t;\n',
  'lib/wasm32-wasi/crt1.o': '\0asm-crt1',
  'lib/wasm32-wasi/libc.a': '!<arch>\n',
  'lib/wasm32-wasi/libc.imports': 'fd_write\n',
  'lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a': '!<arch>\n',
});

/** A POSIX ustar archive of `files` (path → text), rootless like the shipped one. */
export function buildUstar(files) {
  const encoder = new TextEncoder();
  const blocks = [];
  for (const [path, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const header = new Uint8Array(512);
    const put = (offset, value) => header.set(encoder.encode(value), offset);
    put(0, path);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, data.length.toString(8).padStart(11, '0') + '\0');
    put(136, '00000000000\0');
    header[156] = 0x30;
    put(257, 'ustar\0');
    put(263, '00');
    put(148, '        ');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    put(148, checksum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) { out.set(block, offset); offset += block.length; }
  return out;
}

/**
 * The facet the harness opens: it never boots wasm, but it touches the
 * filesystem exactly the way the toolchain would, through the caller-bound
 * bridge the runner handed it as `syscalls.vfs`. Each positional input in
 * argv is read and the `-o` path is written, so a read the caller may not
 * make or a directory the caller may not write fails the "compile".
 */
function toolchainFacet(spec, calls) {
  if (!spec.syscalls || typeof spec.syscalls.pid !== 'number') {
    throw new Error('clang facet must be opened with the caller\'s syscalls');
  }
  const fs = spec.syscalls.vfs;
  return {
    async submit(_fn, args) {
      calls.push({ tag: spec.tag, argv: args.argv });
      const argv = args.argv;
      const output = argv[argv.indexOf('-o') + 1];
      const inputs = argv.filter((a, i) => !a.startsWith('-') && i > 0 && argv[i - 1] !== '-o'
        && !['-I', '-L', '-isysroot', '-internal-isystem', '-x', '-z', '-ferror-limit', '-fmessage-length'].includes(argv[i - 1])
        && /\.(c|cc|cpp|cxx|o|a)$/.test(a));
      try {
        for (const input of inputs) {
          if (await fs.readFile(input.replace(/^\/+/, '')) === null) {
            return { exitCode: 1, stdout: '', stderr: `${spec.tag}: error: ${input}: ENOENT\n` };
          }
        }
        // path_open creates the file, never its directory.
        await fs.writeFile(output.replace(/^\/+/, ''), new TextEncoder().encode('\0asm'), { createParents: false });
      } catch (error) {
        return { exitCode: 1, stdout: '', stderr: `${spec.tag}: error: ${error.message}\n` };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    dispose() {},
  };
}

export function makeInvocationVfs(options = {}) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const root = raw.as(CRED_KERNEL);
  const user = raw.as(USER);

  root.mkdir('runtime/clang/bin', { recursive: true });
  root.mkdir('runtime/clang/share/clang', { recursive: true });
  root.writeFile('runtime/clang/bin/clang', new Uint8Array([0]), { mode: 0o600 });
  root.writeFile('runtime/clang/bin/wasm-ld', new Uint8Array([0]), { mode: 0o600 });
  root.writeFile('runtime/clang/share/clang/sysroot.tar', buildUstar(options.sysroot ?? SYSROOT_FILES), { mode: 0o600 });

  root.mkdir('home/user', { recursive: true, mode: 0o777 });
  root.chown('home/user', USER.uid, USER.gid);
  root.chmod('home/user', 0o755);
  // The session's scratch tree, owned by the session user as the base seed
  // makes it; intermediate objects go there.
  root.mkdir('tmp', { mode: 0o777 });
  root.chown('tmp', USER.uid, USER.gid);

  const calls = [];
  const facets = {
    parking: 'none',
    open(spec) { return toolchainFacet(spec, calls); },
  };
  const filesystem = new SqliteFilesystemAuthority(raw);
  const handler = makeClangRunnerFactory({ facets, filesystem })(
    MANIFEST, '/runtime/clang', 'clang', undefined,
  );

  const run = ctx => handler({ ...ctx, vfs: new ExecutionFs(filesystem.bind({ pid: 17, cred: ctx.cred })) });
  return { root, run, user, calls };
}

export function commandContext(args) {
  let stderr = '';
  let stdout = '';
  return {
    ctx: {
      pid: 17,
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
