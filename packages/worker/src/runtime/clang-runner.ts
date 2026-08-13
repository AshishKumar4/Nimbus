/**
 * clang-runner.ts — compile, link, and execute C programs for Nimbus WASI.
 *
 * Architecture (compile-link-run, two facet calls):
 *
 *   compile  : clang.wasm + sysroot subset for C includes + user .c
 *              → produces .o bytes (returned to supervisor).
 *   link     : lld.wasm + sysroot subset for link (crt1.o + libc.a)
 *              + .o from compile → produces .wasm executable.
 *   write    : final .wasm flushed to user VFS at the requested path.
 *
 * The filesystem both halves see is the one WASI layer every other
 * non-node runtime uses (wasi-instance.ts), seeded and sealed.
 *
 * Splitting compile and link into separate LOADER calls keeps each
 * call under the empirical loader payload ceiling. Each ships:
 *
 *   - compile: 31 MiB clang.wasm + ~1.3 MiB sysroot subset (C includes).
 *   - link   : 19 MiB lld.wasm + ~0.75 MiB libs + tiny .o.
 *
 * Sysroot subset extraction happens supervisor-side via a small ustar
 * parser. The full sysroot.tar is parsed once when the clang runtime
 * warms for a session; compile/link calls reuse the filtered subsets.
 *
 * Dispatch stays direct: no sleeps, no caller-side retries, and no
 * catch-and-continue around loader failures.
 */

