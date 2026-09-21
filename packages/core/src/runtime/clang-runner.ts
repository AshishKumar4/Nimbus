/**
 * clang-runner.ts — compile, link, and execute C programs for Nimbus WASI.
 *
 * Architecture (compile-link, two facet calls):
 *
 *   compile  : clang.wasm over the session filesystem → writes each
 *              translation unit's .o under a scratch directory in /tmp.
 *   link     : wasm-ld.wasm over the same filesystem → writes the final
 *              .wasm executable at the requested output path.
 *
 * The filesystem both halves see is the session authority, reached through
 * the same supervisor capability every other non-node runtime uses
 * (wasi-instance.ts): the facet is opened with the caller's pid, so a
 * source the caller cannot read stays unreadable and an output directory
 * the caller cannot write stays unwritten. Nothing is copied in or out.
 *
 * The sysroot (headers, crt1.o, libc.a, compiler-rt) ships as one ustar
 * archive in the installed runtime, `share/clang/sysroot.tar`, and is
 * unpacked ONCE per session into `share/clang/sysroot/` beside it — a
 * world-readable tree the toolchain is pointed at by absolute path. A missing or damaged archive is reported and the command exits;
 * there is no header set to fall back on.
 *
 * Splitting compile and link into separate facet calls keeps each wasm
 * image its own facet: 31 MiB clang.wasm, 19 MiB wasm-ld.wasm.
 *
 * Dispatch stays direct: no sleeps, no caller-side retries, and no
 * catch-and-continue around loader failures.
 */

import type { RuntimeManifest } from './runtime-manifest.js';
import { type ExecutionFs, withHostFilesystem } from '../shell/execution-fs.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { Facet, FacetBindings, FacetHost } from './facet-host.js';
import { CRED_KERNEL, WASM32_WASI_NIMBUS_ABI, type NimbusFilesystemAuthority } from './os-contracts.js';
import { normalizeVfsPath, resolveVfsPath } from '../vfs/path.js';
import { hasLeadingCliFlag } from './cli-flags.js';
import { WASI_ABI_NAMESPACE, WASI_INSTANCE_PREAMBLE_SRC } from './wasi-instance.js';
import { CHUNK_SIZE } from '@nimbus-sh/platform/limits.js';
import {
  encodeWriteBatchStream,
  W7_MAX_PATHS_PER_BATCH,
  type BatchChunkEntry,
  type BatchInodeEntry,
} from '@nimbus-sh/platform/w7-frame.js';

const CLANG_VERSION_FLAGS = new Set(['--version', '-v']);

