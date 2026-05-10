/**
 * clang-runner.ts — Wave-3 v1.1: full hello-world.
 *
 * v1.1 architecture (compile-link-run, TWO facet calls):
 *
 *   compile  : clang.wasm + memfs.wasm + sysroot subset for C includes
 *              + user .c → produces .o bytes (returned to supervisor).
 *   link     : lld.wasm + memfs.wasm + sysroot subset for link
 *              (crt1.o + libc.a) + .o from compile → produces .wasm
 *              executable.
 *   write    : final .wasm flushed to user VFS at the requested path.
 *
 * Splitting compile and link into separate LOADER calls keeps each
 * call under the empirical ~32 MiB per-call ceiling (verdict.md §3
 * path B). Each ships:
 *
 *   - compile: 31 MiB clang.wasm + 0.35 MiB memfs + ~1.3 MiB sysroot
 *              subset (C includes) = ~32.6 MiB.
 *   - link   : 19 MiB lld.wasm + 0.35 MiB memfs + ~0.75 MiB libs +
 *              tiny .o = ~20 MiB.
 *
 * Sysroot subset extraction happens supervisor-side via a small ustar
 * parser. The full 9.3 MiB sysroot.tar is parsed once per compile;
 * only the files matching the role's prefix-allowlist are forwarded.
 *
 * Anti-reqs from plan §8.1: no setTimeout / no retry / no
 * defensive-catch in dispatch.
 */

import type { RuntimeManifest } from './runtime-catalog.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';