import type { RuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import type { NimbusLoaderPool } from '../loaders/loader-pool.js';
import { CRED_KERNEL, requireVfsCred, WASM32_WASI_NIMBUS_ABI } from '@nimbus-sh/core/runtime/os-contracts.js';
import { resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { hasLeadingCliFlag } from '@nimbus-sh/core/runtime/cli-flags.js';
import { WASI_ABI_NAMESPACE, WASI_INSTANCE_PREAMBLE_SRC } from '@nimbus-sh/core/runtime/wasi-instance.js';

const CLANG_VERSION_FLAGS = new Set(['--version', '-v']);

/** Build the runner factory. Closes over facetMgr + vfs. */
export function makeClangRunnerFactory(deps: {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) =>
    (ctx: any) => Promise<number> {
  const { facetMgr } = deps;
  const runtimeVfs = deps.vfs.as(CRED_KERNEL);

  return function clangRunnerFactory(manifest, installRoot, binName, binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };

    const clangVfsPath   = findFile('bin/clang');
    const lldVfsPath     = findFile('bin/wasm-ld');
    const sysrootVfsPath = findFile('share/clang/sysroot.tar');
    let runtimePromise: Promise<ClangFacetRuntime> | null = null;

    return async function clangBinHandler(ctx: any): Promise<number> {
      const vfs = deps.vfs.as(requireVfsCred('cred' in ctx ? ctx.cred : undefined, binName));
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
      if (!sysrootVfsPath || !runtimeVfs.exists(sysrootVfsPath)) {
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

      // Validate all user-supplied source inputs exist in the user's
      // session VFS. Collect their bytes to seed the filesystem.
      const userSourceFiles: Record<string, Uint8Array> = {};
      // Pre-built objects/archives the user passed (e.g. extra.o, libfoo.a)
      // — shipped to the LINK step only (not compile).
      const preBuiltLinkInputs: string[] = [];
      const sourceInputs: string[] = [];
      for (const input of parsed.inputPaths) {
        const inputAbs = resolveVfsPath(input, cwd);
        try {
          if (!vfs.exists(inputAbs)) {
            ctx.stderr.write(`${binName}: ${input}: No such file or directory\n`);
            return 1;
          }
          userSourceFiles[input] = vfs.readFile(inputAbs);
        } catch (error) {
          ctx.stderr.write(`${binName}: ${input}: ${errorMessage(error)}\n`);
          return 1;
        }
        if (isSourceExt(input)) {
          sourceInputs.push(input);
        } else {
          // .o / .a — pass through to link as a pre-built input. The
          // path in the seeded filesystem is the user-supplied relative path.
          preBuiltLinkInputs.push(input);
        }
      }
      if (sourceInputs.length === 0 && preBuiltLinkInputs.length === 0) {
        ctx.stderr.write(`${binName}: no compilable / linkable inputs\n`);
        return 1;
      }

      let runtime: ClangFacetRuntime;
      try {
        if (!runtimePromise) {
          runtimePromise = createClangFacetRuntime(facetMgr, {
            clangVfsPath,
            lldVfsPath,
            sysrootVfsPath,
            vfs: runtimeVfs,
          });
        }
        runtime = await runtimePromise;
      } catch (e: any) {
        runtimePromise = null;
        ctx.stderr.write(`${binName}: clang runtime warm-up failed: ${e?.message || e}\n`);
        return 1;
      }

      // Walk the user's cwd to gather headers (.h/.hpp/.hxx/.inc/...)
      // and any sibling headers users typically expect to be visible
      // to #include "..." resolution. Real clang/gcc auto-search the
      // dir of the including source for quote-form includes; we ship
      // those files at their relative-to-cwd paths so the seeded
      // filesystem reproduces the user's working tree.
      //
      // Size-capped (4 MiB, 200 files, depth 8) so accidental
      // huge-projects don't OOM the facet. Real C-tutorial projects
      // are vastly under the cap.
      const userIncludeBundle = collectIncludeBundle(vfs, cwd.replace(/^\/+/, ''));

      // ── COMPILE PHASE ────────────────────────────────────────────
      // Reuse the warm clang pool and ship only the C-include
      // subset plus user source/header files for this invocation.

      // Build -I flag list. We pass each user -I path verbatim AND add
      // an implicit '.' (cwd) for quote-form lookup. wasm-clang's -cc1
      // mode does NOT add cwd to the quote search list by default
      // (the driver normally does that for "foo.h" includes), so we
      // wire it ourselves. This is what makes
      //   clang main.c   (main.c does #include "greet.h", greet.h
      //                    next to main.c)
      // succeed without an explicit -I from the user.
      const userIncludeFlags: string[] = [];
      for (const ip of parsed.includePaths) {
        userIncludeFlags.push('-I', ip);
      }
      userIncludeFlags.push('-I', '.');

      // Compile each source to its own .o. Object file naming: replace
      // the source extension with .o. Collisions across cwd subdirs
      // (e.g. src/foo.c and lib/foo.c both → foo.o) are avoided by
      // keeping the directory component (the seed preserves user layout).
      const objPaths: string[] = [];
      const objBytesMap: Record<string, Uint8Array> = {};
      for (const src of sourceInputs) {
        const objPath = src.replace(/\.(c|cc|cpp|cxx|c\+\+|C)$/, '.o');
        // For C++ inputs use -x c++; default -x c.
        const isCpp = /\.(cc|cpp|cxx|c\+\+|C)$/.test(src);
        const compileArgv = [
          'clang', '-cc1', '-emit-obj',
          '-disable-free',
          '-isysroot', '/',
          '-internal-isystem', '/include/c++/v1',
          '-internal-isystem', '/include',
          '-internal-isystem', '/lib/clang/8.0.1/include',
          '-ferror-limit', '19',
          '-fmessage-length', '80',
          '-fcolor-diagnostics',
          '-O2',
          ...userIncludeFlags,
          '-o', objPath,
          '-x', isCpp ? 'c++' : 'c',
          src,
        ];
        // Per compile we ship: the current source file + the user's
        // header bundle. Multi-TU is handled at link time, not compile,
        // so sibling sources stay out of the seed (smaller payload, no
        // surface for unintended cross-TU textual inclusion via -I.).
        const oneSourceFile: Record<string, Uint8Array> = { [src]: userSourceFiles[src] };
        const compileResult = await dispatchClangFacet(runtime.compile, {
          sysrootFiles: {
            ...runtime.compile.sysrootFiles,
            ...oneSourceFile,
            // User's headers from cwd tree (so quote-form #include
            // resolves; this is the primary clang-include-fix payload).
            ...userIncludeBundle,
          },
          argv: compileArgv,
          outputPaths: [objPath],
        });

        if (compileResult.stdout) ctx.stdout.write(compileResult.stdout);
        if (compileResult.stderr) ctx.stderr.write(compileResult.stderr);
        if (compileResult.error) {
          ctx.stderr.write(`${binName}: ${compileResult.error}\n`);
          return 1;
        }
        if (compileResult.exitCode !== 0) {
          return compileResult.exitCode;
        }
        const objBytes = compileResult.outputFiles[objPath];
        if (!objBytes || objBytes.length === 0) {
          ctx.stderr.write(`${binName}: compile produced no ${objPath} (internal error)\n`);
          return 1;
        }
        objPaths.push(objPath);
        objBytesMap[objPath] = objBytes;
      }

      // -c (compile-only): flush each .o to the user VFS, no link.
      if (parsed.compileOnly) {
        for (const objPath of objPaths) {
          const objVfsPath = resolveVfsPath(objPath, cwd);
          const parent = objVfsPath.replace(/\/[^/]+$/, '');
          if (parent && parent !== objVfsPath && !vfs.exists(parent)) {
            vfs.mkdir(parent, { recursive: true });
          }
          vfs.writeFile(objVfsPath, objBytesMap[objPath]);
        }
        // Honor user's -o for single-input compile-only: rename the one
        // .o to the requested output if -o was passed.
        if (sourceInputs.length === 1 && parsed.outputPath !== 'a.out') {
          const fromVfs = resolveVfsPath(objPaths[0], cwd);
          const toVfs   = resolveVfsPath(parsed.outputPath, cwd);
          if (fromVfs !== toVfs) {
            try {
              vfs.writeFile(toVfs, vfs.readFile(fromVfs));
              vfs.unlink(fromVfs);
            } catch { /* best-effort */ }
          }
        }
        return 0;
      }

      // Add pre-built .o / .a inputs (the user passed them on argv
      // alongside .c sources, e.g. `clang main.c extra.o -o out`).
      const preBuiltBytesMap: Record<string, Uint8Array> = {};
      for (const lp of preBuiltLinkInputs) {
        preBuiltBytesMap[lp] = userSourceFiles[lp];
      }

      // ── LINK PHASE ───────────────────────────────────────────────
      // Reuse the warm wasm-ld pool and ship only the link
      // sysroot subset plus object/archive inputs for this invocation.
      const stackSize = 1024 * 1024;
      // User-supplied -L paths and -l libraries flow through. The user
      // -L paths point at user-VFS dirs; we currently don't ship user
      // libraries (they'd need their own collect step), so -l<name>
      // works only against the sysroot's -L paths today. -L user-side
      // would no-op silently in v1 — out of scope for this wave.
      const userLinkFlags: string[] = [];
      for (const lp of parsed.libraryPaths) {
        userLinkFlags.push('-L', lp);
      }
      const linkArgv = [
        'wasm-ld',
        '--no-threads',
        '--export-dynamic',
        '-z', `stack-size=${stackSize}`,
        '-L/lib/wasm32-wasi',
        // Stream-C: modern wasi-libc references __muloti4 / __divti3
        // (128-bit math from utimensat's timespec arithmetic) — these
        // live in compiler-rt's libclang_rt.builtins-wasm32.a at the
        // clang resource dir. binji-2020's libc.a self-bundled them;
        // modern doesn't, so we link compiler-rt explicitly. wasm-ld
        // dead-strips unused builtins, so binji binaries are unaffected.
        '-L/lib/clang/8.0.1/lib/wasi',
        ...userLinkFlags,
        '/lib/wasm32-wasi/crt1.o',
        ...objPaths,
        ...preBuiltLinkInputs,
        '-lc',
        ...parsed.libraries.map((l) => '-l' + l),
        '-lclang_rt.builtins-wasm32',
        '-o', parsed.outputPath,
      ];
      const linkResult = await dispatchClangFacet(runtime.link, {
        sysrootFiles: { ...runtime.link.sysrootFiles, ...objBytesMap, ...preBuiltBytesMap },
        argv: linkArgv,
        outputPaths: [parsed.outputPath],
      });

      if (linkResult.stdout) ctx.stdout.write(linkResult.stdout);
      if (linkResult.stderr) ctx.stderr.write(linkResult.stderr);
      if (linkResult.error) {
        ctx.stderr.write(`${binName}: ${linkResult.error}\n`);
        return 1;
      }
      if (linkResult.exitCode !== 0) {
        return linkResult.exitCode;
      }
      const wasmBytes = linkResult.outputFiles[parsed.outputPath];
      if (!wasmBytes || wasmBytes.length === 0) {
        ctx.stderr.write(`${binName}: link produced no ${parsed.outputPath} (internal error)\n`);
        return 1;
      }

      // ── FLUSH OUTPUT ─────────────────────────────────────────────
      const outVfsPath = resolveVfsPath(parsed.outputPath, cwd);
      try {
        const parent = outVfsPath.replace(/\/[^/]+$/, '');
        if (parent && parent !== outVfsPath && !vfs.exists(parent)) {
          vfs.mkdir(parent, { recursive: true });
        }
        vfs.writeFile(outVfsPath, wasmBytes);
        vfs.chmod(outVfsPath, 0o755);
      } catch (error) {
        ctx.stderr.write(`${binName}: ${parsed.outputPath}: ${errorMessage(error)}\n`);
        return 1;
      }
      // Real linkers chmod their output executable (+x even after a
      // prior chmod -x) — so `./a.out` runs with no manual chmod.

      return 0;
    };
  };
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

/**
 * Recognise headers / inline-include files. The compile facet ships
 * these alongside the .c sources so `#include "foo.h"` (quote-form)
 * resolves against the directory of the including source file — which
 * is how clang / gcc behave on real Unix.
 */
function isHeaderExt(name: string): boolean {
  return /\.(h|hh|hpp|hxx|H|inc|ipp|tcc)$/.test(name);
}

/**
 * Walk a VFS directory recursively to collect headers + (optionally)
 * source files, with bounded depth and total size cap, returning a
 * map of root-relative-path → bytes.
 *
 * Layout convention: paths returned are RELATIVE TO `rootVfsPath`, so
 * a header at `home/user/sub/foo.h` (when rootVfsPath is `home/user`)
 * comes out as `sub/foo.h`. This matches the layout the user passes
 * on argv (e.g. `clang sub/lib.c -o out`, with `lib.c` including
 * `"helpers.h"` next to itself).
 *
 * `extra` extensions can be added (used to include `.c/.cpp/.o/.a` when
 * looking under -L / sibling source dirs). Empty by default.
 *
 * Anti-DoS:
 *   - MAX_FILES = 200 (covers realistic user projects without ballooning
 *     the facet payload).
 *   - MAX_BYTES = 4 MiB.
 *   - MAX_DEPTH = 8 (deep enough for typical "src/", "include/", "lib/" trees).
 *   - skipDirs prunes obvious non-source directories.
 */
function collectIncludeBundle(
  vfs: Pick<CredentialedVfs, 'exists' | 'isDirectory' | 'readFile' | 'readdir'>,
  rootVfsPath: string,
  opts: { extraExts?: RegExp; maxFiles?: number; maxBytes?: number; maxDepth?: number } = {},
): Record<string, Uint8Array> {
  const extraExts = opts.extraExts ?? null;
  const MAX_FILES = opts.maxFiles ?? 200;
  const MAX_BYTES = opts.maxBytes ?? 4 * 1024 * 1024;
  const MAX_DEPTH = opts.maxDepth ?? 8;
  const out: Record<string, Uint8Array> = {};
  if (!vfs.exists(rootVfsPath) || !vfs.isDirectory(rootVfsPath)) return out;
  // Directories pruned regardless of depth — these never contain user
  // headers and would balloon the payload if traversed.
  const skipDirs = new Set([
    '.nimbus', 'node_modules', '.cache', '.npm', '.git',
    'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage',
  ]);
  const root = rootVfsPath.replace(/^\/+/, '').replace(/\/+$/, '');
  let totalBytes = 0;
  let fileCount = 0;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;
    let entries: { name: string; type: string }[];
    try { entries = vfs.readdir(dir); } catch { continue; }
    for (const e of entries) {
      const childAbs = dir + '/' + e.name;
      const rel = childAbs.startsWith(root + '/') ? childAbs.substring(root.length + 1) : childAbs;
      if (e.type === 'directory') {
        if (skipDirs.has(e.name)) continue;
        stack.push({ dir: childAbs, depth: depth + 1 });
        continue;
      }
      const isHeader = isHeaderExt(e.name);
      const isExtra = extraExts && extraExts.test(e.name);
      if (!isHeader && !isExtra) continue;
      let bytes: Uint8Array;
      try { bytes = vfs.readFile(childAbs); } catch { continue; }
      totalBytes += bytes.length;
      fileCount++;
      if (totalBytes > MAX_BYTES || fileCount > MAX_FILES) {
        // Cap reached — stop walking but return what we have.
        return out;
      }
      out[rel] = bytes;
    }
  }
  return out;
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

/**
 * Filter the sysroot to just what the compile step needs:
 *   - include/ (minus include/c++/) — C system headers
 *   - lib/clang/8.0.1/include/ — clang intrinsic headers
 *
 * Excludes the C++ standard library headers (libc++/v1) which alone
 * are ~4 MiB and aren't needed for plain C compilation.
 */
function filterSysrootForCompile(all: Map<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [path, bytes] of all.entries()) {
    if (path.startsWith('include/c++/')) continue;
    if (path.startsWith('include/')) { out[path] = bytes; continue; }
    if (path.startsWith('lib/clang/')) { out[path] = bytes; continue; }
  }
  return out;
}

/**
 * Filter the sysroot to just what the link step needs for a C program:
 *   - lib/wasm32-wasi/crt1.o — the entry-point start file
 *   - lib/wasm32-wasi/libc.a — libc archive (printf etc.)
 *   - lib/wasm32-wasi/libc.imports — WASI symbol allow-list. Without
 *     this, wasm-ld treats `__wasi_fd_close` etc. as undefined
 *     symbols (the symbols are SUPPOSED to be unresolved imports,
 *     not errors); the .imports file tells lld "these names are
 *     external WASI imports, not link errors."
 *   - lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a — compiler-rt
 *     builtins (e.g. __muloti4 for 128-bit math). Modern wasi-libc's
 *     utimensat.o references __muloti4; binji-2020 self-bundled it
 *     into libc.a, the modern build expects compiler-rt to provide.
 *     wasm-ld dead-strips, so trivial mains pay zero cost.
 *
 * Excludes libc++/libc++abi (C++-only) and the WASI emulated-mman /
 * pthread / canvas variants we don't drive in v1.1.
 */
function filterSysrootForLink(all: Map<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [path, bytes] of all.entries()) {
    if (path === 'lib/wasm32-wasi/crt1.o') { out[path] = bytes; continue; }
    if (path === 'lib/wasm32-wasi/libc.a') { out[path] = bytes; continue; }
    if (path === 'lib/wasm32-wasi/libc.imports') { out[path] = bytes; continue; }
    if (path === 'lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a') { out[path] = bytes; continue; }
  }
  return out;
}

// ── Facet dispatch ───────────────────────────────────────────────────

interface ClangFacetArgs {
  /** Path → bytes seeded into the WASI filesystem before _start. */
  sysrootFiles: Record<string, Uint8Array>;
  argv: string[];
  /** Paths read back out of the filesystem into outputFiles. */
  outputPaths: string[];
}

interface ClangFacetTarget {
  primaryName: 'clang' | 'wasm-ld';
  pool: NimbusLoaderPool;
  sysrootFiles: Record<string, Uint8Array>;
}

interface ClangFacetRuntime {
  compile: ClangFacetTarget;
  link: ClangFacetTarget;
}

interface ClangFacetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputFiles: Record<string, Uint8Array>;
  error?: string;
}

async function createClangFacetRuntime(
  facetMgr: FacetManager,
  args: {
    clangVfsPath: string | null;
    lldVfsPath: string | null;
    sysrootVfsPath: string | null;
    vfs: CredentialedVfs;
  },
): Promise<ClangFacetRuntime> {
  if (!args.clangVfsPath || !args.lldVfsPath || !args.sysrootVfsPath) {
    throw new Error('installed clang manifest is missing required files');
  }

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
  const clangBytes = args.vfs.readFileUncached(args.clangVfsPath);
  const lldBytes = args.vfs.readFileUncached(args.lldVfsPath);
  const sysroot = parseUstar(args.vfs.readFileUncached(args.sysrootVfsPath));

  const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
  const env = (facetMgr as any).env;
  const ctx = (facetMgr as any).ctx;

  const makeTarget = (
    primaryName: 'clang' | 'wasm-ld',
    primaryBytes: Uint8Array,
    sysrootFiles: Record<string, Uint8Array>,
  ): ClangFacetTarget => ({
    primaryName,
    sysrootFiles,
    pool: new NimbusLoaderPool(env, ctx, {
      tag: `clang-runner-${primaryName}`,
      concurrency: 1,
      omitSupervisor: true,
      cacheScope: 'global',
      preamble: CLANG_RUNNER_PREAMBLE,
      wasmModules: { 'primary.wasm': toAB(primaryBytes) },
    }),
  });

  return {
    compile: makeTarget('clang', clangBytes, filterSysrootForCompile(sysroot)),
    link: makeTarget('wasm-ld', lldBytes, filterSysrootForLink(sysroot)),
  };
}

async function dispatchClangFacet(
  target: ClangFacetTarget,
  args: ClangFacetArgs,
): Promise<ClangFacetResult> {
  // Encode sysroot files as base64 for facet transport. We do this on
  // the supervisor to keep the facet preamble small and CPU-light.
  const filesB64: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(args.sysrootFiles)) {
    filesB64[path] = uint8ToBase64(bytes);
  }

  const facetFn = async function clangFacetCall(
    inArgs: {
      primaryName: string;
      argv: string[];
      filesB64: Record<string, string>;
      outputPaths: string[];
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    outputFiles: Record<string, string>;
    error?: string;
  }> {
    const primaryMod = ((globalThis as any).__NIMBUS_WASM || {})['primary.wasm'];
    if (!primaryMod) {
      return {
        exitCode: 127, stdout: '', stderr: '',
        outputFiles: {},
        error: 'clang-runner: __NIMBUS_WASM missing primary.wasm',
      };
    }
    const fn = (globalThis as any).__clangRun;
    if (typeof fn !== 'function') {
      return {
        exitCode: 127, stdout: '', stderr: '',
        outputFiles: {},
        error: 'clang-runner preamble missing: __clangRun not in scope',
      };
    }
    return await fn({
      primaryName: inArgs.primaryName,
      argv: inArgs.argv,
      filesB64: inArgs.filesB64,
      outputPaths: inArgs.outputPaths,
      primaryMod,
    });
  };

  try {
    const result: any = await target.pool.submit(facetFn, {
      primaryName: target.primaryName,
      argv: args.argv,
      filesB64,
      outputPaths: args.outputPaths,
    }, {
      timeoutMs: 300_000,
    });
    // Decode outputFiles from base64 → Uint8Array.
    const outputFiles: Record<string, Uint8Array> = {};
    if (result.outputFiles) {
      for (const [path, b64] of Object.entries(result.outputFiles as Record<string, string>)) {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        outputFiles[path] = u8;
      }
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      outputFiles,
      error: result.error,
    };
  } catch (e: any) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: '',
      outputFiles: {},
      error: `clang-runner dispatch failed: ${e?.message || e}`,
    };
  }
}