/** Build the runner factory. Closes over the facet host and the filesystem authority. */
export function makeClangRunnerFactory(deps: {
  facets: FacetHost;
  filesystem: NimbusFilesystemAuthority;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) =>
    Command {

  return function clangRunnerFactory(manifest, installRoot, binName, binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };

    const clangVfsPath   = findFile('bin/clang');
    const lldVfsPath     = findFile('bin/wasm-ld');
    const sysrootVfsPath = findFile('share/clang/sysroot.tar');
    // Guest-visible: the toolchain is handed this as an absolute path.
    const sysrootDir = `/${normalizeVfsPath(`${installRoot}/${SYSROOT_DIR_REL}`)}`;
    let runtimePromise: Promise<ClangToolchain> | null = null;

    // Installed toolchain blobs are supervisor-owned artifacts, so they are read
    // through a kernel host lease that lives exactly as long as one invocation.
    return function clangBinHandler(ctx: CommandContext): Promise<number> {
      return withHostFilesystem(deps.filesystem, CRED_KERNEL, (runtimeVfs) => compileOrLink(ctx, runtimeVfs));
    };

    async function compileOrLink(ctx: CommandContext, runtimeVfs: ExecutionFs): Promise<number> {
      const vfs = ctx.vfs;
      const argv: string[] = ctx.args || [];
      const cwd: string = ctx.cwd || '/home/user';

      // Fast paths — no wasm boot.
      if (hasLeadingCliFlag(argv, CLANG_VERSION_FLAGS)) {
        ctx.stdout.write(`Nimbus wasm-clang (binji-2020, LLVM 8.0.1)\n`);
        ctx.stdout.write(`Target: ${WASM32_WASI_NIMBUS_ABI.id} (via wasm-ld linker)\n`);
        return 0;
      }
      if (argv.includes('--help') || argv.includes('-h')) {
        ctx.stdout.write(`usage: ${binName} [options] <source.c> -o <output>\n`);
        ctx.stdout.write(`Wasm-compiled clang/wasm-ld bundle for Nimbus.\n`);
        ctx.stdout.write(`Target: ${WASM32_WASI_NIMBUS_ABI.id}\n`);
        ctx.stdout.write(`Supported: C compilation + linking to wasm.\n`);
        return 0;
      }

      const isLinker = binKind === 'linker' || binName === 'wasm-ld';

      // Resolve bundle paths.
      if (!sysrootVfsPath || !(await runtimeVfs.exists(sysrootVfsPath))) {
        ctx.stderr.write(`${binName}: sysroot.tar missing from install\n`);
        return 127;
      }
      if (!clangVfsPath || !lldVfsPath) {
        ctx.stderr.write(`${binName}: clang/wasm-ld missing from install\n`);
        return 127;
      }

      // Parse argv: find input .c + output path.
      const parsed = parseUserArgv(argv);
      if (parsed.error) {
        ctx.stderr.write(`${binName}: ${parsed.error}\n`);
        return parsed.exitCode;
      }
      if (isLinker) {
        // Direct wasm-ld invocation: pass argv through (advanced
        // users only). Not on the hello-world path.
        ctx.stderr.write(`${binName}: direct wasm-ld invocation not yet wired (v1.2)\n`);
        return 2;
      }

      // Every input must resolve AS THE CALLER before a facet is opened: the
      // toolchain reads them through the same credential, but "No such file"
      // from clang's driver is a poorer message than the one the shell gives,
      // and a lookup the caller may not make must fail here, not in a guest.
      // Guest paths are absolute — the toolchain runs with the session root
      // as its only preopen and no notion of the shell's cwd.
      const sourceInputs: string[] = [];
      // Pre-built objects/archives the user passed (e.g. extra.o, libfoo.a)
      // — link inputs only.
      const preBuiltLinkInputs: string[] = [];
      for (const input of parsed.inputPaths) {
        const inputVfs = resolveVfsPath(input, cwd);
        try {
          if (!(await vfs.exists(inputVfs))) {
            ctx.stderr.write(`${binName}: ${input}: No such file or directory\n`);
            return 1;
          }
        } catch (error) {
          ctx.stderr.write(`${binName}: ${input}: ${errorMessage(error)}\n`);
          return 1;
        }
        if (isSourceExt(input)) sourceInputs.push(`/${inputVfs}`);
        else preBuiltLinkInputs.push(`/${inputVfs}`);
      }
      if (sourceInputs.length === 0 && preBuiltLinkInputs.length === 0) {
        ctx.stderr.write(`${binName}: no compilable / linkable inputs\n`);
        return 1;
      }

      let toolchain: ClangToolchain;
      try {
        if (!runtimePromise) {
          runtimePromise = loadClangToolchain({
            clangVfsPath,
            lldVfsPath,
            sysrootVfsPath,
            sysrootDir,
            vfs: runtimeVfs,
          });
        }
        toolchain = await runtimePromise;
      } catch (e: unknown) {
        runtimePromise = null;
        ctx.stderr.write(`${binName}: clang runtime warm-up failed: ${errorMessage(e)}\n`);
        return 1;
      }

      // Opened per invocation, not cached: the supervisor capability is bound
      // to this process's pid when the facet opens, so one held across calls
      // would hand every later caller the first caller's credential.
      const openTarget = (primaryName: 'clang' | 'wasm-ld', image: ArrayBuffer): ClangFacetTarget => ({
        primaryName,
        facet: deps.facets.open({
          tag: `clang-runner-${primaryName}`,
          concurrency: 1,
          syscalls: { vfs: ctx.vfs.authority, pid: ctx.pid },
          preamble: CLANG_RUNNER_PREAMBLE,
          wasmModules: { 'primary.wasm': image },
        }),
      });

      // Intermediate objects live in a per-invocation scratch directory, as a
      // real driver's do, so a multi-file build leaves no .o beside the
      // sources. `-c` is the exception: its objects ARE the output.
      const cwdGuest = `/${normalizeVfsPath(cwd)}`;
      const scratchVfs = parsed.compileOnly ? null : `tmp/nimbus-clang-${ctx.pid}-${crypto.randomUUID().slice(0, 8)}`;
      if (scratchVfs) {
        try {
          await vfs.mkdir(scratchVfs, { recursive: true });
        } catch (error) {
          ctx.stderr.write(`${binName}: /${scratchVfs}: ${errorMessage(error)}\n`);
          return 1;
        }
      }

      const compile = openTarget('clang', toolchain.clang);
      const link = openTarget('wasm-ld', toolchain.lld);
      try {
        // ── COMPILE PHASE ────────────────────────────────────────────
        // -I flags: each user -I path resolved against cwd, plus cwd itself
        // for quote-form lookup. wasm-clang's -cc1 mode does NOT add the
        // working directory to the quote search list (the driver normally
        // does), so `clang main.c` with `#include "greet.h"` next to it
        // needs it spelled out.
        const userIncludeFlags: string[] = [];
        for (const ip of parsed.includePaths) {
          userIncludeFlags.push('-I', `/${resolveVfsPath(ip, cwd)}`);
        }
        userIncludeFlags.push('-I', cwdGuest);

        // Compile each source to its own .o. With -c the object lands in the
        // working directory as a real driver's does (or at -o for a single
        // input); otherwise it goes to the scratch directory, keyed by the
        // source's full path so src/foo.c and lib/foo.c never collide.
        const objPaths: string[] = [];
        for (const src of sourceInputs) {
          const objName = src.slice(src.lastIndexOf('/') + 1).replace(/\.(c|cc|cpp|cxx|c\+\+|C)$/, '.o');
          const objPath = scratchVfs
            ? `/${scratchVfs}/${src.replace(/^\/+/, '').replace(/\//g, '_').replace(/\.[^.]+$/, '.o')}`
            : sourceInputs.length === 1 && parsed.outputPath !== 'a.out'
              ? `/${resolveVfsPath(parsed.outputPath, cwd)}`
              : `${cwdGuest}/${objName}`;
          // For C++ inputs use -x c++; default -x c.
          const isCpp = /\.(cc|cpp|cxx|c\+\+|C)$/.test(src);
          const compileArgv = [
            'clang', '-cc1', '-emit-obj',
            '-disable-free',
            '-isysroot', sysrootDir,
            '-internal-isystem', `${sysrootDir}/include/c++/v1`,
            '-internal-isystem', `${sysrootDir}/include`,
            '-internal-isystem', `${sysrootDir}/lib/clang/8.0.1/include`,
            '-ferror-limit', '19',
            '-fmessage-length', '80',
            '-fcolor-diagnostics',
            '-O2',
            ...userIncludeFlags,
            '-o', objPath,
            '-x', isCpp ? 'c++' : 'c',
            src,
          ];
          const compileResult = await dispatchClangFacet(compile, { argv: compileArgv });
          if (compileResult.stdout) ctx.stdout.write(compileResult.stdout);
          if (compileResult.stderr) ctx.stderr.write(compileResult.stderr);
          if (compileResult.error) {
            ctx.stderr.write(`${binName}: ${compileResult.error}\n`);
            return 1;
          }
          if (compileResult.exitCode !== 0) return compileResult.exitCode;
          if (!(await producedFile(vfs, objPath))) {
            ctx.stderr.write(`${binName}: compile produced no ${objPath} (internal error)\n`);
            return 1;
          }
          objPaths.push(objPath);
        }

        // -c (compile-only): the objects are already where they belong.
        if (parsed.compileOnly) return 0;

        // ── LINK PHASE ───────────────────────────────────────────────
        const stackSize = 1024 * 1024;
        const userLinkFlags: string[] = [];
        for (const lp of parsed.libraryPaths) {
          userLinkFlags.push('-L', `/${resolveVfsPath(lp, cwd)}`);
        }
        const outputGuest = `/${resolveVfsPath(parsed.outputPath, cwd)}`;
        const linkArgv = [
          'wasm-ld',
          '--no-threads',
          '--export-dynamic',
          '-z', `stack-size=${stackSize}`,
          `-L${sysrootDir}/lib/wasm32-wasi`,
          // Stream-C: modern wasi-libc references __muloti4 / __divti3
          // (128-bit math from utimensat's timespec arithmetic) — these
          // live in compiler-rt's libclang_rt.builtins-wasm32.a at the
          // clang resource dir. binji-2020's libc.a self-bundled them;
          // modern doesn't, so we link compiler-rt explicitly. wasm-ld
          // dead-strips unused builtins, so binji binaries are unaffected.
          `-L${sysrootDir}/lib/clang/8.0.1/lib/wasi`,
          ...userLinkFlags,
          `${sysrootDir}/lib/wasm32-wasi/crt1.o`,
          ...objPaths,
          ...preBuiltLinkInputs,
          '-lc',
          ...parsed.libraries.map((l) => '-l' + l),
          '-lclang_rt.builtins-wasm32',
          '-o', outputGuest,
        ];
        const linkResult = await dispatchClangFacet(link, { argv: linkArgv });
        if (linkResult.stdout) ctx.stdout.write(linkResult.stdout);
        if (linkResult.stderr) ctx.stderr.write(linkResult.stderr);
        if (linkResult.error) {
          ctx.stderr.write(`${binName}: ${linkResult.error}\n`);
          return 1;
        }
        if (linkResult.exitCode !== 0) return linkResult.exitCode;
        if (!(await producedFile(vfs, outputGuest))) {
          ctx.stderr.write(`${binName}: link produced no ${parsed.outputPath} (internal error)\n`);
          return 1;
        }

        // Real linkers chmod their output executable (+x even after a
        // prior chmod -x) — so `./a.out` runs with no manual chmod.
        try {
          await vfs.chmod(outputGuest.replace(/^\/+/, ''), 0o755);
        } catch (error) {
          ctx.stderr.write(`${binName}: ${parsed.outputPath}: ${errorMessage(error)}\n`);
          return 1;
        }
        return 0;
      } finally {
        compile.facet.dispose();
        link.facet.dispose();
        if (scratchVfs) await vfs.remove(scratchVfs, { recursive: true, force: true });
      }
    }
  };
}