/** Build the runner factory. Closes over facetMgr + vfs. */
export function makeClangRunnerFactory(deps: {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
}): (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) =>
    (ctx: any) => Promise<number> {
  const { facetMgr, vfs } = deps;

  return function clangRunnerFactory(manifest, installRoot, binName, binKind) {
    const findFile = (rel: string): string | null => {
      const entry = manifest.files.find((f) => f.path === rel);
      return entry ? `${installRoot}/${entry.path}` : null;
    };

    const clangVfsPath   = findFile('bin/clang');
    const lldVfsPath     = findFile('bin/wasm-ld');
    const memfsVfsPath   = findFile('share/clang/memfs.wasm');
    const sysrootVfsPath = findFile('share/clang/sysroot.tar');

    return async function clangBinHandler(ctx: any): Promise<number> {
      const argv: string[] = ctx.args || [];
      const cwd: string = ctx.cwd || '/home/user';

      // Fast paths — no wasm boot.
      if (argv.includes('--version') || argv.includes('-v')) {
        ctx.stdout.write(`Nimbus wasm-clang (binji-2020, LLVM 8.0.1)\n`);
        ctx.stdout.write(`Target: wasm32-wasi (via wasm-ld linker)\n`);
        return 0;
      }
      if (argv.includes('--help') || argv.includes('-h')) {
        ctx.stdout.write(`usage: ${binName} [options] <source.c> -o <output>\n`);
        ctx.stdout.write(`Wasm-compiled clang/wasm-ld bundle for Nimbus.\n`);
        ctx.stdout.write(`Supported: C compilation + linking to wasm.\n`);
        return 0;
      }

      const isLinker = binKind === 'linker' || binName === 'wasm-ld';

      // Resolve bundle paths.
      if (!memfsVfsPath || !vfs.exists(memfsVfsPath)) {
        ctx.stderr.write(`${binName}: memfs.wasm missing from install (re-run 'nimbus install clang')\n`);
        return 127;
      }
      if (!sysrootVfsPath || !vfs.exists(sysrootVfsPath)) {
        ctx.stderr.write(`${binName}: sysroot.tar missing from install\n`);
        return 127;
      }
      if (!clangVfsPath || !lldVfsPath) {
        ctx.stderr.write(`${binName}: clang/wasm-ld missing from install\n`);
        return 127;
      }

      const memfsBytes = vfs.readFile(memfsVfsPath);
      const sysrootBytes = vfs.readFile(sysrootVfsPath);

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

      // Parse sysroot.tar ONCE on supervisor side.
      const sysroot = parseUstar(sysrootBytes);

      // Read input .c bytes.
      const inputCAbs = resolveVfsPath(parsed.inputPath, cwd);
      if (!vfs.exists(inputCAbs)) {
        ctx.stderr.write(`${binName}: ${parsed.inputPath}: No such file or directory\n`);
        return 1;
      }
      const inputCBytes = vfs.readFile(inputCAbs);

      // ── COMPILE PHASE ────────────────────────────────────────────
      // Ship: clang.wasm + memfs.wasm + C-include subset of sysroot.
      const compileSysroot = filterSysrootForCompile(sysroot);
      const clangBytes = vfs.readFile(clangVfsPath);
      const objPath = parsed.outputPath + '.o';

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
        '-o', objPath,
        '-x', 'c',
        parsed.inputPath,
      ];

      const compileResult = await dispatchClangFacet(facetMgr, {
        primaryName: 'clang',
        primaryBytes: clangBytes,
        memfsBytes,
        sysrootFiles: { ...compileSysroot, [parsed.inputPath]: inputCBytes },
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

      // ── LINK PHASE ───────────────────────────────────────────────
      // Ship: lld.wasm + memfs.wasm + lib subset of sysroot + .o.
      const linkSysroot = filterSysrootForLink(sysroot);
      const lldBytes = vfs.readFile(lldVfsPath);
      const stackSize = 1024 * 1024;
      const linkArgv = [
        'wasm-ld',
        '--no-threads',
        '--export-dynamic',
        '-z', `stack-size=${stackSize}`,
        '-L/lib/wasm32-wasi',
        '/lib/wasm32-wasi/crt1.o',
        objPath,
        '-lc',
        '-o', parsed.outputPath,
      ];
      // The .o file lives at objPath inside memfs for the link call.
      const linkResult = await dispatchClangFacet(facetMgr, {
        primaryName: 'wasm-ld',
        primaryBytes: lldBytes,
        memfsBytes,
        sysrootFiles: { ...linkSysroot, [objPath]: objBytes },
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
      const parent = outVfsPath.replace(/\/[^/]+$/, '');
      if (parent && parent !== outVfsPath && !vfs.exists(parent)) {
        vfs.mkdir(parent, { recursive: true });
      }
      vfs.writeFile(outVfsPath, wasmBytes);

      return 0;
    };
  };
}

// ── argv parser ──────────────────────────────────────────────────────

interface ParsedArgv {
  inputPath: string;
  outputPath: string;
  error?: string;
  exitCode: number;
}

function parseUserArgv(argv: string[]): ParsedArgv {
  let inputC = '';
  let outputPath = 'a.out';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' && i + 1 < argv.length) { outputPath = argv[i + 1]; i++; continue; }
    if (a.startsWith('-')) continue;
    if (!inputC) inputC = a;
  }
  if (!inputC) {
    return { inputPath: '', outputPath: '', exitCode: 2, error: 'no input files' };
  }
  return { inputPath: inputC, outputPath, exitCode: 0 };
}

function resolveVfsPath(rel: string, cwd: string): string {
  const cwdN = cwd.replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel.startsWith('/')) return rel.replace(/^\/+/, '');
  if (rel === '.') return cwdN;
  return `${cwdN}/${rel}`;
}

// ── ustar parser (supervisor-side) ───────────────────────────────────

/**
 * Parse a POSIX ustar archive into a path→bytes map. Trims the
 * leading "/" from paths so memfs sees them as "include/stdio.h"
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
  }
  return out;
}

// ── Facet dispatch ───────────────────────────────────────────────────

interface ClangFacetArgs {
  primaryName: string;        // "clang" / "wasm-ld"
  primaryBytes: Uint8Array;
  memfsBytes: Uint8Array;
  /** Path → bytes for files to populate in memfs before _start. */
  sysrootFiles: Record<string, Uint8Array>;
  argv: string[];
  /** Paths whose memfs contents should be harvested into outputFiles. */
  outputPaths: string[];
}

interface ClangFacetResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputFiles: Record<string, Uint8Array>;
  error?: string;
}

