/**
 * bash-runner — real GNU bash 5.2.37 (wasm32-wasi, asyncified) in a
 * dedicated facet.
 *
 * bash CANNOT run through the stock JSPI wasm-runner: the binary is
 * asyncify-instrumented (fork/setjmp/blocking-pipe unwinds) and needs
 * 15 `nimbus_proc` imports plus MULTIPLE instances per facet (fork).
 * This runner embeds the proven multi-instance fork/pipe/exec/setjmp
 * scheduler (packages/worker/wasm/bash/run-bash-fork.mjs — the local
 * acid-test driver, itself a port of the PROVEN-LIVE fork M1/M2/M3
 * mechanisms) as a facet preamble.
 *
 * Architecture (mirrors ruby-runner's facet dispatch):
 *  - bash.async.wasm + the coreutil exec targets ride the LOADER
 *    modules map (compiled by workerd at module-load; exposed on
 *    globalThis.__NIMBUS_WASM).
 *  - The preamble defines __bashBoot / __bashFeed. Boot instantiates
 *    bash, pumps the scheduler until the process tree exits or the
 *    root parks on a terminal stdin read; each feed delivers stdin
 *    bytes and pumps again. Facet state persists across submits on
 *    the warm isolate (same mechanism as __rubyInstance caching).
 *  - stdout/stderr accumulate per pump slice and stream back to the
 *    CommandContext; VFS writes come back as a WasiFsDiff on exit.
 */
import type { RuntimeManifest } from './runtime-catalog.js';
import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import type { Command, CommandContext, CommandInputStream } from '../substrate/lifo/commands/types.js';
import { z } from 'zod';
import type { WasiFsDiff, WasiFsSnapshot } from './wasi-instance.js';
import { flushVfsDiff, snapshotVfs } from './vfs-snapshot.js';
import { requireVfsCred } from './os-contracts.js';
import { resolveVfsPath } from '../vfs/path.js';
import { getFacetManagerLoaderHost } from './ruby-runner.js';

type BashRunnerFactory = (
  manifest: RuntimeManifest,
  installRoot: string,
  binName: string,
  binKind: string | undefined,
) => Command;

interface BashBootArgs {
  op: 'boot';
  argv: string[];
  environ: string[];
  cwd: string;
  fsSnapshot: WasiFsSnapshot;
  stdinData: string;
  stdinClosed: boolean;
  stdinTty: boolean;
  /** Applet names the busybox multicall module answers to (busybox --list). */
  busyboxApplets: string[];
}

interface BashFeedArgs {
  op: 'feed';
  data: string;
  eof: boolean;
}

type BashStepArgs = BashBootArgs | BashFeedArgs;

export interface BashSlice {
  state: 'need-input' | 'exited' | 'error';
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  fsDiff?: WasiFsDiff;
  stats?: Record<string, unknown>;
}