/** A non-empty regular file at `guestPath`, as the caller sees it. */
async function producedFile(vfs: ExecutionFs, guestPath: string): Promise<boolean> {
  const path = guestPath.replace(/^\/+/, '');
  if (!(await vfs.isFile(path))) return false;
  return (await vfs.stat(path)).size > 0;
}

// ── argv parser ──────────────────────────────────────────────────────

interface ParsedArgv {
  /** All input source files (.c/.cpp/.cc/.cxx) in user-supplied order. */
  inputPaths: string[];
  /** -I include directories (cwd-relative or absolute) passed by user. */
  includePaths: string[];
  /** -L library search directories (cwd-relative or absolute). */
  libraryPaths: string[];
  /** -l library names (without 'lib' prefix or '.a' suffix). */
  libraries: string[];
  /** Output path from -o. Defaults to 'a.out'. */
  outputPath: string;
  /** If true, user passed -c (compile-only, no link). */
  compileOnly: boolean;
  error?: string;
  exitCode: number;
}

/** Recognized C / C++ source extensions for input classification. */
function isSourceExt(p: string): boolean {
  return /\.(c|cc|cpp|cxx|c\+\+|C)$/.test(p);
}

/**
 * Nimbus RUNS threaded wasm — see runtime/wasi-threads.ts — but this compiler
 * cannot BUILD it. The bundled toolchain is LLVM 8 over a wasi-sdk-19 sysroot
 * that ships one target directory, `lib/wasm32-wasi`, with no threads variant:
 * no atomics-and-bulk-memory libc, no `libpthread.a`, and a fixed link line
 * with no `--shared-memory`.
 *
 * Measured on the shipped sysroot, `-pthread` fell through parseUserArgv's
 * catch-all for unrecognised flags, and what the user saw depended on their
 * includes: `clang -pthread prog.c` on a program that does not include
 * <pthread.h> built and ran with exit 0 and the flag quietly ignored, while a
 * real threaded program died at `'pthread.h' file not found` — a diagnosis
 * that names a missing header rather than a toolchain that has no threads at
 * all, and points nowhere. Refuse at the front door instead, and say where the
 * working path is, because Nimbus does run these programs once they are built
 * correctly.
 */