async function dispatchClangFacet(
  facetMgr: FacetManager,
  args: ClangFacetArgs,
): Promise<ClangFacetResult> {
  const toAB = (u8: Uint8Array): ArrayBuffer =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

  // Encode sysroot files as base64 for context ferrying. We do this on
  // the supervisor to keep the facet preamble small and CPU-light.
  const filesB64: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(args.sysrootFiles)) {
    filesB64[path] = uint8ToBase64(bytes);
  }

  const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
  const env = (facetMgr as any).env;
  const ctx = (facetMgr as any).ctx;
  const pool = new NimbusLoaderPool(env, ctx, {
    tag: `clang-runner-${args.primaryName}`,
    concurrency: 1,
    omitSupervisor: true,
    preamble: CLANG_RUNNER_PREAMBLE,
  });

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
    const wasmTable = (globalThis as any).__NIMBUS_WASM || {};
    const memfsMod  = wasmTable['memfs.wasm'];
    const primaryMod = wasmTable['primary.wasm'];
    if (!memfsMod || !primaryMod) {
      return {
        exitCode: 127, stdout: '', stderr: '',
        outputFiles: {},
        error: 'clang-runner: __NIMBUS_WASM missing memfs.wasm or primary.wasm',
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
      memfsMod,
      primaryMod,
    });
  };

  try {
    const result: any = await pool.submit(facetFn, {
      primaryName: args.primaryName,
      argv: args.argv,
      filesB64,
      outputPaths: args.outputPaths,
    }, {
      wasmModules: {
        'memfs.wasm': toAB(args.memfsBytes),
        'primary.wasm': toAB(args.primaryBytes),
      },
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

export const CLANG_RUNNER_PREAMBLE = `
// ── BEGIN: clang-runner preamble (binji/wasm-clang port, v1.1) ─────

const __ESUCCESS = 0;
const __EBADF    = 8;
const __EINVAL   = 28;
const __ENOSYS   = 52;

class __ProcExit {
  constructor(code) { this.code = code | 0; this.message = 'process exited ' + code; this.name = 'ProcExit'; }
}

function __readStr(u8, o, len) {
  if (typeof len !== 'number' || len < 0) len = -1;
  let str = '';
  let end = u8.length;
  if (len !== -1) end = o + len;
  for (let i = o; i < end && u8[i] !== 0; i++) str += String.fromCharCode(u8[i]);
  return str;
}

function __writeStr(u8, off, s) {
  for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i) & 0xff;
  u8[off + s.length] = 0;
  return s.length + 1;
}

class __HostMem {
  constructor(memory) { this.memory = memory; }
  get buffer() { return this.memory.buffer; }
  check() { /* no-op */ }
  read32(off) { return new DataView(this.memory.buffer).getUint32(off, true); }
  write32(off, v) { new DataView(this.memory.buffer).setUint32(off, v >>> 0, true); }
  write64(off, v) {
    const dv = new DataView(this.memory.buffer);
    if (typeof v === 'bigint') {
      dv.setBigUint64(off, v, true);
    } else {
      dv.setUint32(off, (v >>> 0), true);
      dv.setUint32(off + 4, Math.floor(v / 0x100000000) >>> 0, true);
    }
  }
  readStr(off, len) { return __readStr(new Uint8Array(this.memory.buffer), off, len); }
  writeStr(off, s) { return __writeStr(new Uint8Array(this.memory.buffer), off, s); }
  write(off, bytes) {
    const u8 = new Uint8Array(this.memory.buffer);
    if (typeof bytes === 'string') {
      for (let i = 0; i < bytes.length; i++) u8[off + i] = bytes.charCodeAt(i) & 0xff;
    } else {
      u8.set(bytes, off);
    }
  }
}

/**
 * Add a single file to memfs at the given path. Recursively creates
 * parent directories — binji's memfs only auto-creates direct parents
 * when AddFileNode is called, so we walk path segments first.
 */
function __memfsAddFile(memfsExports, memfsMem, path, bytes) {
  // Strip a leading slash if present; memfs stores rootless paths.
  const p = path.replace(/^\\/+/, '');
  // Create parent dirs.
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!dir) continue;
    const pBuf = memfsExports.GetPathBuf();
    const m = new Uint8Array(memfsMem.buffer);
    for (let j = 0; j < dir.length; j++) m[pBuf + j] = dir.charCodeAt(j) & 0xff;
    // Try to add — memfs ignores duplicate adds.
    try { memfsExports.AddDirectoryNode(dir.length); } catch { /* may already exist */ }
  }
  // Now the file itself.
  const pBuf = memfsExports.GetPathBuf();
  const m1 = new Uint8Array(memfsMem.buffer);
  for (let i = 0; i < p.length; i++) m1[pBuf + i] = p.charCodeAt(i) & 0xff;
  const inode = memfsExports.AddFileNode(p.length, bytes.length);
  const addr = memfsExports.GetFileNodeAddress(inode);
  if (bytes.length > 0) {
    new Uint8Array(memfsMem.buffer).set(bytes, addr);
  }
}

/**
 * Decode base64 → Uint8Array (chunked-safe).
 */
function __b64decode(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * Encode Uint8Array → base64 (chunked-safe).
 */
function __b64encode(u8) {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    let chunk = '';
    const end = Math.min(i + CHUNK, u8.length);
    for (let j = i; j < end; j++) chunk += String.fromCharCode(u8[j]);
    s += chunk;
  }
  return btoa(s);
}

globalThis.__clangRun = async function __clangRun(args) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const hostWrite = (s) => { stdoutChunks.push(s); };
  const hostWriteErr = (s) => { stderrChunks.push(s); };

  // 1. Instantiate memfs.wasm with the binji-shaped env imports.
  let memfsInst;
  let memfsMem;
  const memfsHandle = { mem: null, hostMem: null, stdinStr: '', stdinPos: 0 };
  const memfsImports = {
    env: {
      abort: () => { throw new Error('memfs: abort'); },
      host_write: (fd, iovs, iovs_len, nwritten_out) => {
        const hm = memfsHandle.hostMem;
        if (!hm) return __EBADF;
        let size = 0;
        let str = '';
        for (let i = 0; i < iovs_len; i++) {
          const buf = hm.read32(iovs); iovs += 4;
          const len = hm.read32(iovs); iovs += 4;
          str += hm.readStr(buf, len);
          size += len;
        }
        hm.write32(nwritten_out, size);
        if (fd === 2) hostWriteErr(str); else hostWrite(str);
        return __ESUCCESS;
      },
      host_read: (fd, iovs, iovs_len, nread) => {
        const hm = memfsHandle.hostMem;
        if (!hm) return __EBADF;
        let size = 0;
        for (let i = 0; i < iovs_len; i++) {
          const buf = hm.read32(iovs); iovs += 4;
          const len = hm.read32(iovs); iovs += 4;
          const remain = memfsHandle.stdinStr.length - memfsHandle.stdinPos;
          const toWrite = Math.min(len, remain);
          if (toWrite === 0) break;
          hm.write(buf, memfsHandle.stdinStr.substr(memfsHandle.stdinPos, toWrite));
          size += toWrite;
          memfsHandle.stdinPos += toWrite;
          if (toWrite !== len) break;
        }
        hm.write32(nread, size);
        return __ESUCCESS;
      },
      memfs_log: (buf, len) => {
        const m = new Uint8Array(memfsHandle.mem.buffer);
        const s = __readStr(m, buf, len);
        hostWriteErr('[memfs] ' + s + '\\n');
      },
      copy_in: (memfs_dst, src, size) => {
        const dst = new Uint8Array(memfsHandle.mem.buffer, memfs_dst, size);
        const srcU8 = new Uint8Array(memfsHandle.hostMem.buffer, src, size);
        dst.set(srcU8);
      },
      copy_out: (host_dst, memfs_src, size) => {
        const dst = new Uint8Array(memfsHandle.hostMem.buffer, host_dst, size);
        const srcU8 = new Uint8Array(memfsHandle.mem.buffer, memfs_src, size);
        dst.set(srcU8);
      },
    },
  };
  try {
    const r = await WebAssembly.instantiate(args.memfsMod, memfsImports);
    memfsInst = (r instanceof WebAssembly.Instance ? r : r.instance);
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: '', outputFiles: {}, error: 'memfs instantiate failed: ' + (e && e.message) };
  }
  memfsMem = memfsInst.exports.memory;
  memfsHandle.mem = memfsMem;
  memfsInst.exports.init();

  // 2. Populate memfs from filesB64 (sysroot subset + user inputs).
  for (const [path, b64] of Object.entries(args.filesB64 || {})) {
    const bytes = __b64decode(b64);
    try {
      __memfsAddFile(memfsInst.exports, memfsMem, path, bytes);
    } catch (e) {
      hostWriteErr('[clang-runner] failed to add ' + path + ' to memfs: ' + (e && e.message) + '\\n');
    }
  }

  // 3. Build wasi_unstable imports for the primary.
  const argv = args.argv || [];
  const environ = ['USER=user', 'HOME=/', 'PWD=/'];
  const primaryHandle = { mem: null };
  const primaryWasi = {
    proc_exit: (code) => { throw new __ProcExit(code); },
    args_get: (argv_ptrs, argv_buf) => {
      const hm = primaryHandle.mem;
      for (const a of argv) {
        hm.write32(argv_ptrs, argv_buf);
        argv_ptrs += 4;
        argv_buf += hm.writeStr(argv_buf, a);
      }
      hm.write32(argv_ptrs, 0);
      return __ESUCCESS;
    },
    args_sizes_get: (argc_out, argv_buf_size_out) => {
      const hm = primaryHandle.mem;
      let size = 0;
      for (const a of argv) size += a.length + 1;
      hm.write64(argc_out, argv.length);
      hm.write64(argv_buf_size_out, size);
      return __ESUCCESS;
    },
    environ_get: (environ_ptrs, environ_buf) => {
      const hm = primaryHandle.mem;
      for (const e of environ) {
        hm.write32(environ_ptrs, environ_buf);
        environ_ptrs += 4;
        environ_buf += hm.writeStr(environ_buf, e);
      }
      hm.write32(environ_ptrs, 0);
      return __ESUCCESS;
    },
    environ_sizes_get: (count_out, size_out) => {
      const hm = primaryHandle.mem;
      let size = 0;
      for (const e of environ) size += e.length + 1;
      hm.write64(count_out, environ.length);
      hm.write64(size_out, size);
      return __ESUCCESS;
    },
    random_get: (buf, len) => {
      const hm = primaryHandle.mem;
      const data = new Uint8Array(hm.memory.buffer, buf, len);
      crypto.getRandomValues(data);
      return __ESUCCESS;
    },
    clock_time_get: (clock_id, precision, time_out) => {
      const hm = primaryHandle.mem;
      const ns = BigInt(Date.now()) * 1000000n;
      hm.write64(time_out, ns);
      return __ESUCCESS;
    },
    poll_oneoff: () => __ENOSYS,
  };
  // Compose: memfs.exports satisfies fd_*/path_* fns; host overrides
  // proc_exit/args_*/environ_*/random_get/clock_time_get/poll_oneoff.
  const wasi_unstable = Object.assign({}, memfsInst.exports);
  Object.assign(wasi_unstable, primaryWasi);

  // env namespace for the primary — stub canvas_*, etc.
  const primaryEnv = new Proxy({}, {
    get(_t, prop) {
      return function envStub() {
        // Only log first occurrence per name to avoid log floods on
        // wasm-ld which may probe many env imports.
        return 0;
      };
    },
  });

  // 4. Instantiate primary.
  let primaryInst;
  try {
    const r = await WebAssembly.instantiate(args.primaryMod, {
      wasi_unstable,
      env: primaryEnv,
    });
    primaryInst = (r instanceof WebAssembly.Instance ? r : r.instance);
  } catch (e) {
    return {
      exitCode: 1, stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''),
      outputFiles: {},
      error: 'primary (' + args.primaryName + ') instantiate failed: ' + (e && e.message),
    };
  }
  const pmem = primaryInst.exports.memory;
  primaryHandle.mem = new __HostMem(pmem);
  memfsHandle.hostMem = primaryHandle.mem;

  // 5. Run _start.
  let exitCode = 0;
  try {
    primaryInst.exports._start();
  } catch (exn) {
    if (exn instanceof __ProcExit) {
      exitCode = exn.code;
    } else {
      hostWriteErr('[clang-runner] ' + args.primaryName + ' trapped: ' + (exn && exn.message) + '\\n');
      exitCode = 1;
    }
  }

  // 6. Harvest output files.
  const outputs = {};
  for (const path of args.outputPaths || []) {
    // memfs paths are rootless.
    const p = path.replace(/^\\/+/, '');
    const pBuf = memfsInst.exports.GetPathBuf();
    const m = new Uint8Array(memfsMem.buffer);
    for (let j = 0; j < p.length; j++) m[pBuf + j] = p.charCodeAt(j) & 0xff;
    try {
      const inode = memfsInst.exports.FindNode(p.length);
      if (inode > 0) {
        const addr = memfsInst.exports.GetFileNodeAddress(inode);
        const sz = memfsInst.exports.GetFileNodeSize(inode);
        if (sz > 0) {
          const bytes = new Uint8Array(memfsMem.buffer, addr, sz);
          // Copy out (slice) because the next memfs op may invalidate
          // the view if memory grows.
          const copy = new Uint8Array(sz);
          copy.set(bytes);
          outputs[path] = __b64encode(copy);
        } else {
          outputs[path] = '';
        }
      }
    } catch { /* not found */ }
  }

  return {
    exitCode,
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    outputFiles: outputs,
  };
};

// ── END: clang-runner preamble ────────────────────────────────────────
`;