function uint8ToBase64(u8: Uint8Array): string {
  // Chunked to avoid String.fromCharCode call-stack limits on big arrays.
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, Math.min(i + CHUNK, u8.length))),
    );
  }
  return btoa(s);
}

// ── Facet preamble ───────────────────────────────────────────────────

const CLANG_RUNNER_PREAMBLE_TAIL = `
// ── BEGIN: clang-runner preamble ──────────────────────────────────────
//
// The toolchain is a plain wasi_unstable (preview0) guest: clang.wasm
// declares 27 imports and wasm-ld 25, every one of them in that namespace
// and every one of them implemented by the WASI layer above. Its filesystem
// is that layer's, seeded with the sysroot subset and the translation unit
// and sealed — no supervisor is bound, so a compile cannot reach or disturb
// the session VFS, and the named outputs are read back out at the end.

globalThis.__clangRun = async function __clangRun(args) {
  const stdout = [];
  const stderr = [];

  // Everything the seed carries is readable; directories are traversable.
  // The layer denies by default for a mapped inode with no mode, and the
  // producer here is a tar, which has no cred to project.
  const modes = {};
  const dirs = new Set();
  for (const path of Object.keys(args.filesB64 || {})) {
    const canon = path.replace(/^\\/+/, '');
    modes[canon] = 6;
    const parts = canon.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      dirs.add(dir);
      modes[dir] = 7;
    }
  }
  modes[''] = 7;

  __wasiInitFS({
    root: '',
    // One preopen with the EMPTY name. That is what makes a bare relative
    // input resolve: this toolchain's wasi-libc predates cwd support, so a
    // relative path is matched only against a zero-length preopen name, and
    // an absolute one ('-isysroot /' puts the sysroot at /include) against
    // the same entry with the leading slash stripped. Naming it '/' serves
    // the absolute paths and silently loses every relative one — the input
    // file then fails to open with no path_open ever reaching this layer.
    preopens: [{ wasiPath: '', vfsPath: '' }],
    files: args.filesB64 || {},
    dirs: Array.from(dirs).filter(Boolean),
    modes,
  });

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
      exitCode: 1, stdout: stdout.join(''), stderr: stderr.join(''), outputFiles: {},
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
    outputFiles: __wasiReadFilesB64(args.outputPaths || []),
  };
};

// ── END: clang-runner preamble ────────────────────────────────────────
`;

export const CLANG_RUNNER_PREAMBLE = `${WASI_INSTANCE_PREAMBLE_SRC}\n${CLANG_RUNNER_PREAMBLE_TAIL}`;