function threadedBuildRefusal(argv: string[]): string | null {
  const flag = argv.find((a) =>
    a === '-pthread' || a === '-mthread-model' || a === '--pthread'
    || /^(-target|--target)=.*threads$/.test(a));
  const target = argv.findIndex((a) => a === '-target' || a === '--target');
  const targetsThreads = target >= 0 && /threads$/.test(argv[target + 1] || '');
  if (!flag && !targetsThreads) return null;
  return `${flag ?? `${argv[target]} ${argv[target + 1]}`}: this toolchain cannot build threaded wasm.\n`
    + `  The bundled sysroot is wasm32-wasi only — it has no wasm32-wasip1-threads libc.\n`
    + `  Nimbus RUNS pthread programs (mutex, condvar, join, TLS, barrier, semaphore),\n`
    + `  but they must be built with a full wasi-sdk and linked against the futex shim:\n`
    + `    clang --target=wasm32-wasip1-threads --sysroot=$WASI_SYSROOT -pthread \\\n`
    + `      -Wl,--import-memory,--shared-memory,--max-memory=67108864 \\\n`
    + `      -o prog.wasm prog.c nimbus-threads.c\n`
    + `  See docs/wasi-threads.md for nimbus-threads.c and why the shim is required.`;
}

function parseUserArgv(argv: string[]): ParsedArgv {
  const inputPaths: string[] = [];
  const includePaths: string[] = [];
  const libraryPaths: string[] = [];
  const libraries: string[] = [];
  let outputPath = 'a.out';
  let compileOnly = false;
  // Flags that take a separate argv slot for their value.
  const takesArg = new Set(['-o', '-x', '-isystem', '-include', '-isysroot',
                            '-target', '--target', '-std', '-MF', '-MT', '-MQ']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' && i + 1 < argv.length) { outputPath = argv[i + 1]; i++; continue; }
    if (a === '-c') { compileOnly = true; continue; }
    // -I<path> or -I <path>
    if (a === '-I' && i + 1 < argv.length) { includePaths.push(argv[i + 1]); i++; continue; }
    if (a.startsWith('-I')) { includePaths.push(a.substring(2)); continue; }
    // -L<path> or -L <path>
    if (a === '-L' && i + 1 < argv.length) { libraryPaths.push(argv[i + 1]); i++; continue; }
    if (a.startsWith('-L')) { libraryPaths.push(a.substring(2)); continue; }
    // -l<name> or -l <name>
    if (a === '-l' && i + 1 < argv.length) { libraries.push(argv[i + 1]); i++; continue; }
    if (a.startsWith('-l')) { libraries.push(a.substring(2)); continue; }
    // Skip recognised takes-arg flags we don't yet interpret.
    if (takesArg.has(a) && i + 1 < argv.length) { i++; continue; }
    // Any other -flag is opaque to the parser; the user passes them
    // through (we don't currently relay arbitrary flags to clang-cc1,
    // see compileArgv construction).
    if (a.startsWith('-')) continue;
    // Positional. If it looks like a source file, take it; else ignore.
    if (isSourceExt(a)) {
      inputPaths.push(a);
    } else if (a.endsWith('.o') || a.endsWith('.a')) {
      // Pre-built objects/archives — treat as link-only inputs. We
      // surface them as inputs so the link step picks them up; the
      // compile step skips them (it only walks .c/.cc/.cpp).
      inputPaths.push(a);
    }
    // else: drop silently (e.g. typos). clang would warn; we don't yet.
  }
  const threaded = threadedBuildRefusal(argv);
  if (threaded) {
    return {
      inputPaths: [], includePaths, libraryPaths, libraries,
      outputPath: '', compileOnly, exitCode: 1, error: threaded,
    };
  }
  if (inputPaths.length === 0) {
    return {
      inputPaths: [], includePaths, libraryPaths, libraries,
      outputPath: '', compileOnly, exitCode: 2, error: 'no input files',
    };
  }
  return {
    inputPaths, includePaths, libraryPaths, libraries,
    outputPath, compileOnly, exitCode: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── ustar parser (supervisor-side) ───────────────────────────────────

/**
 * Parse a POSIX ustar archive into a path→bytes map. Trims the
 * leading "/" from paths so they are seen as "include/stdio.h"
 * (not "/include/stdio.h"). Directories are NOT recorded — only
 * regular file entries.
 */
function parseUstar(tarBytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let off = 0;
  while (off + 512 <= tarBytes.length) {
    let nameEnd = off;
    while (nameEnd < off + 100 && tarBytes[nameEnd] !== 0) nameEnd++;
    let name = '';
    for (let i = off; i < nameEnd; i++) name += String.fromCharCode(tarBytes[i]);
    if (!name) break;
    const typeflag = tarBytes[off + 156];
    let sizeStr = '';
    for (let i = off + 124; i < off + 124 + 11; i++) {
      const c = tarBytes[i];
      if (c >= 0x30 && c <= 0x37) sizeStr += String.fromCharCode(c);
    }
    const size = parseInt(sizeStr || '0', 8);
    let prefixEnd = off + 345;
    while (prefixEnd < off + 345 + 155 && tarBytes[prefixEnd] !== 0) prefixEnd++;
    let prefix = '';
    for (let i = off + 345; i < prefixEnd; i++) prefix += String.fromCharCode(tarBytes[i]);
    const fullName = prefix ? `${prefix}/${name}` : name;
    off += 512;
    const isRegular = typeflag === 0 || typeflag === 0x30; // '0'
    const isDir = typeflag === 0x35 || fullName.endsWith('/'); // '5'
    if (isRegular && !isDir) {
      const bytes = tarBytes.slice(off, off + size);
      files.set(fullName.replace(/\/$/, ''), bytes);
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

// ── Sysroot unpack (supervisor-side) ─────────────────────────────────

/** Where the unpacked sysroot lives, relative to the install root. */
const SYSROOT_DIR_REL = 'share/clang/sysroot';
/** Written last; names the archive it was unpacked from. */
const SYSROOT_STAMP = '.nimbus-sysroot.json';
/**
 * What a C build needs from the archive. Their absence is the archive being
 * the wrong one, and is reported as such rather than surfacing later as a
 * missing header or an unresolved crt1.o.
 */
const SYSROOT_REQUIRED = [
  'include/stdio.h',
  'lib/clang/8.0.1/include/stddef.h',
  'lib/wasm32-wasi/crt1.o',
  'lib/wasm32-wasi/libc.a',
  'lib/wasm32-wasi/libc.imports',
  'lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a',
];
/** One write wave: the W7 frame owns at most this many paths. */
const SYSROOT_WAVE_PATHS = W7_MAX_PATHS_PER_BATCH - 8;

interface SysrootStamp { tarSize: number; files: number }

function parseSysrootStamp(text: string): SysrootStamp | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const tarSize = Reflect.get(value, 'tarSize');
    const files = Reflect.get(value, 'files');
    if (typeof tarSize !== 'number' || typeof files !== 'number') return null;
    return { tarSize, files };
  } catch {
    return null;
  }
}

/**
 * Unpack `sysroot.tar` into `sysrootDir` unless the tree there was already
 * unpacked from an archive of this size. The tree is world-readable, like
 * the rest of the install root: every session user compiles against it.
 *
 * Waves of directories (shallowest first), then waves of files, each one
 * W7 stream; the stamp goes last, so a tree without one is re-unpacked from
 * scratch on the next invocation rather than trusted.
 */
async function ensureSysrootUnpacked(vfs: ExecutionFs, tarVfsPath: string, sysrootDir: string): Promise<void> {
  const dir = sysrootDir.replace(/^\/+/, '');
  const stampPath = `${dir}/${SYSROOT_STAMP}`;
  const tarSize = (await vfs.stat(tarVfsPath)).size;
  if (await vfs.isFile(stampPath)) {
    const stamp = parseSysrootStamp(await vfs.readFileString(stampPath));
    if (stamp && stamp.tarSize === tarSize) return;
  }
  const entries = parseUstar(await vfs.readFileUncached(tarVfsPath));
  for (const required of SYSROOT_REQUIRED) {
    if (!entries.has(required)) throw new Error(`sysroot.tar is missing ${required}`);
  }
  await vfs.remove(dir, { recursive: true, force: true });

  const mtime = Date.now();
  const dirSet = new Set<string>([dir]);
  const files: BatchInodeEntry[] = [];
  const chunksByPath = new Map<string, BatchChunkEntry[]>();
  for (const [rel, data] of entries) {
    const path = `${dir}/${rel}`;
    const slash = path.lastIndexOf('/');
    for (let cut = slash; cut > dir.length; cut = path.lastIndexOf('/', cut - 1)) dirSet.add(path.slice(0, cut));
    const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
    files.push({ path, parentPath: path.slice(0, slash), isDir: false, size: data.length, mtime, mode: 0o644, chunkCount });
    const chunks: BatchChunkEntry[] = [];
    for (let i = 0; i < chunkCount; i++) {
      chunks.push({ path, chunkId: i, data: data.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) });
    }
    chunksByPath.set(path, chunks);
  }
  const directories: BatchInodeEntry[] = Array.from(dirSet)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .map((path) => ({
      path, parentPath: path.slice(0, path.lastIndexOf('/')), isDir: true, size: 0, mtime, mode: 0o755, chunkCount: 0,
    }));

  const write = async (inodes: BatchInodeEntry[]): Promise<void> => {
    const chunks = inodes.flatMap((inode) => chunksByPath.get(inode.path) ?? []);
    const result = await vfs.authority.writeStream(encodeWriteBatchStream({ inodes, chunks }));
    if (!result.ok) throw new Error(`sysroot unpack failed at ${inodes[0].path}: ${result.error.message}`);
  };
  for (let i = 0; i < directories.length; i += SYSROOT_WAVE_PATHS) await write(directories.slice(i, i + SYSROOT_WAVE_PATHS));
  for (let i = 0; i < files.length; i += SYSROOT_WAVE_PATHS) await write(files.slice(i, i + SYSROOT_WAVE_PATHS));

  const stamp: SysrootStamp = { tarSize, files: files.length };
  await vfs.writeFile(stampPath, JSON.stringify(stamp));
}

// ── Facet dispatch ───────────────────────────────────────────────────

/** The facet contract: argv in, exit status and output text back. */
interface ClangFacetArgs {
  argv: string[];
}

interface ClangFacetTarget {
  primaryName: 'clang' | 'wasm-ld';
  facet: Facet;
}

/** The two images, compiled once per session; facets are opened per call. */
interface ClangToolchain {
  clang: ArrayBuffer;
  lld: ArrayBuffer;
}

interface ClangFacetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

async function loadClangToolchain(
  args: {
    clangVfsPath: string;
    lldVfsPath: string;
    sysrootVfsPath: string;
    sysrootDir: string;
    vfs: ExecutionFs;
  },
): Promise<ClangToolchain> {
  // Hand the file's own backing buffer to the loader when the Uint8Array
  // spans it exactly (the uncached reads below always allocate a fresh
  // whole buffer) — avoids a second 31 MiB copy of clang.wasm in the DO
  // heap during warm-up. Falls back to a slice for sub-views.
  const toAB = (u8: Uint8Array): ArrayBuffer =>
    (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
      ? u8.buffer
      : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)) as ArrayBuffer;

  // Uncached reads: these are one-shot bulk reads of large runtime blobs
  // (clang 31 MiB, wasm-ld 18.5 MiB, sysroot 9.3 MiB). Routing them
  // through the LRU content cache would evict the user's hot working set
  // and pin ~32 MiB of clang chunks resident in the DO heap for the whole
  // session — a primary cause of supervisor-DO memory pressure that tips
  // heavy sessions into an OOM reset mid-compile.
  await ensureSysrootUnpacked(args.vfs, args.sysrootVfsPath, args.sysrootDir);
  const clangBytes = await args.vfs.readFileUncached(args.clangVfsPath);
  const lldBytes = await args.vfs.readFileUncached(args.lldVfsPath);
  return { clang: toAB(clangBytes), lld: toAB(lldBytes) };
}

async function dispatchClangFacet(
  target: ClangFacetTarget,
  args: ClangFacetArgs,
): Promise<ClangFacetResult> {
  const facetFn = async function clangFacetCall(
    inArgs: { primaryName: string; argv: string[] },
    facetEnv: FacetBindings,
  ): Promise<ClangFacetResult> {
    const wasm = Reflect.get(globalThis, '__NIMBUS_WASM') as Record<string, unknown> | undefined;
    const primaryMod = wasm?.['primary.wasm'];
    if (!primaryMod) {
      return {
        exitCode: 127, stdout: '', stderr: '',
        error: 'clang-runner: __NIMBUS_WASM missing primary.wasm',
      };
    }
    const fn = Reflect.get(globalThis, '__clangRun') as
      ((a: unknown) => Promise<ClangFacetResult>) | undefined;
    if (typeof fn !== 'function') {
      return {
        exitCode: 127, stdout: '', stderr: '',
        error: 'clang-runner preamble missing: __clangRun not in scope',
      };
    }
    return await fn({
      primaryName: inArgs.primaryName,
      argv: inArgs.argv,
      primaryMod,
      supervisor: facetEnv?.SUPERVISOR,
    });
  };

  try {
    const result = await target.facet.submit(facetFn, {
      primaryName: target.primaryName,
      argv: args.argv,
    }, {
      timeoutMs: 300_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error,
    };
  } catch (e: unknown) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: `clang-runner dispatch failed: ${errorMessage(e)}`,
    };
  }
}