const BashSliceSchema = z.object({
  state: z.enum(['need-input', 'exited', 'error']),
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  fsDiff: z.custom<WasiFsDiff>().optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function normalizeSlice(raw: unknown): BashSlice | null {
  const parsed = BashSliceSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    state: parsed.data.state,
    exitCode: Number(parsed.data.exitCode ?? 0),
    stdout: parsed.data.stdout || '',
    stderr: parsed.data.stderr || '',
    error: parsed.data.error,
    fsDiff: parsed.data.fsDiff,
    stats: parsed.data.stats,
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function bashFacetStep(args: BashStepArgs): Promise<unknown> {
  const boot = Reflect.get(globalThis, '__bashBoot');
  const feed = Reflect.get(globalThis, '__bashFeed');
  if (typeof boot !== 'function' || typeof feed !== 'function') {
    return {
      state: 'error',
      exitCode: 127,
      stdout: '',
      stderr: '',
      error: 'bash-runner preamble missing (__bashBoot/__bashFeed not in scope)',
    };
  }
  return args.op === 'boot' ? boot(args) : feed(args);
}

export interface BashFacetSession {
  readonly initial: BashSlice;
  push(data: string, eof?: boolean): Promise<BashSlice>;
  close(): Promise<void>;
}

export async function createBashFacetSession(deps: {
  facetMgr: FacetManager;
  vfs: CredentialedVfs;
  manifest: RuntimeManifest;
  installRoot: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdinData?: string;
  stdinClosed: boolean;
  stdinTty: boolean;
  extraRoots?: string[];
}): Promise<BashFacetSession> {
  const findFile = (relativePath: string): string | null => {
    const entry = deps.manifest.files.find((file) => file.path === relativePath);
    return entry ? `${deps.installRoot}/${entry.path}` : null;
  };
  const bashWasmPath = findFile('share/bash/bash.async.wasm');
  if (!bashWasmPath || !deps.vfs.exists(bashWasmPath)) {
    throw new Error("bash.async.wasm missing (re-run 'nimbus install bash')");
  }

  const userEnv: Record<string, string> = { ...deps.env };
  userEnv.HOME ||= '/home/user';
  userEnv.PATH ||= '/bin:/usr/bin';
  userEnv.TERM ||= 'dumb';
  userEnv.NIMBUS_PWD = deps.cwd;
  userEnv.BASH_ENV ||= '/etc/nimbus.bashrc';
  userEnv.PWD = deps.cwd;

  const extraRoots = [...(deps.extraRoots ?? [])];
  if (userEnv.HOME !== '/home/user') extraRoots.push(userEnv.HOME);
  const fsSnapshot = snapshotVfs(deps.vfs, deps.cwd, { extraRoots });
  if ('error' in fsSnapshot) throw new Error(fsSnapshot.error);

  const wasmModules: Record<string, ArrayBuffer> = {
    'bash.async.wasm': toArrayBuffer(deps.vfs.readFile(bashWasmPath)),
  };
  for (const file of deps.manifest.files) {
    const prefix = 'share/bash/coreutils/';
    if (!file.path.startsWith(prefix) || !file.path.endsWith('.wasm')) continue;
    const name = file.path.slice(prefix.length, -'.wasm'.length);
    const vfsPath = `${deps.installRoot}/${file.path}`;
    if (deps.vfs.exists(vfsPath)) {
      wasmModules[`cu_${name}.wasm`] = toArrayBuffer(deps.vfs.readFile(vfsPath));
    }
  }

  const appletsPath = findFile('share/bash/coreutils/busybox.applets');
  const busyboxApplets = appletsPath && deps.vfs.exists(appletsPath)
    ? new TextDecoder().decode(deps.vfs.readFile(appletsPath))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    : [];

  const { NimbusLoaderPool } = await import('../loaders/loader-pool.js');
  const { env, ctx } = getFacetManagerLoaderHost(deps.facetMgr);
  const pool = new NimbusLoaderPool(env, ctx, {
    tag: 'bash-runner',
    concurrency: 1,
    omitSupervisor: true,
    preamble: BASH_RUNNER_PREAMBLE,
    wasmModules,
  });

  let active = true;
  let closed = false;
  const submit = async (args: BashStepArgs): Promise<BashSlice> => {
    const slice = normalizeSlice(
      await pool.submit<BashStepArgs, unknown>(bashFacetStep, args, { timeoutMs: 300_000 }),
    );
    if (!slice) throw new Error('facet returned an invalid payload');
    if (slice.state === 'exited') {
      if (slice.fsDiff) flushVfsDiff(deps.vfs, slice.fsDiff);
      active = false;
    } else if (slice.state === 'error') {
      active = false;
    }
    return slice;
  };

  try {
    const initial = await submit({
      op: 'boot',
      argv: deps.argv,
      environ: Object.entries(userEnv).map(([key, value]) => `${key}=${value}`),
      cwd: deps.cwd,
      fsSnapshot: fsSnapshot.snapshot,
      stdinData: deps.stdinData ?? '',
      stdinClosed: deps.stdinClosed,
      stdinTty: deps.stdinTty,
      busyboxApplets,
    });
    return {
      initial,
      push(data, eof = false) {
        if (closed) throw new Error('bash facet session is closed');
        return submit({ op: 'feed', data, eof });
      },
      async close() {
        if (closed) return;
        try {
          if (active) await submit({ op: 'feed', data: '', eof: true });
        } catch {
          // Session teardown is best-effort; the owning command already
          // reports dispatch failures from boot/push.
        } finally {
          closed = true;
          pool.dispose();
        }
      },
    };
  } catch (error: unknown) {
    pool.dispose();
    throw error;
  }
}

/** bash flags that consume the following argv element. */
const BASH_OPT_WITH_ARG = new Set(['-c', '-o', '+o', '--rcfile', '--init-file']);

/**
 * Locate the script-path argv element (first non-flag arg when -c is
 * absent) so the handler can resolve it against the session cwd —
 * bash's own cwd inside the facet starts at '/' until the BASH_ENV
 * chdir runs, so relative script paths must be made absolute host-side.
 * Returns the argv index or -1 (interactive / -c / stdin modes).
 */
function findScriptArgIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') return i + 1 < argv.length ? i + 1 : -1;
    if (a === '-' ) return -1;               // read from stdin
    if (a.startsWith('-') || a.startsWith('+')) {
      if (BASH_OPT_WITH_ARG.has(a)) {
        if (a === '-c') return -1;           // command string mode
        i++;                                  // skip the option's argument
      }
      continue;
    }
    return i;
  }
  return -1;
}

export function makeBashRunnerFactory(deps: {
  facetMgr: FacetManager;
  vfs: SqliteVFS;
}): BashRunnerFactory {
  return function bashRunnerFactory(manifest, installRoot, binName, _binKind) {
    return async function bashBinHandler(ctx: CommandContext): Promise<number> {
      // All VFS access (runtime wasm reads, script probes, snapshot,
      // fsDiff writeback) runs as the INVOKING process credential —
      // S2a enforcement applies to bash exactly as to ruby/python.
      const cred = requireVfsCred('cred' in ctx ? ctx.cred : undefined, binName);
      const vfs = deps.vfs.as(cred);
      const argv = [...(ctx.args ?? [])];
      const cwd = ctx.cwd || '/home/user';

      // Resolve a relative script path against the session cwd.
      const scriptIdx = findScriptArgIndex(argv);
      const extraRoots: string[] = [];
      if (scriptIdx >= 0) {
        const abs = resolveVfsPath(argv[scriptIdx], cwd);
        if (!vfs.exists(abs)) {
          ctx.stderr.write(`${binName}: ${argv[scriptIdx]}: No such file or directory\n`);
          return 127;
        }
        // Pass bash an ABSOLUTE path: the facet chdir's to the session
        // cwd via BASH_ENV before opening the script, so a relative arg
        // would resolve against cwd twice. resolveVfsPath returns a
        // slash-less canonical key; re-anchor it at root.
        argv[scriptIdx] = '/' + abs;
        const dir = abs.replace(/\/[^/]*$/, '');
        if (dir) extraRoots.push(dir);
      }

      // stdin plumbing. A terminal-backed fd 0 feeds incrementally
      // (interactive bash, `read` builtins); a piped stdin is drained
      // upfront and closed so the scheduler never parks on it.
      const stdinIsTty = typeof ctx.isFdTerminal === 'function' ? ctx.isFdTerminal(0) : !ctx.stdin;
      const feedStream: CommandInputStream | undefined = ctx.terminalStdin ?? ctx.stdin;
      let stdinData = '';
      let stdinClosed = true;
      if (stdinIsTty && feedStream) {
        stdinClosed = false;
      } else if (ctx.stdin) {
        stdinData = await ctx.stdin.readAll();
      }

      let session: BashFacetSession | null = null;
      try {
        session = await createBashFacetSession({
          facetMgr: deps.facetMgr,
          vfs,
          manifest,
          installRoot,
          argv: [binName, ...argv],
          env: ctx.env || {},
          cwd,
          stdinData,
          stdinClosed,
          stdinTty: stdinIsTty,
          extraRoots,
        });
        let slice = session.initial;

        for (;;) {
          if (slice.stdout) ctx.stdout.write(slice.stdout);
          if (slice.stderr) ctx.stderr.write(slice.stderr);
          if (slice.state === 'exited') {
            return slice.exitCode;
          }
          if (slice.state === 'error') {
            ctx.stderr.write(`${binName}: ${slice.error || 'bash facet error'}\n`);
            return slice.exitCode || 1;
          }
          // need-input: pull the next chunk from the terminal.
          let data = '';
          let eof = true;
          if (!ctx.signal.aborted && feedStream) {
            const chunk = await feedStream.read();
            if (!ctx.signal.aborted) { data = chunk === null ? '' : chunk.replace(/\r\n?/g, '\n'); eof = chunk === null; }
          }
          slice = await session.push(data, eof);
        }
      } catch (e: unknown) {
        ctx.stderr.write(`${binName}: dispatch failed: ${errorMessage(e)}\n`);
        return 1;
      } finally {
        await session?.close();
      }
    };
  };
}

/**
 * The facet-side scheduler. Direct port of the PROVEN local acid-test
 * driver (packages/worker/wasm/bash/run-bash-fork.mjs) with the
 * production additions: a VFS-snapshot file layer, terminal stdin
 * park/feed, jmp_buf→slot reuse (bounded slots for long interactive
 * sessions), fsDiff capture, and memory stats.
 *
 * Arena sizing: MAIN_SIZE bounds one asyncify stack capture (bash's
 * measured captures are <64 KiB; 8 MiB is generous headroom), SLOT_*
 * bound setjmp snapshots. sbrk growth lands AFTER the arena (wasm
 * memory only grows at the end), so no inter-arena headroom is needed.
 */
export const BASH_RUNNER_PREAMBLE = String.raw`
// ── BEGIN: bash-runner preamble (GNU bash 5.2.37, Nimbus fork runtime) ──
(() => {
const PAGE = 65536, te = new TextEncoder(), td = new TextDecoder();
// Sizing is measurement-grounded (local pre-gate stats): bash's deepest
// observed asyncify capture is ~25 KiB (full control suite), so 8 MiB
// main / 256 KiB slots carry 300×/10× margin while keeping a full
// instance ~17 MiB — several forks fit the ~180-200 MiB facet ceiling.
const MAIN_SIZE = 8 << 20, SLOT_SIZE = 256 << 10, NSLOT = 32;
const E = { ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, PERM: 63, SPIPE: 70 };
// Per-file times are not part of the VFS snapshot; every inode reports the
// isolate boot instant (same discipline as the JSPI shim's seeded "now").
const BOOT_NS = BigInt(Date.now()) * 1000000n;
class Exit { constructor(c) { this.code = c; } }

let S = null;  // active session state; persists across submits on the warm isolate

function norm(p) {
  const parts = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

function newSession(args) {
  const wasmTable = globalThis.__NIMBUS_WASM || {};
  const mod = wasmTable['bash.async.wasm'];
  if (!mod) throw new Error('bash.async.wasm missing from __NIMBUS_WASM');
  const coreutils = new Map();
  for (const key of Object.keys(wasmTable)) {
    if (key.startsWith('cu_') && key.endsWith('.wasm')) coreutils.set(key.slice(3, -5), wasmTable[key]);
  }
  // Applet aliasing: ONE staged busybox module answers to every applet
  // name (busybox dispatches on argv[0]), so bash's PATH lookup finds
  // ls/cat/grep/... as executables in /bin.
  const busybox = wasmTable['cu_busybox.wasm'];
  if (busybox) for (const name of args.busyboxApplets || []) coreutils.set(name, busybox);

  const fs = {
    files: new Map(), dirs: new Set(), modes: new Map(),
    written: new Set(), deleted: new Set(),
    dirsCreated: new Set(), dirsDeleted: new Set(), modesChanged: new Map(),
  };
  const snap = args.fsSnapshot || { files: {}, dirs: [], modes: {} };
  for (const [path, b64] of Object.entries(snap.files || {})) fs.files.set(norm(path), { bytes: b64ToBytes(b64) });
  for (const d of snap.dirs || []) fs.dirs.add(norm(d));
  // The snapshot's modes are the S2a projection: effective rwx per path
  // for the invoking credential. Enforced by the WASI layer below.
  for (const [path, m] of Object.entries(snap.modes || {})) fs.modes.set(norm(path), Number(m) & 7);
  for (const seed of ['etc', 'dev', 'bin', 'usr', 'usr/bin']) {
    fs.dirs.add(seed);
    if (!fs.modes.has(seed)) fs.modes.set(seed, 5);
  }
  // Startup rc: chdir to the session cwd (wasi-libc cwd starts at '/').
  // BASH_ENV points here for non-interactive shells; interactive shells
  // read ~/.bashrc, which is seeded to source this file when absent.
  if (!fs.files.has('etc/nimbus.bashrc')) {
    fs.files.set('etc/nimbus.bashrc', { bytes: te.encode('command cd "$' + '{NIMBUS_PWD:-/}" 2>/dev/null\n') });
    fs.modes.set('etc/nimbus.bashrc', 4);
  }
  const home = norm((args.environ.find((e) => e.startsWith('HOME=')) || 'HOME=/home/user').slice(5));
  if (args.stdinTty && home && !fs.files.has(home + '/.bashrc')) {
    fs.files.set(home + '/.bashrc', { bytes: te.encode('. /etc/nimbus.bashrc\n') });
    if (!fs.modes.has(home + '/.bashrc')) fs.modes.set(home + '/.bashrc', 6);
  }

  const cwd = norm((args.environ.find((e) => e.startsWith('NIMBUS_PWD=')) || 'NIMBUS_PWD=/').slice(11));
  return {
    mod, coreutils, fs, cwd,
    argv: args.argv, environ: args.environ,
    stdinTty: !!args.stdinTty,
    stdin: { chunks: args.stdinData ? [te.encode(args.stdinData)] : [], queued: 0, closed: !!args.stdinClosed, waiters: [] },
    procs: new Map(), pipes: new Map(), runnable: [], exitStatus: new Map(), waiters: [],
    pidNext: 100, pipeNext: 1, rootPid: 0, rootExit: null, steps: 0,
    out: '', err: '',
    missingWasi: new Set(),
    stats: { instances: 0, memPeak: 0, mainHi: 0, slotHi: 0 },
    error: null,
  };
}
function initStdinQueued(s) { s.stdin.queued = s.stdin.chunks.reduce((a, c) => a + c.length, 0); }

function newPipe(s) { const id = s.pipeNext++; s.pipes.set(id, { chunks: [], queued: 0, readers: 1, writers: 1, readW: [] }); return id; }
// fd 3 is the wasi-libc '/' preopen. It lives in the fd table as a
// real 'preopen' entry: wasi-libc's path ops fd_fdstat_get the dirfd
// to compute inherited rights, so it must answer (not EBADF), and
// lowestFd must never re-issue it for a regular file.
function lowestFd(proc) { let fd = 0; while (proc.fds.has(fd) || fd === 3) fd++; return fd; }
function bumpPipe(s, e, d) { const pp = s.pipes.get(e.pipeId); if (e.end === 'r') pp.readers += d; else pp.writers += d; }
function closeFd(s, proc, fd) {
  const e = proc.fds.get(fd);
  if (!e) return;
  proc.fds.delete(fd);
  if (e.kind === 'pipe') { bumpPipe(s, e, -1); wakePipe(s, s.pipes.get(e.pipeId)); }
}
function takeUpTo(src, max) {
  let need = max; const parts = [];
  while (need > 0 && src.chunks.length) {
    const ch = src.chunks[0];
    if (ch.length <= need) { parts.push(ch); need -= ch.length; src.chunks.shift(); }
    else { parts.push(ch.subarray(0, need)); src.chunks[0] = ch.subarray(need); need = 0; }
  }
  const total = max - need; src.queued -= total;
  const o = new Uint8Array(total); let x = 0;
  for (const p of parts) { o.set(p, x); x += p.length; }
  return o;
}
function wakePipe(s, pp) {
  while (pp.readW.length && (pp.queued > 0 || pp.writers === 0)) {
    const w = pp.readW.shift(); const proc = w.proc; const req = proc.ctx.pipeReq;
    const bytes = pp.queued > 0 ? takeUpTo(pp, req.len) : new Uint8Array(0);
    proc.pendingRead = { ptr: req.ptr, bytes, nreadPtr: req.nreadPtr, isPoll: req.isPoll, pollUserdata: req.pollUserdata };
    resumeProc(proc);
  }
}
function wakeStdin(s) {
  const st = s.stdin;
  while (st.waiters.length && (st.queued > 0 || st.closed)) {
    const w = st.waiters.shift(); const proc = w.proc; const req = proc.ctx.pipeReq;
    const bytes = st.queued > 0 ? takeUpTo(st, req.len) : new Uint8Array(0);
    proc.pendingRead = { ptr: req.ptr, bytes, nreadPtr: req.nreadPtr, isPoll: req.isPoll, pollUserdata: req.pollUserdata };
    resumeProc(proc);
  }
}

// ── file layer ────────────────────────────────────────────────────────
function fileLookup(s, path) { return s.fs.files.get(path) || null; }
function isDir(s, path) { return path === '' || s.fs.dirs.has(path); }
function isCoreutil(s, path) {
  if (!path.startsWith('bin/') && !path.startsWith('usr/bin/')) return false;
  return s.coreutils.has(path.split('/').pop());
}
// A modes-only inode is a file the snapshot could not read (S2a): it
// exists, its bytes are absent, and access answers with the real bits.
function fileExists(s, path) {
  return s.fs.files.has(path) || (s.fs.modes.has(path) && !s.fs.dirs.has(path));
}
function inodeExists(s, path) {
  return s.fs.files.has(path) || s.fs.dirs.has(path) || s.fs.modes.has(path);
}
// S2a effective-mode policy (mirrors the JSPI shim): a mapped mode wins;
// an inode that exists without one is denied; an absent path is free to
// create (the durable flush re-checks as the credential).
function effMode(s, path) {
  if (path === '') return 7;
  const m = s.fs.modes.get(path);
  if (m !== undefined) return m;
  if (isCoreutil(s, path)) return 5;
  return inodeExists(s, path) ? 0 : 7;
}
function parentOf(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
// Every ancestor dir on the way to the target needs the search (x) bit.
function checkTraversal(s, path) {
  const parts = path.split('/');
  let anc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    anc = anc ? anc + '/' + parts[i] : parts[i];
    if (!isDir(s, anc)) return inodeExists(s, anc) ? E.NOTDIR : E.NOENT;
    if ((effMode(s, anc) & 1) === 0) return E.ACCES;
  }
  return 0;
}
function checkParentWritable(s, path) {
  const parent = parentOf(path);
  if (parent && (effMode(s, parent) & 3) !== 3) return E.ACCES;
  return 0;
}
function recordDirAdded(s, path) {
  s.fs.dirs.add(path); s.fs.dirsDeleted.delete(path); s.fs.dirsCreated.add(path);
  if (!s.fs.modes.has(path)) s.fs.modes.set(path, 7);
}
function recordDirRemoved(s, path) {
  s.fs.dirs.delete(path); s.fs.modes.delete(path);
  if (s.fs.dirsCreated.has(path)) s.fs.dirsCreated.delete(path);
  else s.fs.dirsDeleted.add(path);
}
function recordFileRemoved(s, path) {
  s.fs.files.delete(path); s.fs.written.delete(path); s.fs.modes.delete(path);
  s.fs.deleted.add(path);
}
function markWritten(s, path) {
  s.fs.written.add(path); s.fs.deleted.delete(path);
  if (!s.fs.modes.has(path)) s.fs.modes.set(path, 6);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!s.fs.dirs.has(dir)) recordDirAdded(s, dir);
  }
}
function fileWrite(s, entry, path, pos, bytes) {
  const need = pos + bytes.length;
  if (need > entry.bytes.length) {
    const grown = new Uint8Array(need);
    grown.set(entry.bytes); entry.bytes = grown;
  }
  entry.bytes.set(bytes, pos);
  markWritten(s, path);
}
function statBuf(dv, u8, buf, filetype, size) {
  u8.fill(0, buf, buf + 64);
  dv.setUint8(buf + 16, filetype);
  dv.setBigUint64(buf + 24, 1n, true);
  dv.setBigUint64(buf + 32, BigInt(size), true);
  dv.setBigUint64(buf + 40, BOOT_NS, true);
  dv.setBigUint64(buf + 48, BOOT_NS, true);
  dv.setBigUint64(buf + 56, BOOT_NS, true);
}

// Shared WASI surface over the process fd table + file layer. The io
// argument abstracts the blocking discipline: bash instances
// asyncify-park, exec'd plain-WASI tools synchronously pump the scheduler.
//
// pathBase (exec'd coreutils only) emulates the child's inherited cwd. An
// exec'd tool's wasi-libc has cwd '/', so it absolutizes BOTH its own
// relative args and absolute args against '/' — they reach path_open
// IDENTICALLY un-prefixed (e.g. 'ls tmp' and 'ls /tmp' both arrive 'tmp';
// 'ls' and 'ls /' both arrive ''). The lost absolute-vs-relative bit is
// recovered from absRoots: the normalized set of absolute argv paths bash
// passed the tool. A path that IS (or descends from) one of those is
// absolute-origin — the arriving string is already the correct
// root-relative target, so it is NEVER re-anchored. Everything else is
// relative-origin (a relative arg, or a child name synthesized while
// listing a directory): re-anchor against the inherited cwd, preferring
// the cwd-joined path, then the bare one, then whichever parent dir
// exists (touch newfile in the session cwd vs a '/'-listing's children).
function isUnderAbsRoot(p, absRoots) {
  if (!absRoots) return false;
  for (const a of absRoots) {
    if (p === a) return true;
    if (a !== '' && p.startsWith(a + '/')) return true;
  }
  return false;
}
function makeResolve(s, pathBase, absRoots) {
  return (raw) => {
    const p = norm(raw);
    if (!pathBase) return p;
    if (isUnderAbsRoot(p, absRoots)) return p;
    const joined = norm(pathBase + '/' + p);
    if (inodeExists(s, joined)) return joined;
    if (inodeExists(s, p)) return p;
    if (isDir(s, parentOf(joined))) return joined;
    if (isDir(s, parentOf(p))) return p;
    return joined;
  };
}
function makeWasiFs(s, proc, DV, U8, io, pathBase, absRoots) {
  const resolve = makeResolve(s, pathBase, absRoots);
  return {
    fd_prestat_get: (fd, buf) => { if (fd === 3) { DV().setUint8(buf, 0); DV().setUint32(buf + 4, 1, true); return 0; } return E.BADF; },
    fd_prestat_dir_name: (fd, path, _plen) => { if (fd === 3) { U8()[path] = 0x2f; return 0; } return E.BADF; },
    path_open: (dirfd, _dirflags, pathPtr, pathLen, oflags, rightsBase, _ri, fdflags, retPtr) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const dv = DV();
      if (path === 'dev/null' || path === 'dev/tty') {
        const fd = lowestFd(proc); proc.fds.set(fd, { kind: path === 'dev/tty' ? 'tty' : 'null' });
        dv.setUint32(retPtr, fd, true); return 0;
      }
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      const wantDir = (oflags & 2) !== 0;
      if (isDir(s, path)) {
        if ((effMode(s, path) & 1) === 0) return E.ACCES;
        const fd = lowestFd(proc); proc.fds.set(fd, { kind: 'dir', path });
        dv.setUint32(retPtr, fd, true); return 0;
      }
      if (wantDir) return fileExists(s, path) ? E.NOTDIR : E.NOENT;
      // wasi-libc encodes the open intent in the rights: fd_read is bit 1,
      // fd_write bit 6. Enforce the S2a effective mode accordingly.
      const rights = typeof rightsBase === 'bigint' ? rightsBase : BigInt(rightsBase >>> 0);
      let need = 0;
      if ((rights & 2n) !== 0n) need |= 4;
      if ((rights & 64n) !== 0n) need |= 2;
      if ((oflags & 8) !== 0) need |= 2;                    // O_TRUNC implies write
      let entry = fileLookup(s, path);
      const exists = entry !== null || fileExists(s, path);
      if (exists && (oflags & 4)) return E.EXIST;           // O_EXCL
      if (!exists) {
        if (!(oflags & 1)) return E.NOENT;                  // no O_CREAT
        const denied = checkParentWritable(s, path);
        if (denied) return denied;
        entry = { bytes: new Uint8Array(0) };
        s.fs.files.set(path, entry); markWritten(s, path);
      } else {
        if (need && (effMode(s, path) & need) !== need) return E.ACCES;
        if (!entry) {
          // Exists per the mode map but bytes were not snapshotted
          // (write-only). Start from empty content.
          entry = { bytes: new Uint8Array(0) };
          s.fs.files.set(path, entry);
        }
        if (oflags & 8) {                                   // O_TRUNC
          entry.bytes = new Uint8Array(0); markWritten(s, path);
        }
      }
      const fd = lowestFd(proc);
      proc.fds.set(fd, { kind: 'file', path, pos: 0, append: (fdflags & 1) !== 0 });
      dv.setUint32(retPtr, fd, true);
      return 0;
    },
    fd_filestat_get: (fd, buf) => {
      const e = proc.fds.get(fd);
      if (e && e.kind === 'file') { const f = fileLookup(s, e.path); statBuf(DV(), U8(), buf, 4, f ? f.bytes.length : 0); return 0; }
      if (e && (e.kind === 'dir' || e.kind === 'preopen')) { statBuf(DV(), U8(), buf, 3, 0); return 0; }
      statBuf(DV(), U8(), buf, e && (e.kind === 'stdin' || e.kind === 'stdout' || e.kind === 'stderr' || e.kind === 'tty') ? 2 : 0, 0);
      return 0;
    },
    path_filestat_get: (dirfd, _flags, pathPtr, pathLen, buf) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      if (path === 'dev/null' || path === 'dev/tty') { statBuf(DV(), U8(), buf, 2, 0); return 0; }
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      const f = fileLookup(s, path);
      if (f) { statBuf(DV(), U8(), buf, 4, f.bytes.length); return 0; }
      if (isCoreutil(s, path)) { statBuf(DV(), U8(), buf, 4, 1024); return 0; }
      if (isDir(s, path)) { statBuf(DV(), U8(), buf, 3, 0); return 0; }
      if (fileExists(s, path)) { statBuf(DV(), U8(), buf, 4, 0); return 0; }  // unreadable: size unknown
      return E.NOENT;
    },
    path_filestat_set_times: () => 0,
    path_unlink_file: (dirfd, pathPtr, pathLen) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      if (isDir(s, path)) return E.ISDIR;
      if (!fileExists(s, path)) return E.NOENT;
      const denied = checkParentWritable(s, path);
      if (denied) return denied;
      recordFileRemoved(s, path);
      return 0;
    },
    path_rename: (fd1, oldPtr, oldLen, fd2, newPtr, newLen) => {
      const from = resolve(td.decode(U8().subarray(oldPtr, oldPtr + oldLen)));
      const to = resolve(td.decode(U8().subarray(newPtr, newPtr + newLen)));
      let trav = checkTraversal(s, from);
      if (trav) return trav;
      trav = checkTraversal(s, to);
      if (trav) return trav;
      const fromIsDir = from !== '' && isDir(s, from);
      const f = fileLookup(s, from);
      if (!fromIsDir && !f && !fileExists(s, from)) return E.NOENT;
      if (from === to) return 0;
      let denied = checkParentWritable(s, from);
      if (!denied) denied = checkParentWritable(s, to);
      if (denied) return denied;
      const moveMode = (a, b) => {
        const m = s.fs.modes.get(a); s.fs.modes.delete(a);
        if (m !== undefined) s.fs.modes.set(b, m);
      };
      // Atomic-overwrite destination of the matching kind.
      if (isDir(s, to)) {
        if (!fromIsDir) return E.ISDIR;
        const prefix = to + '/';
        for (const p of s.fs.files.keys()) if (p.startsWith(prefix)) return E.NOTEMPTY;
        for (const p of s.fs.dirs) if (p.startsWith(prefix)) return E.NOTEMPTY;
        recordDirRemoved(s, to);
      } else if (fileExists(s, to)) {
        if (fromIsDir) return E.NOTDIR;
        recordFileRemoved(s, to);
      }
      if (fromIsDir) {
        const mode = s.fs.modes.get(from);
        recordDirRemoved(s, from);
        recordDirAdded(s, to);
        if (mode !== undefined) s.fs.modes.set(to, mode);
        const prefix = from + '/';
        const rebase = (key) => to + '/' + key.slice(prefix.length);
        for (const key of [...s.fs.files.keys()]) {
          if (!key.startsWith(prefix)) continue;
          const nk = rebase(key);
          const entry = s.fs.files.get(key);
          recordFileRemoved(s, key);
          moveMode(key, nk);
          s.fs.files.set(nk, entry);
          s.fs.written.add(nk); s.fs.deleted.delete(nk);
          if (!s.fs.modes.has(nk)) s.fs.modes.set(nk, 6);
        }
        for (const key of [...s.fs.dirs]) {
          if (!key.startsWith(prefix)) continue;
          const nk = rebase(key);
          const mode2 = s.fs.modes.get(key);
          recordDirRemoved(s, key);
          recordDirAdded(s, nk);
          if (mode2 !== undefined) s.fs.modes.set(nk, mode2);
        }
        return 0;
      }
      const entry = f || { bytes: new Uint8Array(0) };
      const mode = s.fs.modes.get(from);
      recordFileRemoved(s, from);
      s.fs.files.set(to, entry); markWritten(s, to);
      if (mode !== undefined) s.fs.modes.set(to, mode);
      return 0;
    },
    path_create_directory: (dirfd, pathPtr, pathLen) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      if (isDir(s, path) || fileExists(s, path)) return E.EXIST;
      const denied = checkParentWritable(s, path);
      if (denied) return denied;
      recordDirAdded(s, path);
      return 0;
    },
    path_readlink: () => E.INVAL,
    path_symlink: () => E.NOSYS,
    path_link: (fd1, _lookupFlags, oldPtr, oldLen, fd2, newPtr, newLen) => {
      const from = resolve(td.decode(U8().subarray(oldPtr, oldPtr + oldLen)));
      const to = resolve(td.decode(U8().subarray(newPtr, newPtr + newLen)));
      let trav = checkTraversal(s, from);
      if (trav) return trav;
      trav = checkTraversal(s, to);
      if (trav) return trav;
      if (isDir(s, from)) return E.PERM;
      const f = fileLookup(s, from);
      if (!f) return fileExists(s, from) ? E.ACCES : E.NOENT;
      if (fileExists(s, to) || isDir(s, to)) return E.EXIST;
      const denied = checkParentWritable(s, to);
      if (denied) return denied;
      // Both names share ONE entry object — writes through either alias
      // mutate the same bytes, which is real hard-link semantics here.
      s.fs.files.set(to, f); markWritten(s, to);
      s.fs.modes.set(to, effMode(s, from));
      return 0;
    },
    path_remove_directory: (dirfd, pathPtr, pathLen) => {
      const path = resolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const trav = checkTraversal(s, path);
      if (trav) return trav;
      if (path === '' || path === 'etc' || path === 'dev' || path === 'bin' || path === 'usr' || path === 'usr/bin') return E.ACCES;
      if (!isDir(s, path)) return fileExists(s, path) ? E.NOTDIR : E.NOENT;
      const denied = checkParentWritable(s, path);
      if (denied) return denied;
      const prefix = path + '/';
      for (const p of s.fs.files.keys()) if (p.startsWith(prefix)) return E.NOTEMPTY;
      for (const p of s.fs.dirs) if (p.startsWith(prefix)) return E.NOTEMPTY;
      for (const p of s.fs.modes.keys()) if (p.startsWith(prefix)) return E.NOTEMPTY;
      recordDirRemoved(s, path);
      return 0;
    },
    fd_renumber: (from, to) => {
      const e = proc.fds.get(from);
      if (!e) return E.BADF;
      if (from !== to) {
        closeFd(s, proc, to);
        proc.fds.set(to, e);
        proc.fds.delete(from);
      }
      return 0;
    },
    fd_readdir: (fd, buf, bufLen, cookie, retPtr) => {
      const e = proc.fds.get(fd);
      if (!e || (e.kind !== 'dir' && e.kind !== 'preopen')) return E.BADF;
      const dir = e.kind === 'preopen' ? '' : e.path;
      if ((effMode(s, dir) & 4) === 0) return E.ACCES;
      const prefix = dir ? dir + '/' : '';
      const seen = new Set(['.', '..']);
      const children = [];
      const push = (name, type) => { if (!seen.has(name)) { seen.add(name); children.push({ name, type }); } };
      for (const p of s.fs.dirs) {
        if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) push(p.slice(prefix.length), 3);
      }
      for (const p of s.fs.files.keys()) {
        if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) push(p.slice(prefix.length), 4);
      }
      for (const p of s.fs.modes.keys()) {  // modes-only inodes (unreadable files)
        if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && !s.fs.dirs.has(p)) push(p.slice(prefix.length), 4);
      }
      if (dir === 'bin' || dir === 'usr/bin') for (const name of s.coreutils.keys()) push(name, 4);
      children.sort((a, b) => (a.name < b.name ? -1 : 1));
      const entries = [{ name: '.', type: 3 }, { name: '..', type: 3 }, ...children];
      const dv = DV(), u8 = U8();
      let off = 0;
      for (let i = Number(cookie); i < entries.length; i++) {
        const nb = te.encode(entries[i].name);
        const need = 24 + nb.length;
        const record = new Uint8Array(need);
        const rdv = new DataView(record.buffer);
        rdv.setBigUint64(0, BigInt(i + 1), true);   // d_next: cookie of the next entry
        rdv.setBigUint64(8, 1n, true);              // d_ino
        rdv.setUint32(16, nb.length, true);         // d_namlen
        record[20] = entries[i].type;               // d_type
        record.set(nb, 24);
        const room = bufLen - off;
        if (need > room) {                          // truncated tail: "more remain"
          u8.set(record.subarray(0, room), buf + off);
          off = bufLen;
          break;
        }
        u8.set(record, buf + off);
        off += need;
      }
      dv.setUint32(retPtr, off, true);
      return 0;
    },
    fd_seek: (fd, offset, whence, retPtr) => {
      const e = proc.fds.get(fd);
      if (e && e.kind === 'file') {
        const f = fileLookup(s, e.path); const len = f ? f.bytes.length : 0;
        const off = Number(offset);
        const next = whence === 0 ? off : whence === 1 ? e.pos + off : len + off;
        if (next < 0) return E.INVAL;
        e.pos = next;
        DV().setBigUint64(retPtr, BigInt(next), true);
        return 0;
      }
      DV().setBigUint64(retPtr, 0n, true);
      return E.SPIPE;
    },
    fd_tell: (fd, retPtr) => {
      const e = proc.fds.get(fd);
      DV().setBigUint64(retPtr, BigInt(e && e.kind === 'file' ? e.pos : 0), true);
      return 0;
    },
    fd_close: (fd) => { closeFd(s, proc, fd); return 0; },
    fd_fdstat_get: (fd, st) => {
      const dv = DV(); const e = proc.fds.get(fd);
      let ft = 4;
      if (e && e.kind === 'pipe') ft = 0;
      else if (e && (e.kind === 'stdin' || e.kind === 'stdout' || e.kind === 'stderr')) ft = s.stdinTty || fd !== 0 ? 2 : 0;
      else if (e && e.kind === 'tty') ft = 2;
      else if (e && (e.kind === 'dir' || e.kind === 'preopen')) ft = 3;
      else if (!e) return E.BADF;
      dv.setUint8(st, ft);
      dv.setUint16(st + 2, 0, true);
      dv.setBigUint64(st + 8, 0xffffffffffffffffn, true);
      dv.setBigUint64(st + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    fd_fdstat_set_flags: () => 0,
    fd_read: (fd, iovs, _n, nread) => io.read(fd, iovs, nread),
    fd_write: (fd, iovs, n, nw) => {
      const dv = DV(), u8 = U8(); let w = 0;
      for (let i = 0; i < n; i++) {
        const p = dv.getUint32(iovs + i * 8, true), l = dv.getUint32(iovs + i * 8 + 4, true);
        w += io.write(fd, u8.subarray(p, p + l));
      }
      dv.setUint32(nw, w, true);
      return 0;
    },
    poll_oneoff: (inPtr, outPtr, nsubs, retPtr) => io.poll(inPtr, outPtr, nsubs, retPtr),
    clock_time_get: (_id, _pr, t) => { DV().setBigUint64(t, BigInt(Date.now()) * 1000000n, true); return 0; },
    random_get: (b, l) => { const u = U8(); for (let i = 0; i < l; i++) u[b + i] = (Math.random() * 256) | 0; return 0; },
    proc_exit: (code) => { throw new Exit(code); },
  };
}

// Route a write through the process fd table.
function writeThroughFd(s, proc, fd, bytes) {
  const e = proc.fds.get(fd);
  if (e && e.kind === 'pipe') {
    const pp = s.pipes.get(e.pipeId);
    pp.chunks.push(bytes.slice()); pp.queued += bytes.length;
    wakePipe(s, pp);
    return bytes.length;
  }
  if (e && e.kind === 'file') {
    const f = fileLookup(s, e.path) || { bytes: new Uint8Array(0) };
    if (!s.fs.files.has(e.path)) s.fs.files.set(e.path, f);
    const pos = e.append ? f.bytes.length : e.pos;
    fileWrite(s, f, e.path, pos, bytes);
    e.pos = pos + bytes.length;
    return bytes.length;
  }
  if (e && (e.kind === 'null' || e.kind === 'tty')) return bytes.length;
  const text = td.decode(bytes);
  if (e && e.kind === 'stderr') s.err += text;
  else s.out += text;
  return bytes.length;
}

// Synchronous read for non-parking consumers (files, buffered pipes).
// Returns {done, errno} or null when the source would block.
function tryReadFd(s, proc, fd, dv, u8, ptr, len, nreadPtr) {
  const e = proc.fds.get(fd);
  if (e && e.kind === 'file') {
    const f = fileLookup(s, e.path);
    const bytes = f ? f.bytes.subarray(e.pos, e.pos + len) : new Uint8Array(0);
    u8.set(bytes, ptr); e.pos += bytes.length;
    dv.setUint32(nreadPtr, bytes.length, true);
    return { errno: 0 };
  }
  if (e && (e.kind === 'null' || e.kind === 'tty')) { dv.setUint32(nreadPtr, 0, true); return { errno: 0 }; }
  if (e && e.kind === 'pipe') {
    const pp = s.pipes.get(e.pipeId);
    if (pp.queued > 0) { const b = takeUpTo(pp, len); u8.set(b, ptr); dv.setUint32(nreadPtr, b.length, true); return { errno: 0 }; }
    if (pp.writers === 0) { dv.setUint32(nreadPtr, 0, true); return { errno: 0 }; }
    return null;
  }
  if (e && e.kind === 'stdin') {
    const st = s.stdin;
    if (st.queued > 0) { const b = takeUpTo(st, len); u8.set(b, ptr); dv.setUint32(nreadPtr, b.length, true); return { errno: 0 }; }
    if (st.closed) { dv.setUint32(nreadPtr, 0, true); return { errno: 0 }; }
    return null;
  }
  dv.setUint32(nreadPtr, 0, true);
  return { errno: e ? 0 : E.BADF };
}

function blockTarget(s, proc, fd) {
  const e = proc.fds.get(fd);
  if (e && e.kind === 'pipe') return { list: s.pipes.get(e.pipeId).readW, wake: () => wakePipe(s, s.pipes.get(e.pipeId)) };
  if (e && e.kind === 'stdin') return { list: s.stdin.waiters, wake: () => wakeStdin(s) };
  return null;
}

// ── per-process bash instance ─────────────────────────────────────────
function makeProc(s, pid, ppid, fds) {
  const proc = {
    pid, ppid, fds, inst: null, __s: s,
    ctx: { reason: null, rewinding: false, captureEnv: 0, ljEnv: 0, ljVal: 0, nextSlot: 0, resume: 0 },
    MAIN_BUF: 0, SLOT0: 0, pendingRead: null,
    slotByEnv: new Map(), freeSlots: [],
  };
  const DV = () => new DataView(proc.inst.exports.memory.buffer);
  const U8 = () => new Uint8Array(proc.inst.exports.memory.buffer);
  proc.DV = DV; proc.U8 = U8;
  const slotAddr = (i) => proc.SLOT0 + i * SLOT_SIZE;
  proc.slotAddr = slotAddr;
  const initHdr = (a, sz) => { const dv = DV(); dv.setUint32(a, a + 8, true); dv.setUint32(a + 4, a + sz, true); };
  proc.initHdr = initHdr;
  const wstr = (p, str) => { const b = te.encode(str); U8().set(b, p); return b.length; };
  const c = proc.ctx;

  const io = {
    read: (fd, iovs, nread) => {
      if (proc.pendingRead) {
        proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false;
        const pr = proc.pendingRead; proc.pendingRead = null;
        U8().set(pr.bytes, pr.ptr);
        DV().setUint32(pr.nreadPtr, pr.bytes.length, true);
        return 0;
      }
      const dv = DV();
      const p = dv.getUint32(iovs, true), l = dv.getUint32(iovs + 4, true);
      const sync = tryReadFd(s, proc, fd, dv, U8(), p, l, nread);
      if (sync) return sync.errno;
      // would block: asyncify-park until bytes/EOF arrive
      dv.setUint32(nread, 0, true);
      c.reason = 'blockread';
      c.pipeReq = { fd, ptr: p, len: l, nreadPtr: nread, isPoll: false };
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    write: (fd, bytes) => writeThroughFd(s, proc, fd, bytes),
    poll: (inPtr, outPtr, nsubs, retPtr) => {
      if (proc.pendingRead) {  // poll resume: report the fd readable
        proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false;
        const pr = proc.pendingRead; proc.pendingRead = null;
        const dv = DV();
        dv.setBigUint64(outPtr, pr.pollUserdata, true);
        dv.setUint16(outPtr + 8, 0, true);
        dv.setUint8(outPtr + 10, 1);  // eventtype fd_read
        dv.setBigUint64(outPtr + 16, BigInt(pr.bytes.length), true);
        dv.setUint16(outPtr + 24, 0, true);
        dv.setUint32(retPtr, 1, true);
        return 0;
      }
      const dv = DV();
      let emitted = 0;
      let blockSub = null;
      for (let i = 0; i < nsubs; i++) {
        const sub = inPtr + i * 48;
        const userdata = dv.getBigUint64(sub, true);
        const tag = dv.getUint8(sub + 8);
        if (tag === 0) {  // clock: report immediately (in-facet clocks are frozen anyway)
          const ev = outPtr + emitted * 32;
          dv.setBigUint64(ev, userdata, true); dv.setUint16(ev + 8, 0, true); dv.setUint8(ev + 10, 0);
          emitted++;
          continue;
        }
        const fd = dv.getUint32(sub + 16, true);
        const e = proc.fds.get(fd);
        let ready = true, avail = 0;
        if (tag === 1 && e) {
          if (e.kind === 'pipe') { const pp = s.pipes.get(e.pipeId); ready = pp.queued > 0 || pp.writers === 0; avail = pp.queued; }
          else if (e.kind === 'stdin') { ready = s.stdin.queued > 0 || s.stdin.closed; avail = s.stdin.queued; }
        }
        if (ready) {
          const ev = outPtr + emitted * 32;
          dv.setBigUint64(ev, userdata, true); dv.setUint16(ev + 8, 0, true); dv.setUint8(ev + 10, tag);
          dv.setBigUint64(ev + 16, BigInt(avail), true); dv.setUint16(ev + 24, 0, true);
          emitted++;
        } else if (!blockSub) {
          blockSub = { fd, userdata };
        }
      }
      if (emitted > 0 || !blockSub) { dv.setUint32(retPtr, emitted, true); return 0; }
      // Nothing ready and a blockable fd-read subscription: park.
      dv.setUint32(retPtr, 0, true);
      c.reason = 'blockread';
      c.pipeReq = { fd: blockSub.fd, ptr: 0, len: 0, nreadPtr: 0, isPoll: true, pollUserdata: blockSub.userdata };
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
  };

  const wasiBase = makeWasiFs(s, proc, DV, U8, io);
  const wasi = {
    ...wasiBase,
    args_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, s.argv.length, true); dv.setUint32(b, s.argv.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    args_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const a of s.argv) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, a); U8()[p++] = 0; } return 0; },
    environ_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, s.environ.length, true); dv.setUint32(b, s.environ.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    environ_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const v of s.environ) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, v); U8()[p++] = 0; } return 0; },
  };

  // Slot allocator. Each setjmp captures into a FRESH physical slot
  // (overwriting a slot in place while its snapshot is still a live
  // longjmp target corrupts the asyncify rewind — the exit-builtin's
  // jump_to_top_level recursion proved this). Correct recycling: a
  // re-setjmp of the SAME jmp_buf makes that buf's previous slot a dead
  // target (POSIX: only the most recent setjmp per buf is live), so we
  // return it to a FIFO free-list — reused only after other allocations
  // cycle through, never the just-freed address. This bounds slot use
  // for long interactive sessions (bash re-setjmps top_level per
  // command) without the in-place-overwrite hazard.
  const allocSlot = (env) => {
    const prev = proc.slotByEnv.get(env);
    if (prev !== undefined) { proc.slotByEnv.delete(env); proc.freeSlots.push(prev); }
    let idx;
    if (proc.freeSlots.length > 1) idx = proc.freeSlots.shift();
    else if (c.nextSlot < NSLOT) idx = c.nextSlot++;
    else idx = proc.freeSlots.shift();
    if (idx === undefined) throw new Error('bash-runner: setjmp slot budget exceeded (' + NSLOT + ')');
    proc.slotByEnv.set(env, idx);
    return idx;
  };

  const nimbus_proc = {
    setjmp: (env) => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return; }
      c.reason = 'capture'; c.captureEnv = env;
      const idx = allocSlot(env);
      const dv = DV(); dv.setInt32(env, idx, true); dv.setInt32(env + 4, 0, true);
      initHdr(slotAddr(idx), SLOT_SIZE);
      proc.inst.exports.asyncify_start_unwind(slotAddr(idx));
    },
    longjmp: (env, val) => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return; }
      c.reason = 'longjmp'; c.ljEnv = env; c.ljVal = val;
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
    },
    fork: () => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return c.resume; }
      c.reason = 'fork';
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    vfork: () => nimbus_proc.fork(),
    waitpid: (pid, statusPtr, _opt) => {
      if (c.rewinding) {
        proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false;
        if (c.waitStatusPtr != null) DV().setInt32(c.waitStatusPtr, c.resumeStatus, true);
        return c.resume;
      }
      c.reason = 'waitpid'; c.waitTarget = pid; c.waitStatusPtr = statusPtr;
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    execve: (pathPtr, argvFlatPtr, argvLen, envFlatPtr, envLen) => {
      if (c.rewinding) { proc.inst.exports.asyncify_stop_rewind(); c.rewinding = false; return c.resume; }
      const u8 = U8();
      let e = pathPtr; while (u8[e]) e++;
      c.reason = 'exec';
      c.execPath = td.decode(u8.subarray(pathPtr, e));
      c.execArgv = td.decode(u8.subarray(argvFlatPtr, argvFlatPtr + argvLen)).split('\0').filter((x) => x.length);
      // The child's REAL environment (bash's export set at exec time —
      // PWD tracks the shell's cd, unlike the boot-time s.environ).
      c.execEnv = td.decode(u8.subarray(envFlatPtr, envFlatPtr + envLen)).split('\0').filter((x) => x.length);
      initHdr(proc.MAIN_BUF, MAIN_SIZE);
      proc.inst.exports.asyncify_start_unwind(proc.MAIN_BUF);
      return 0;
    },
    pipe: (fdsPtr) => {
      const id = newPipe(s);
      const rfd = lowestFd(proc); proc.fds.set(rfd, { kind: 'pipe', pipeId: id, end: 'r' });
      const wfd = lowestFd(proc); proc.fds.set(wfd, { kind: 'pipe', pipeId: id, end: 'w' });
      const dv = DV(); dv.setInt32(fdsPtr, rfd, true); dv.setInt32(fdsPtr + 4, wfd, true);
      return 0;
    },
    dup: (o) => {
      const e = proc.fds.get(o); if (!e) return -E.BADF;
      const nf = lowestFd(proc); proc.fds.set(nf, { ...e });
      if (e.kind === 'pipe') bumpPipe(s, e, 1);
      return nf;
    },
    dup2: (o, n) => {
      const e = proc.fds.get(o); if (!e) return -E.BADF;
      if (o === n) return n;
      if (proc.fds.has(n)) closeFd(s, proc, n);
      proc.fds.set(n, { ...e });
      if (e.kind === 'pipe') bumpPipe(s, e, 1);
      return n;
    },
    kill: () => 0, setpgid: () => 0, getpgid: () => proc.pid, getppid: () => proc.ppid,
    tcsetpgrp: () => 0, tcgetpgrp: () => proc.pid, tcgetattr: () => -1, tcsetattr: () => 0,
  };
  const envImports = {
    getpid: () => proc.pid, getuid: () => 0, geteuid: () => 0, getgid: () => 0, getegid: () => 0,
    setuid: () => 0, setgid: () => 0, umask: () => 0o22,
    gethostname: (p, _l) => { U8().set(te.encode('nimbus'), p); return 0; },
    dlopen: () => 0, dlsym: () => 0, dlclose: () => 0, dlerror: () => 0,
  };
  // Unimplemented wasi calls return success (the proven driver's
  // discipline — bash tolerates no-op fd_sync etc.); each miss is
  // recorded so the live gate can surface true WASI gaps.
  const wasiProxy = new Proxy(wasi, {
    get: (t, k) => (k in t ? t[k] : (() => { s.missingWasi.add(String(k)); return 0; })),
  });
  proc.inst = new WebAssembly.Instance(s.mod, { wasi_snapshot_preview1: wasiProxy, nimbus_proc, env: envImports });
  s.stats.instances++;
  s.procs.set(pid, proc);
  return proc;
}

function setupArena(proc) {
  const base = proc.inst.exports.memory.buffer.byteLength;
  const need = MAIN_SIZE + NSLOT * SLOT_SIZE;
  proc.inst.exports.memory.grow(Math.ceil(need / PAGE));
  proc.MAIN_BUF = base;
  proc.SLOT0 = proc.MAIN_BUF + MAIN_SIZE;
}

// ── scheduler ─────────────────────────────────────────────────────────
function resumeProc(proc) {
  proc.ctx.rewinding = true;
  proc.inst.exports.asyncify_start_rewind(proc.MAIN_BUF);
  proc.__s.runnable.push(proc);
}

function trackArena(s, proc, bufAddr, size, isSlot) {
  const used = proc.DV().getUint32(bufAddr, true) - (bufAddr + 8);
  if (isSlot) { if (used > s.stats.slotHi) s.stats.slotHi = used; }
  else if (used > s.stats.mainHi) s.stats.mainHi = used;
}

function step(s, proc) {
  const c = proc.ctx, ex = proc.inst.exports;
  try { ex._start(); }
  catch (e) {
    if (e instanceof Exit) { finishProc(s, proc, e.code); return; }
    throw e;
  }
  if (c.reason === null) { finishProc(s, proc, 0); return; }
  ex.asyncify_stop_unwind();
  const r = c.reason; c.reason = null;
  const dv = proc.DV();
  const mem = proc.inst.exports.memory.buffer.byteLength;
  if (mem > s.stats.memPeak) s.stats.memPeak = mem;
  if (r === 'capture') {
    const idx = dv.getInt32(c.captureEnv, true);
    trackArena(s, proc, proc.slotAddr(idx), SLOT_SIZE, true);
    dv.setUint32(c.captureEnv + 8, dv.getUint32(proc.slotAddr(idx), true), true);
    c.rewinding = true;
    ex.asyncify_start_rewind(proc.slotAddr(idx));
    s.runnable.push(proc);
  } else if (r === 'longjmp') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    const idx = dv.getInt32(c.ljEnv, true), hw = dv.getUint32(c.ljEnv + 8, true);
    dv.setInt32(c.ljEnv + 4, c.ljVal, true);
    dv.setUint32(proc.slotAddr(idx), hw, true);
    c.rewinding = true;
    ex.asyncify_start_rewind(proc.slotAddr(idx));
    s.runnable.push(proc);
  } else if (r === 'fork') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    doFork(s, proc);
  } else if (r === 'waitpid') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    doWait(s, proc);
  } else if (r === 'blockread') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    const target = blockTarget(s, proc, c.pipeReq.fd);
    if (!target) {  // fd closed under us: deliver EOF
      proc.pendingRead = { ptr: c.pipeReq.ptr, bytes: new Uint8Array(0), nreadPtr: c.pipeReq.nreadPtr, isPoll: c.pipeReq.isPoll, pollUserdata: c.pipeReq.pollUserdata };
      resumeProc(proc);
    } else {
      target.list.push({ proc });
      target.wake();
    }
  } else if (r === 'exec') {
    trackArena(s, proc, proc.MAIN_BUF, MAIN_SIZE, false);
    doExec(s, proc);
  } else {
    throw new Error('bash-runner: unknown unwind reason ' + r);
  }
}

function pumpOne(s) {
  if (!s.runnable.length) return false;
  step(s, s.runnable.shift());
  return true;
}

// exec re-homes the forked child onto a staged plain-WASI coreutil
// bound to the process fd table (M2 exec-into-runner, in-facet). The
// tool's blocking pipe reads synchronously pump the writer procs.
function doExec(s, proc) {
  const name = proc.ctx.execPath.split('/').pop();
  // The child inherits bash's LIVE cwd: bash keeps the exported PWD
  // current across cd, and the execve import threads the child env.
  const env = proc.ctx.execEnv && proc.ctx.execEnv.length ? proc.ctx.execEnv : s.environ;
  const pwdVar = env.find((x) => x.startsWith('PWD='));
  const childCwd = pwdVar ? norm(pwdVar.slice(4)) : s.cwd;
  const path = makeResolve(s, childCwd)(proc.ctx.execPath);
  // Applets dispatch only from the PATH dirs they are staged in — a user
  // file that happens to share an applet's name (./ls) is NOT the applet.
  const viaPath = path.startsWith('bin/') || path.startsWith('usr/bin/');
  const m = viaPath ? s.coreutils.get(name) : null;
  if (!m) {
    // wasi-libc errno numbering: EACCES=2, ENOENT=44, ENOEXEC=45. An
    // existing non-wasm file gets ENOEXEC so bash falls back to running
    // it as a shell script (execute_disk_command's ENOEXEC path); an
    // unreadable one gets EACCES.
    proc.ctx.resume = fileLookup(s, path) ? -45 : (fileExists(s, path) ? -2 : -44);
    proc.ctx.rewinding = true;
    proc.inst.exports.asyncify_start_rewind(proc.MAIN_BUF);
    s.runnable.push(proc);
    return;
  }
  let inst2;
  const DV = () => new DataView(inst2.exports.memory.buffer);
  const U8 = () => new Uint8Array(inst2.exports.memory.buffer);
  const tv = proc.ctx.execArgv;
  // Absolute argv paths (leading '/'), normalized to root-relative keys.
  // These recover the absolute-vs-relative bit the tool's wasi-libc drops
  // (see makeResolve): a path under one of these is never re-anchored.
  const absRoots = new Set();
  for (let i = 1; i < tv.length; i++) if (tv[i].startsWith('/')) absRoots.add(norm(tv[i]));
  const wstr = (p, str) => { const b = te.encode(str); U8().set(b, p); return b.length; };
  let code = 0;
  const io = {
    read: (fd, iovs, nread) => {
      const dv = DV();
      const p = dv.getUint32(iovs, true), l = dv.getUint32(iovs + 4, true);
      for (;;) {
        const sync = tryReadFd(s, proc, fd, dv, U8(), p, l, nread);
        if (sync) return sync.errno;
        // Would block: pump the scheduler so writer procs make progress.
        // When nothing is runnable the source can't produce more
        // synchronously (interactive stdin mid-exec) — deliver EOF.
        if (!pumpOne(s)) { dv.setUint32(nread, 0, true); return 0; }
      }
    },
    write: (fd, bytes) => writeThroughFd(s, proc, fd, bytes),
    poll: (_i, _o, _n, retPtr) => { DV().setUint32(retPtr, 0, true); return 0; },
  };
  const base = makeWasiFs(s, proc, DV, U8, io, childCwd, absRoots);
  const w = {
    ...base,
    args_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, tv.length, true); dv.setUint32(b, tv.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    args_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const a of tv) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, a); U8()[p++] = 0; } return 0; },
    // POSIX environment inheritance: the child env bash passed to execve.
    environ_sizes_get: (a, b) => { const dv = DV(); dv.setUint32(a, env.length, true); dv.setUint32(b, env.reduce((x, v) => x + te.encode(v).length + 1, 0), true); return 0; },
    environ_get: (ptrs, buf) => { const dv = DV(); let p = buf; for (const v of env) { dv.setUint32(ptrs, p, true); ptrs += 4; p += wstr(p, v); U8()[p++] = 0; } return 0; },
    proc_exit: (ec) => { code = ec; throw new Exit(ec); },
  };
  const wp = new Proxy(w, { get: (t, k) => (k in t ? t[k] : (() => 0)) });
  // nimbus_proc.chmod: WASI preview1 has no mode syscall, so busybox's
  // chmod threads through this import. In-facet the effective-mode table
  // updates immediately (chmod +x → ./script runs); the durable, S2a
  // ownership-checked chmod happens at fsDiff flush.
  const chmodResolve = makeResolve(s, childCwd, absRoots);
  const nimbus_proc = {
    chmod: (pathPtr, pathLen, mode) => {
      const p = chmodResolve(td.decode(U8().subarray(pathPtr, pathPtr + pathLen)));
      const trav = checkTraversal(s, p);
      if (trav) return trav;
      if (!inodeExists(s, p) && !(p !== '' && isDir(s, p))) return E.NOENT;
      const bits = mode & 0o777;
      s.fs.modes.set(p, (bits >> 6) & 7);
      s.fs.modesChanged.set(p, bits);
      return 0;
    },
  };
  inst2 = new WebAssembly.Instance(m, { wasi_snapshot_preview1: wp, nimbus_proc });
  s.stats.instances++;
  const mem2 = inst2.exports.memory.buffer.byteLength;
  if (mem2 > s.stats.memPeak) s.stats.memPeak = mem2;
  try { inst2.exports._start(); }
  catch (e) { if (e instanceof Exit) code = e.code; else throw e; }
  finishProc(s, proc, code);
}

function doFork(s, parent) {
  const childPid = s.pidNext++;
  const childFds = new Map();
  for (const [fd, e] of parent.fds) { childFds.set(fd, { ...e }); if (e.kind === 'pipe') bumpPipe(s, e, 1); }
  const child = makeProc(s, childPid, parent.pid, childFds);
  const pmem = parent.inst.exports.memory, cmem = child.inst.exports.memory;
  if (cmem.buffer.byteLength < pmem.buffer.byteLength) cmem.grow((pmem.buffer.byteLength - cmem.buffer.byteLength) / PAGE);
  new Uint8Array(cmem.buffer).set(new Uint8Array(pmem.buffer));
  for (const [k, v] of Object.entries(parent.inst.exports)) if (v instanceof WebAssembly.Global) child.inst.exports[k].value = v.value;
  child.MAIN_BUF = parent.MAIN_BUF; child.SLOT0 = parent.SLOT0;
  child.ctx.nextSlot = parent.ctx.nextSlot;
  child.slotByEnv = new Map(parent.slotByEnv);
  child.freeSlots = parent.freeSlots.slice();
  const total = s.procs.size;
  if (total * cmem.buffer.byteLength > s.stats.memPeak) s.stats.memPeak = total * cmem.buffer.byteLength;
  child.ctx.resume = 0; child.ctx.rewinding = true;
  child.inst.exports.asyncify_start_rewind(child.MAIN_BUF);
  s.runnable.push(child);
  parent.ctx.resume = childPid; parent.ctx.rewinding = true;
  parent.inst.exports.asyncify_start_rewind(parent.MAIN_BUF);
  s.runnable.push(parent);
}

function doWait(s, proc) {
  const t = proc.ctx.waitTarget;
  let pid = null;
  if (t > 0) { if (s.exitStatus.has(t)) pid = t; }
  else { for (const [p] of s.exitStatus) { pid = p; break; } }
  if (pid != null) {
    const st = s.exitStatus.get(pid); s.exitStatus.delete(pid);
    proc.ctx.resume = pid; proc.ctx.resumeStatus = st;
    resumeProc(proc);
  } else {
    s.waiters.push({ proc, targetPid: t });
  }
}

function finishProc(s, proc, code) {
  const st = (code & 0xff) << 8;
  s.procs.delete(proc.pid);
  for (const fd of [...proc.fds.keys()]) closeFd(s, proc, fd);
  if (proc.ppid === 0) s.rootExit = code;
  s.exitStatus.set(proc.pid, st);
  for (let i = 0; i < s.waiters.length; i++) {
    const w = s.waiters[i];
    if (w.targetPid === proc.pid || w.targetPid <= 0) {
      s.waiters.splice(i, 1);
      w.proc.ctx.resume = proc.pid; w.proc.ctx.resumeStatus = st;
      s.exitStatus.delete(proc.pid);
      resumeProc(w.proc);
      break;
    }
  }
}

function composeFsDiff(s) {
  const filesWritten = {};
  for (const path of s.fs.written) {
    if (path.startsWith('etc/nimbus.bashrc')) continue;
    const f = s.fs.files.get(path);
    if (f) filesWritten[path] = bytesToB64(f.bytes);
  }
  return {
    filesWritten,
    filesDeleted: [...s.fs.deleted],
    dirsCreated: [...s.fs.dirsCreated],
    // Deepest-first so the flush rmdirs children before their parents.
    dirsDeleted: [...s.fs.dirsDeleted].sort((a, b) => b.length - a.length),
    modesChanged: Object.fromEntries(s.fs.modesChanged),
  };
}

function pump(s) {
  try {
    while (s.runnable.length) {
      if (++s.steps > 5_000_000) throw new Error('bash-runner: runaway scheduler (>5M steps)');
      step(s, s.runnable.shift());
      if (s.rootExit !== null) break;
    }
  } catch (e) {
    s.error = String(e && e.stack || e && e.message || e);
  }
  const out = s.out, err = s.err;
  s.out = ''; s.err = '';
  const stats = { ...s.stats, steps: s.steps, missingWasi: [...s.missingWasi] };
  if (s.error) {
    S = null;
    return { state: 'error', exitCode: 1, stdout: out, stderr: err, error: s.error, stats };
  }
  if (s.rootExit !== null || s.procs.size === 0) {
    const code = s.rootExit === null ? 0 : s.rootExit;
    const fsDiff = composeFsDiff(s);
    S = null;
    return { state: 'exited', exitCode: code, stdout: out, stderr: err, fsDiff, stats };
  }
  if (s.stdin.waiters.length > 0) {
    return { state: 'need-input', exitCode: 0, stdout: out, stderr: err, stats };
  }
  S = null;
  return { state: 'error', exitCode: 1, stdout: out, stderr: err, error: 'bash-runner: deadlock — live procs with empty run queue', stats };
}

globalThis.__bashBoot = function __bashBoot(args) {
  try {
    S = newSession(args);
    initStdinQueued(S);
    const root = makeProc(S, S.pidNext++, 0, new Map([
      [0, { kind: 'stdin' }], [1, { kind: 'stdout' }], [2, { kind: 'stderr' }],
      [3, { kind: 'preopen' }],
    ]));
    S.rootPid = root.pid;
    setupArena(root);
    S.runnable.push(root);
    return pump(S);
  } catch (e) {
    S = null;
    return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'boot failed: ' + String(e && e.message || e) };
  }
};

globalThis.__bashFeed = function __bashFeed(args) {
  if (!S) {
    return { state: 'error', exitCode: 1, stdout: '', stderr: '', error: 'bash facet has no active session (warm isolate recycled?)' };
  }
  try {
    if (args.data) { const b = te.encode(args.data); S.stdin.chunks.push(b); S.stdin.queued += b.length; }
    if (args.eof) S.stdin.closed = true;
    wakeStdin(S);
    return pump(S);
  } catch (e) {
    const s = S; S = null;
    return { state: 'error', exitCode: 1, stdout: s ? s.out : '', stderr: s ? s.err : '', error: 'feed failed: ' + String(e && e.message || e) };
  }
};
})();
// ── END: bash-runner preamble ──
`;
