// Shared harness for the clang-runner unit tests.
//
// Builds a session VFS with an installed clang runtime (the three blobs the
// manifest names, the sysroot a real ustar archive) and a facet host whose
// facet does what the toolchain does through its supervisor — read every
// input and write the -o path AS THE CALLER — so a test can drive the real
// `clangBinHandler` end to end without a wasm boot.

import { makeClangRunnerFactory } from '../../../packages/core/src/runtime/clang-runner.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { ProcessView } from '../../../packages/core/src/runtime/process-files.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { ustarArchive, ustarPath } from './ustar.mjs';

export const USER = Object.freeze({
  uid: 1000,
  gid: 1000,
  groups: Object.freeze([1000]),
  umask: 0o022,
});

/** The installed clang runtime, as its manifest names its files (the runner reads only their paths). */
/** @type {import('../../../packages/core/src/runtime/runtime-manifest.ts').RuntimeManifest} */
const MANIFEST = {
  name: 'clang',
  version: 'fixture',
  license: 'fixture',
  wasi_namespace: 'wasi_unstable',
  files: ['bin/clang', 'bin/wasm-ld', 'share/clang/sysroot.tar'].map((path) => ({ path, content: path, sha256: '0'.repeat(64), size: 0 })),
  entrypoints: [],
};

/** What clang-runner insists the archive carries before it unpacks it. */
export const SYSROOT_FILES = Object.freeze({
  'include/stdio.h': 'int printf(const char *, ...);\n',
  'include/c++/v1/vector': '// libc++\n',
  'lib/clang/8.0.1/include/stddef.h': 'typedef unsigned long size_t;\n',
  'lib/wasm32-wasi/crt1.o': '\0asm-crt1',
  // Larger than one 64 KiB chunk, so its chunks are several views of one
  // buffer — the shape the live archive's libc.a has.
  'lib/wasm32-wasi/libc.a': `!<arch>\n${'libc-archive-bytes\n'.repeat(8000)}`,
  'lib/wasm32-wasi/libc.imports': 'fd_write\n',
  'lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a': '!<arch>\n',
});

/** A POSIX ustar archive of `files` (path → text), rootless like the shipped one. */
export function buildUstar(files) {
  return ustarArchive(Object.entries(files).map(([path, text]) => ({ ...ustarPath(path), data: new TextEncoder().encode(text) })));
}

/**
 * The facet the harness opens: it never boots wasm, but it touches the
 * filesystem exactly the way the toolchain would, through the caller-bound
 * bridge the runner handed it as `syscalls.vfs`. Each positional input in
 * argv is read and the `-o` path is written, so a read the caller may not
 * make or a directory the caller may not write fails the "compile"; so does
 * a source that says `#error`, as the compiler would.
 *
 * @param {import('../../../packages/core/src/runtime/facet-host.ts').FacetSpec} spec
 * @param {Array<{ tag: string, argv: string[] }>} calls
 * @param {string[]} disposed
 * @returns {import('../../../packages/core/src/runtime/clang-runner.ts').ClangFacet}
 */
function toolchainFacet(spec, calls, disposed) {
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
          const bytes = await fs.readFile(input.replace(/^\/+/, ''));
          if (bytes === null) {
            await spec.syscalls.processes.appendOutputBytes(spec.syscalls.pid, 'stderr', new TextEncoder().encode(`${spec.tag}: error: ${input}: ENOENT\n`));
            return { exitCode: 1, stdout: '', stderr: '' };
          }
          if (new TextDecoder().decode(bytes).includes('#error')) {
            await spec.syscalls.processes.appendOutputBytes(spec.syscalls.pid, 'stderr', new TextEncoder().encode(`${input}:1:2: error: #error\n`));
            return { exitCode: 1, stdout: '', stderr: '' };
          }
        }
        // path_open creates the file, never its directory.
        await fs.writeFile(output.replace(/^\/+/, ''), new TextEncoder().encode('\0asm'), { createParents: false });
      } catch (error) {
        await spec.syscalls.processes.appendOutputBytes(spec.syscalls.pid, 'stderr', new TextEncoder().encode(`${spec.tag}: error: ${error.message}\n`));
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    dispose() { disposed.push(spec.tag); },
  };
}

/**
 * The sysroot unpack crosses a supervisor RPC hop live, and workerd
 * TRANSFERS every chunk's ArrayBuffer it streams: a view the producer still
 * holds into that buffer is detached once the wave has gone. The harness has
 * no hop, so its host lease's writeStream consumes each batch the same way —
 * transferring the buffers of the chunks it receives — and a producer that
 * hands over views into a buffer it means to keep using fails here as it
 * fails live.
 */
function detachingAuthority(authority) {
  const openHost = authority.openHost.bind(authority);
  authority.openHost = (cred) => {
    const lease = openHost(cred);
    const fs = lease.fs;
    const writeStream = fs.writeStream.bind(fs);
    fs.writeStream = (stream, options) => {
      const reader = stream.getReader();
      const transferred = new ReadableStream({
        type: 'bytes',
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(structuredClone(value, { transfer: [value.buffer] }));
        },
      });
      return writeStream(transferred, options);
    };
    return lease;
  };
  return authority;
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
  // The facets the runner opened and disposed, by tag (clang-runner-clang, clang-runner-wasm-ld).
  const opened = [];
  const disposed = [];
  /** @type {Parameters<typeof makeClangRunnerFactory>[0]['facets']} */
  const facets = {
    open(spec) { opened.push(spec.tag); return toolchainFacet(spec, calls, disposed); },
  };
  const filesystem = detachingAuthority(new ProcessFiles(raw));
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(16);
  const handler = makeClangRunnerFactory({ facets, filesystem, processes })(
    MANIFEST, '/runtime/clang', 'clang', undefined,
  );

  const run = async ctx => {
    const parent = processes.spawn('sh', ['sh'], ctx.cwd || '/home/user', { cred: ctx.cred });
    try { return await handler({ ...ctx, pid: parent.pid, vfs: new ProcessView(filesystem.bind({ pid: parent.pid, cred: ctx.cred })) }); }
    finally { processes.exit(parent.pid, 0); }
  };
  return { root, run, user, calls, opened, disposed };
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