// ── Facet preamble ───────────────────────────────────────────────────

const CLANG_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: clang-runner preamble ──────────────────────────────────────
//
// The toolchain is a plain wasi_unstable (preview0) guest: clang.wasm
// declares 27 imports and wasm-ld 25, every one of them in that namespace
// and every one of them implemented by the WASI layer above. Its filesystem
// is the session's, reached through the supervisor the facet was opened
// with: sources, the unpacked sysroot and the output path are all absolute
// paths in that tree, and what the toolchain writes is in the session the
// moment the syscall returns.

globalThis.__clangRun = async function __clangRun(args) {
  const stdout = [];
  const stderr = [];

  // The session root at '/', as every other runtime mounts it. This
  // toolchain's wasi-libc predates cwd support and resolves a path only
  // against a preopen it matches, so every path the runner passes — sources,
  // sysroot, outputs — is absolute; a bare relative one would not resolve.
  __wasiInitFS({
    root: '',
    preopens: [{ wasiPath: '/', vfsPath: '' }],
  });
  // AFTER initFS, never before: initFS drops the adopted supervisor so a
  // pooled isolate cannot serve the previous tenant's filesystem.
  __wasiAdoptSupervisor(args.supervisor || null);

  let memory = null;
  const wasi = __wasiMakeImports({
    abi: 'preview0',
    argv: args.argv || [],
    env: { USER: 'user', HOME: '/', PWD: '/' },
    getMemory: () => memory,
    stdoutWrite: (s) => { stdout.push(s); },
    stderrWrite: (s) => { stderr.push(s); },
  });

  let instance;
  try {
    const r = await WebAssembly.instantiate(args.primaryMod, {
      ${WASI_ABI_NAMESPACE.preview0}: wasi.wasiImport,
    });
    instance = (r instanceof WebAssembly.Instance ? r : r.instance);
  } catch (e) {
    return {
      exitCode: 1, stdout: stdout.join(''), stderr: stderr.join(''),
      error: 'primary (' + args.primaryName + ') instantiate failed: ' + (e && e.message),
    };
  }
  memory = instance.exports.memory;

  const run = await __wasiRunStartAsync(instance, { memory });
  if (run.error) {
    stderr.push('[clang-runner] ' + args.primaryName + ' trapped: ' + run.error + '\\n');
  }

  return {
    exitCode: run.exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
};

// ── END: clang-runner preamble ────────────────────────────────────────
`;

export const CLANG_RUNNER_PREAMBLE = `${WASI_INSTANCE_PREAMBLE_SRC}\n${CLANG_RUNNER_PREAMBLE_TAIL}`;
