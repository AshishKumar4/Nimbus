/**
 * git-commands.ts — Nimbus v2.0 Git integration via isomorphic-git.
 *
 * Provides a full `git` command with subcommands:
 * init, clone, status, add, commit, log, branch, checkout, diff,
 * ls-files, rev-parse, remote, fetch, pull, push, merge, reset, tag
 *
 * Uses a VFS→isomorphic-git FS adapter that maps all operations
 * to the SqliteVFS.
 */

import type { CredentialedVfs, SqliteVFS, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { requireVfsCred, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { execGitNetwork } from './network-facet.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { dec, enc } from '@nimbus-sh/core/_shared/bytes.js';
import {
  DEFAULT_CONTEXT,
  absentSpec,
  bytesFromBinary,
  formatNameOnly,
  formatNameStatus,
  formatPatch,
  formatStat,
  pathLine,
  statFile,
  type DiffPair,
  type DiffSpec,
  type StatFile,
} from './unified-diff.js';

// ── Lazy-loaded isomorphic-git (avoid ~1MB load on every cold start) ────
// NOTE: local git ops (init, status, add, commit, log, branch, checkout,
// diff, ls-files, rev-parse, remote, merge, reset, tag, config) run here in the supervisor DO.
// Network ops (clone, fetch, pull) are delegated to the git-network-facet
// because the supervisor's CPU budget cannot handle packfile processing
// for real-world repos (>100 files).
let _git: any = null;
async function getGit() {
  if (!_git) {
    // @ts-ignore — CF-compatible fork (github:AshishKumar4/cf-git)
    _git = await import('isomorphic-git');
  }
  return _git;
}

// ── VFS→isomorphic-git FS adapter ───────────────────────────────────────

/**
 * `fs.promises.readFile` takes its encoding either bare or on an options
 * object, and cf-git uses both spellings — `fs.read(path, 'utf8')` for
 * .gitignore, .git/info/exclude and the stash reflog, the object form
 * everywhere else. An adapter that honours only the object form hands
 * those call sites bytes where they asked for text, and cf-git feeds the
 * result straight to `ignore().add()`, which silently accepts only
 * strings — so every .gitignore rule became a no-op.
 */
function wantsUtf8(options: unknown): boolean {
  const encoding = typeof options === 'string'
    ? options
    : (options as { encoding?: unknown } | null | undefined)?.encoding;
  return encoding === 'utf8' || encoding === 'utf-8';
}

/**
 * Creates an isomorphic-git compatible `fs` object from SqliteVFS.
 * isomorphic-git requires: readFile, writeFile, unlink, readdir,
 * mkdir, rmdir, stat, lstat (all as promises).
 */
function createGitFs(vfs: CredentialedVfs) {
  // Path normalization is shared with esbuild-service via ./vfs-path.ts.
  // isomorphic-git constructs paths like `dir + '/' + filepath` which can
  // produce `/home/user/project/.` or paths with `..` segments — those are
  // collapsed before VFS lookup. The bounded `..` pop won't escape root.
  const normalizePath = normalizeVfsPath;

  function ensureParent(p: string) {
    const parts = normalizePath(p).split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dir && !vfs.exists(dir)) vfs.mkdir(dir, { recursive: true });
    }
  }

  return {
    promises: {
      async readFile(filepath: string, opts?: any): Promise<Uint8Array | string> {
        const p = normalizePath(filepath);
        let data: Uint8Array;
        try { data = vfs.readFile(p); }
        catch {
          const err: any = new Error(`ENOENT: no such file or directory, open '${filepath}'`);
          err.code = 'ENOENT'; err.errno = -2;
          throw err;
        }
        if (wantsUtf8(opts)) return dec.decode(data);
        return data;
      },
      async writeFile(filepath: string, data: any, opts?: any): Promise<void> {
        const p = normalizePath(filepath);
        ensureParent(p);
        if (typeof data === 'string') {
          vfs.writeFile(p, data);
        } else {
          vfs.writeFile(p, data instanceof Uint8Array ? data : new Uint8Array(data));
        }
      },
      async unlink(filepath: string): Promise<void> {
        const p = normalizePath(filepath);
        if (vfs.exists(p)) vfs.unlink(p);
      },
      async readdir(filepath: string): Promise<string[]> {
        const p = normalizePath(filepath);
        if (!p) return []; // root level — not typically needed by isomorphic-git
        if (!vfs.exists(p)) return [];
        return vfs.readdir(p).map(e => e.name);
      },
      async mkdir(filepath: string, opts?: any): Promise<void> {
        const p = normalizePath(filepath);
        if (!vfs.exists(p)) vfs.mkdir(p, { recursive: true });
      },
      async rmdir(filepath: string): Promise<void> {
        const p = normalizePath(filepath);
        if (vfs.exists(p)) vfs.rmdir(p);
      },
      async stat(filepath: string): Promise<any> {
        const p = normalizePath(filepath);
        // Synthetic directory stat — used for root, '.', and known directories
        function dirStat() {
          const now = Date.now();
          const d = new Date(now);
          return {
            isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false,
            size: 0, mode: 0o755, type: 'dir',
            mtimeMs: now, mtime: d, ctimeMs: now, ctime: d, atimeMs: now, atime: d,
            uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
          };
        }
        // Empty path (from '.', '/', etc.) = root directory
        if (!p) return dirStat();
        // Check if path is a known directory (even without VFS stat entry)
        if (vfs.exists(p) && vfs.isDirectory(p)) return dirStat();
        let st: any;
        try { st = vfs.stat(p); }
        catch {
          const err: any = new Error(`ENOENT: no such file or directory, stat '${filepath}'`);
          err.code = 'ENOENT'; err.errno = -2;
          throw err;
        }
        // isomorphic-git calls .valueOf() on mtime/ctime/atime — all must be Date objects
        const mtimeMs = st.mtime || Date.now();
        const mtime = new Date(mtimeMs);
        return {
          isFile: () => st.type === 'file',
          isDirectory: () => st.type === 'directory',
          isSymbolicLink: () => false,
          size: st.size,
          mode: st.mode || 0o644,
          mtimeMs,
          mtime,
          ctimeMs: mtimeMs,
          ctime: mtime,
          atimeMs: mtimeMs,
          atime: mtime,
          uid: 1000,
          gid: 1000,
          dev: 0,
          ino: 0,
          nlink: 1,
          type: st.type === 'directory' ? 'dir' : 'file',
        };
      },
      async lstat(filepath: string): Promise<any> {
        return this.stat(filepath);
      },
      async chmod(): Promise<void> { /* no-op */ },
      async symlink(): Promise<void> { /* no-op */ },
      async readlink(filepath: string): Promise<string> { return filepath; },
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

type OutputStream = {
  write(s: string): void | Promise<void>;
  /** Present on sinks that keep bytes verbatim (files, byte-capable pipes). */
  writeBytes?(bytes: Uint8Array): void | Promise<void>;
};

type Ctx = {
  pid: number;
  cred: VfsCred;
  args: string[];
  stdout: OutputStream;
  stderr: OutputStream;
  cwd: string;
  env: Record<string, string>;
};

function getDir(ctx: Ctx): string {
  return '/' + (ctx.cwd || '/home/user').replace(/^\/+/, '');
}

export interface ParsedGitGlobals {
  sub: string | undefined;
  subArgs: string[];
  /** The directory the subcommand runs in, after every `-C`. */
  dir: string;
}

/**
 * The options git accepts BEFORE the subcommand. `-C <path>` runs the
 * command as if started from <path>; repeated, each is relative to the
 * previous (`git -C a -C b` runs in `a/b`). `--no-pager` and `-P` are
 * accepted and mean nothing here, there is no pager. Any other leading
 * option is refused: swallowing it would run the next word as a subcommand.
 */
export function parseGitGlobals(args: string[], cwd: string): ParsedGitGlobals {
  let dir = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-C') {
      const path = args[++i];
      if (path === undefined) throw new Error("option '-C' requires a value");
      dir = path.startsWith('/') ? path : dir + '/' + path;
      dir = '/' + dir.split('/').filter((seg) => seg && seg !== '.').join('/');
    } else if (arg.startsWith('-C') && arg.length > 2) {
      const path = arg.slice(2);
      dir = path.startsWith('/') ? path : dir + '/' + path;
      dir = '/' + dir.split('/').filter((seg) => seg && seg !== '.').join('/');
    } else if (arg === '--no-pager' || arg === '-P') {
      // no pager to disable
    } else if (arg.startsWith('-') && arg !== '--version' && arg !== '-v' && arg !== '--help' && arg !== '-h') {
      throw new Error(`unknown option '${arg}'\nusage: git [-C <path>] [--no-pager] <command> [<args>]`);
    } else {
      break;
    }
  }
  return { sub: args[i], subArgs: args.slice(i + 1), dir };
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0) return args[idx + 1] || undefined;
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || undefined;
}

export interface ParsedCloneArgs {
  url: string | undefined;
  dest: string | undefined;
  depth: number | undefined;
  noShallow: boolean;
  isBg: boolean;
  branch: string | undefined;
  /** `-q`/`--quiet`: no progress on stdout; errors still reach stderr. */
  quiet: boolean;
}

export const CLONE_USAGE =
  'usage: git clone [-q | --quiet] [--depth <n>] [--no-shallow] [--branch <name> | -b <name>] [--bg] <url> [dir]';

/**
 * Every flag is either handled or refused loudly. Silently skipping unknown
 * flags corrupted positionals for value-taking ones (`--branch dev URL`
 * parsed `dev` as the URL) and silently no-opped `--filter=blob:none` — a
 * "blobless" clone that was not blobless.
 */
export function parseCloneArgs(args: string[]): ParsedCloneArgs {
  let depthFlag: string | undefined;
  let branch: string | undefined;
  let noShallow = false;
  let isBg = false;
  let quiet = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const takeValue = (): string => {
      if (eq > 0) return arg.slice(eq + 1);
      const value = args[++i];
      if (value === undefined) {
        throw new Error(`option '${name}' requires a value\n${CLONE_USAGE}`);
      }
      return value;
    };
    if (name === '--depth') depthFlag = takeValue();
    else if (name === '--branch' || name === '-b') branch = takeValue();
    else if (arg === '--no-shallow') noShallow = true;
    else if (arg === '--bg' || arg === '&') isBg = true;
    else if (arg === '-q' || arg === '--quiet') quiet = true;
    // Progress is already the default; there is no more of it to ask for.
    else if (arg === '-v' || arg === '--verbose') { /* accepted */ }
    else if (name === '--filter') {
      throw new Error(
        "clone does not support '--filter': the bundled isomorphic-git has no " +
        'partial-clone support, so a filter would silently download every object. ' +
        'Use --depth <n> to bound history instead.',
      );
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option '${arg}'\n${CLONE_USAGE}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    url: positionals[0],
    dest: positionals[1],
    depth: depthFlag ? parseInt(depthFlag) || 1 : (noShallow ? undefined : 1),
    noShallow,
    isBg,
    branch,
    quiet,
  };
}

function getAuthor(ctx: Ctx) {
  return {
    name: ctx.env.GIT_AUTHOR_NAME || ctx.env.USER || 'user',
    email: ctx.env.GIT_AUTHOR_EMAIL || 'user@nimbus.dev',
  };
}

/** fetch, pull and push: `-q`/`--quiet` wherever it appears; the other words keep their order. */
function takeQuiet(args: readonly string[]): { quiet: boolean; rest: string[] } {
  const rest = args.filter((arg) => arg !== '-q' && arg !== '--quiet');
  return { quiet: rest.length !== args.length, rest };
}

/** commit's -m (repeatable), -q and -a, bundled as git allows (`-qm msg`, `-mmsg`); other options stay ignored. */
function parseCommitArgs(args: readonly string[]): { messages: string[]; quiet: boolean; all: boolean } {
  const messages: string[] = [];
  let quiet = false;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === '--quiet') quiet = true;
    else if (arg === '--all') all = true;
    else if (arg === '--message') messages.push(args[++i] ?? '');
    else if (arg.startsWith('--message=')) messages.push(arg.slice('--message='.length));
    else if (/^-[^-]/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === 'q') quiet = true;
        else if (arg[j] === 'a') all = true;
        else if (arg[j] === 'm') {
          messages.push(j + 1 < arg.length ? arg.slice(j + 1) : args[++i] ?? '');
          break;
        }
      }
    }
  }
  return { messages, quiet, all };
}

// ── The cf-git surface below ─────────────────────────────────────────────

/** isomorphic-git's WalkerEntry: one tree's view of one path. */
interface WalkerEntry {
  type(): Promise<'tree' | 'blob' | 'special' | 'commit'>;
  mode(): Promise<number>;
  oid(): Promise<string>;
}

/** An opaque TREE/STAGE/WORKDIR walker handle. */
type Walker = object;

/** The cf-git calls staging and worktree inspection make; `git` itself is loaded untyped. */
interface CfGit {
  // parallel: false (through the tracked cf-git patch) adds an array's paths one at a time.
  add(args: { fs: unknown; dir: string; filepath: string | string[]; parallel?: boolean; cache?: object }): Promise<void>;
  // Takes an array through the tracked cf-git patch, as add does.
  remove(args: { fs: unknown; dir: string; filepath: string | string[]; cache?: object }): Promise<void>;
  statusMatrix(args: { fs: unknown; dir: string; cache?: object }): Promise<[string, number, number, number][]>;
  walk(args: {
    fs: unknown;
    dir: string;
    cache: object;
    trees: Walker[];
    map(path: string, entries: (WalkerEntry | null)[]): Promise<unknown>;
    reduce(parent: unknown, children: unknown[]): Promise<unknown>;
    iterate(walk: (child: unknown) => Promise<unknown>, children: Iterable<unknown>): Promise<unknown[]>;
  }): Promise<unknown>;
  TREE(args: { ref: string }): Walker;
  STAGE(): Walker;
  WORKDIR(): Walker;
  isIgnored(args: { fs: unknown; dir: string; filepath: string }): Promise<boolean>;
  readBlob(args: { fs: unknown; dir: string; oid: string; cache: object }): Promise<{ blob: Uint8Array }>;
  hashBlob(args: { object: Uint8Array }): Promise<{ oid: string }>;
  resolveRef(args: { fs: unknown; gitdir: string; ref: string }): Promise<string>;
  expandOid(args: { fs: unknown; gitdir: string; oid: string; cache: object }): Promise<string>;
  expandRef(args: { fs: unknown; gitdir: string; ref: string }): Promise<string>;
  currentBranch(args: { fs: unknown; gitdir: string }): Promise<string | undefined>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'NotFoundError';
}

// ── Output ───────────────────────────────────────────────────────────────

/** Emit a binary string: its bytes verbatim where the sink keeps bytes, else as UTF-8 text. */
async function writeBinary(stream: OutputStream, bin: string): Promise<void> {
  if (!bin) return;
  const bytes = bytesFromBinary(bin);
  if (stream.writeBytes) await stream.writeBytes(bytes);
  else await stream.write(dec.decode(bytes));
}

// ── Staging ──────────────────────────────────────────────────────────────

/** `git add -A` under one index write, a path at a time: 1,000 concurrent deflates reset the isolate. */
async function stageAll(git: CfGit, fs: unknown, dir: string, trackedOnly: boolean): Promise<void> {
  const cache = {};
  const added: string[] = [];
  const removed: string[] = [];
  for (const [filepath, head, workdir, stage] of await git.statusMatrix({ fs, dir, cache })) {
    if (trackedOnly && stage === 0) continue;
    if (head === workdir && workdir === stage) continue;
    if (workdir === 0) removed.push(filepath);
    else added.push(filepath);
  }
  if (removed.length) await git.remove({ fs, dir, filepath: removed, cache });
  if (added.length) await git.add({ fs, dir, filepath: added, parallel: false, cache });
}

// ── Repository discovery ─────────────────────────────────────────────────

const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git\n';
const NOT_A_WORK_TREE = 'fatal: this operation must be run in a work tree\n';

interface GitRepo {
  gitdir: string;
  /** The working tree's top, or null when the cwd is inside the git directory. */
  worktree: string | null;
  /** The cwd below the worktree (or the git directory), '' at its top. */
  prefix: string;
}

/** setup_git_directory's walk: from the cwd up, a `.git` inside each level, else the level itself as a git directory. */
function discoverRepo(vfs: CredentialedVfs, cwd: string): GitRepo | null {
  const isGitDir = (key: string) => {
    const sub = (name: string) => (key ? `${key}/${name}` : name);
    return vfs.isFile(sub('HEAD')) && vfs.isDirectory(sub('objects')) && vfs.isDirectory(sub('refs'));
  };
  const segments = normalizeVfsPath(cwd).split('/').filter(Boolean);
  for (let depth = segments.length; depth >= 0; depth--) {
    const dir = segments.slice(0, depth).join('/');
    const prefix = segments.slice(depth).join('/');
    const dotGit = dir ? `${dir}/.git` : '.git';
    if (isGitDir(dotGit)) return { gitdir: `/${dotGit}`, worktree: `/${dir}`, prefix };
    if (isGitDir(dir)) return { gitdir: `/${dir}`, worktree: null, prefix };
  }
  return null;
}

function ambiguousArgument(arg: string): string {
  return `fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.\n`
    + "Use '--' to separate paths from revisions, like this:\n"
    + "'git <command> [<revision>...] -- [<file>...]'\n";
}

/** A revision as rev-parse reads one: a ref, or a full or uniquely abbreviated object name. */
async function resolveRevision(git: CfGit, fs: unknown, gitdir: string, rev: string, cache: object): Promise<string | null> {
  const name = rev === '@' ? 'HEAD' : rev;
  if (/[~^:{}\\]|\.\.|^@/.test(name)) throw new Error(`unsupported revision syntax '${rev}'`);
  try {
    return await git.resolveRef({ fs, gitdir, ref: name });
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  if (!/^[0-9a-f]{4,39}$/.test(name)) return null;
  try {
    return await git.expandOid({ fs, gitdir, oid: name, cache });
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return null;
  }
}

/** --abbrev-ref: the short name of the ref a revision spells, null when it spells none. */
async function abbreviatedRef(git: CfGit, fs: unknown, gitdir: string, rev: string): Promise<string | null> {
  if (rev === 'HEAD' || rev === '@') return (await git.currentBranch({ fs, gitdir })) ?? 'HEAD';
  try {
    const full = await git.expandRef({ fs, gitdir, ref: rev });
    return full.replace(/^refs\/remotes\/(.+)\/HEAD$/, '$1').replace(/^refs\/(?:heads|tags|remotes)\//, '');
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return null;
  }
}

async function revParse(ctx: Ctx, git: CfGit, fs: unknown, vfs: CredentialedVfs, args: readonly string[]): Promise<number> {
  const repo = discoverRepo(vfs, ctx.cwd);
  if (!repo) {
    await ctx.stderr.write(NOT_A_REPOSITORY);
    return 128;
  }
  const cache = {};
  let verify = false;
  let quiet = false;
  let abbrevRef = false;
  let out = '';
  const verified: { rev: string; oid: string }[] = [];
  const show = async (rev: string, oid: string) => {
    if (!abbrevRef) return `${oid}\n`;
    const name = await abbreviatedRef(git, fs, repo.gitdir, rev);
    return name === null ? '' : `${name}\n`;
  };
  const fail = async (message: string, code: number) => {
    if (out) await ctx.stdout.write(out);
    if (message) await ctx.stderr.write(message);
    return code;
  };
  const noSingleRevision = () => (quiet ? fail('', 1) : fail('fatal: Needed a single revision\n', 128));
  for (const arg of args) {
    switch (arg) {
      case '--verify': verify = true; continue;
      case '-q': case '--quiet': quiet = true; continue;
      case '--abbrev-ref': abbrevRef = true; continue;
      case '--show-toplevel':
        if (!repo.worktree) return fail(NOT_A_WORK_TREE, 128);
        out += `${repo.worktree}\n`;
        continue;
      case '--git-dir':
        // rev-parse names the git directory relative to the cwd only from the top.
        out += `${repo.prefix ? repo.gitdir : repo.worktree ? '.git' : '.'}\n`;
        continue;
      case '--is-inside-work-tree':
        out += `${repo.worktree ? 'true' : 'false'}\n`;
        continue;
    }
    if (arg.startsWith('-')) return fail(`fatal: rev-parse: unsupported option '${arg}'\n`, 129);
    const oid = await resolveRevision(git, fs, repo.gitdir, arg, cache);
    if (oid === null) {
      if (verify) return noSingleRevision();
      // A non-revision is echoed as a path, which must then exist.
      out += `${arg}\n`;
      if (vfs.exists(normalizeVfsPath(arg.startsWith('/') ? arg : `${ctx.cwd}/${arg}`))) continue;
      return fail(ambiguousArgument(arg), 128);
    }
    if (verify) verified.push({ rev: arg, oid });
    else out += await show(arg, oid);
  }
  if (verify) {
    if (verified.length !== 1) return noSingleRevision();
    out += await show(verified[0].rev, verified[0].oid);
  }
  await ctx.stdout.write(out);
  return 0;
}

// ── Worktree inspection (ls-files, diff) ─────────────────────────────────

/** git's index and tree order: the UTF-8 bytes, which is code point order rather than UTF-16's. */
function comparePaths(a: string, b: string): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (astral code points) sort above the rest of the BMP.
    if (x >= 0xd800) x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
    if (y >= 0xd800) y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    return x - y;
  }
  return a.length - b.length;
}

/** A repo-relative path as seen from `prefix`, climbing with '../' where it must. */
function relativeTo(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1);
  const from = prefix.split('/');
  const to = path.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return '../'.repeat(from.length - shared) + to.slice(shared).join('/');
}

/** Literal pathspecs, relative to the cwd, as repo-relative paths; '' is the whole tree. */
function repoPaths(args: readonly string[], cwd: string, worktree: string): string[] {
  const root = normalizeVfsPath(worktree);
  return args.map((arg) => {
    if (/[*?[]/.test(arg)) throw new Error(`pathspec '${arg}': globs are not supported, name the paths`);
    const key = normalizeVfsPath(arg.startsWith('/') ? arg : `${cwd}/${arg}`);
    if (!root || key === root) return root ? '' : key;
    if (key.startsWith(`${root}/`)) return key.slice(root.length + 1);
    throw new Error(`${arg}: '${arg}' is outside repository at '${worktree}'`);
  });
}

/** cf-git's walk one entry at a time, not every sibling at once; `visit` answers whether to descend. */
async function walkScoped(
  git: CfGit,
  fs: unknown,
  dir: string,
  cache: object,
  trees: Walker[],
  specs: readonly string[],
  visit: (path: string, entries: (WalkerEntry | null)[]) => Promise<boolean>,
): Promise<void> {
  await git.walk({
    fs, dir, cache, trees,
    map: async (path: string, entries: (WalkerEntry | null)[]) => {
      if (path === '.') return true;
      const inScope = specs.length === 0
        || specs.some((spec) => spec === '' || path === spec || path.startsWith(`${spec}/`));
      // Outside the pathspecs a directory is entered only on the way to one.
      if (!inScope) return specs.some((spec) => spec.startsWith(`${path}/`)) ? true : null;
      return (await visit(path, entries)) ? true : null;
    },
    reduce: async () => undefined,
    iterate: async (walk: (child: unknown) => Promise<unknown>, children: Iterable<unknown>) => {
      for (const child of children) await walk(child);
      return [];
    },
  });
}

const LS_FILES_USAGE = 'usage: git ls-files [-c | --cached] [-o | --others] [-m | --modified] [-d | --deleted] '
  + '[--exclude-standard] [-z] [--] [<path>...]\n';

async function lsFiles(ctx: Ctx, git: CfGit, fs: unknown, vfs: CredentialedVfs, args: readonly string[]): Promise<number> {
  let cached = false;
  let others = false;
  let modified = false;
  let deleted = false;
  let excludeStandard = false;
  let z = false;
  let dashdash = false;
  const pathArgs: string[] = [];
  for (const arg of args) {
    if (dashdash || arg === '-' || !arg.startsWith('-')) {
      pathArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      dashdash = true;
      continue;
    }
    for (const flag of arg.startsWith('--') ? [arg] : [...arg.slice(1)].map((c) => `-${c}`)) {
      switch (flag) {
        case '-c': case '--cached': cached = true; break;
        case '-o': case '--others': others = true; break;
        case '-m': case '--modified': modified = true; break;
        case '-d': case '--deleted': deleted = true; break;
        case '-z': z = true; break;
        case '--exclude-standard': excludeStandard = true; break;
        default:
          await ctx.stderr.write(`error: unknown option '${flag.replace(/^-+/, '')}'\n${LS_FILES_USAGE}`);
          return 129;
      }
    }
  }
  // With no selection ls-files shows the index.
  if (!others && !modified && !deleted) cached = true;
  const repo = discoverRepo(vfs, ctx.cwd);
  if (!repo) {
    await ctx.stderr.write(NOT_A_REPOSITORY);
    return 128;
  }
  const root = repo.worktree;
  if (!root) {
    await ctx.stderr.write(NOT_A_WORK_TREE);
    return 128;
  }
  // Without pathspecs ls-files covers the cwd's subtree.
  const specs = pathArgs.length ? repoPaths(pathArgs, ctx.cwd, root) : [repo.prefix];
  const readWorktree = others || modified || deleted;
  const untracked: string[] = [];
  const tracked: { path: string; deleted: boolean; modified: boolean }[] = [];
  const trees = readWorktree ? [git.STAGE(), git.WORKDIR()] : [git.STAGE()];
  await walkScoped(git, fs, root, {}, trees, specs, async (path, [stage, work]) => {
    const workType = work ? await work.type() : undefined;
    if (stage) {
      const stageType = await stage.type();
      if (stageType === 'tree') return true;
      const missing = readWorktree && !workType;
      let changed = missing;
      if (modified && !missing && stageType === 'blob') {
        changed = !work || workType !== 'blob'
          || await work.mode() !== await stage.mode() || await work.oid() !== await stage.oid();
      }
      tracked.push({ path, deleted: missing, modified: changed });
      // A file replaced by a directory leaves that directory untracked.
      return others && stageType === 'blob' && workType === 'tree';
    }
    if (!others || !workType) return false;
    const isDir = workType === 'tree';
    if (excludeStandard && await git.isIgnored({ fs, dir: root, filepath: isDir ? `${path}/` : path })) return false;
    if (!isDir) {
      untracked.push(path);
      return false;
    }
    // A nested repository is listed as the directory, never entered.
    if (!vfs.exists(normalizeVfsPath(`${root}/${path}/.git`))) return true;
    untracked.push(`${path}/`);
    return false;
  });
  let out = '';
  for (const path of untracked.sort(comparePaths)) out += pathLine(relativeTo(path, repo.prefix), z);
  for (const entry of tracked.sort((a, b) => comparePaths(a.path, b.path))) {
    const line = pathLine(relativeTo(entry.path, repo.prefix), z);
    if (cached) out += line;
    if (deleted && entry.deleted) out += line;
    if (modified && entry.modified) out += line;
  }
  await writeBinary(ctx.stdout, out);
  return 0;
}

interface PendingSide {
  oid: string;
  mode: number;
  /** Content lives in the worktree rather than the object store. */
  worktree: boolean;
}

interface PendingPair {
  path: string;
  one: PendingSide | null;
  two: PendingSide | null;
}

/** What the worktree (or, `cached`, the index) is compared against. */
type DiffBase = { kind: 'index' } | { kind: 'tree'; ref: string; cached: boolean };

/** diff-files, diff-index and diff-index --cached, as file pairs in path order. */
async function changedPairs(
  git: CfGit,
  fs: unknown,
  dir: string,
  cache: object,
  base: DiffBase,
  specs: readonly string[],
): Promise<PendingPair[]> {
  const pairs: PendingPair[] = [];
  const blob = async (entry: WalkerEntry | null, worktree: boolean): Promise<PendingSide | null> => (
    entry && (await entry.type()) === 'blob' ? { oid: await entry.oid(), mode: await entry.mode(), worktree } : null
  );
  const record = (path: string, one: PendingSide | null, two: PendingSide | null) => {
    if (!one && !two) return;
    if (one && two && one.oid === two.oid && one.mode === two.mode) return;
    pairs.push({ path, one, two });
  };
  const trees = base.kind === 'index'
    ? [git.STAGE(), git.WORKDIR()]
    : base.cached ? [git.TREE({ ref: base.ref }), git.STAGE()] : [git.TREE({ ref: base.ref }), git.STAGE(), git.WORKDIR()];
  await walkScoped(git, fs, dir, cache, trees, specs, async (path, entries) => {
    if (base.kind === 'index') {
      const [stage, work] = entries;
      const stageType = stage ? await stage.type() : undefined;
      if (stageType !== 'blob') return stageType === 'tree';
      // A missing file, or a directory where the file was, is a deletion.
      record(path, await blob(stage, false), await blob(work, true));
      return false;
    }
    const [head, stage, work] = entries;
    const headType = head ? await head.type() : undefined;
    const stageType = stage ? await stage.type() : undefined;
    // diff-index: a path the index lacks is deleted whatever the worktree holds.
    const two = stageType !== 'blob' ? null : base.cached ? await blob(stage, false) : await blob(work, true);
    record(path, await blob(head, false), two);
    return headType === 'tree' || stageType === 'tree';
  });
  return pairs.sort((a, b) => comparePaths(a.path, b.path));
}

type DiffFormat = 'patch' | 'stat' | 'name-only' | 'name-status';

interface DiffOutput {
  format: DiffFormat;
  z: boolean;
  context: number;
  columns: number;
}

/** Print pairs one at a time, each loaded only while it is rendered. */
async function writeDiff(ctx: Ctx, pairs: Iterable<() => Promise<DiffPair>>, output: DiffOutput): Promise<void> {
  const stats: StatFile[] = [];
  let out = '';
  for (const load of pairs) {
    const pair = await load();
    if (output.format === 'stat') stats.push(statFile(pair));
    else if (output.format === 'name-only') out += formatNameOnly(pair, output.z);
    else if (output.format === 'name-status') out += formatNameStatus(pair, output.z);
    else out += formatPatch(pair, output.context);
    if (out.length >= 1 << 16) {
      await writeBinary(ctx.stdout, out);
      out = '';
    }
  }
  if (output.format === 'stat') out += formatStat(stats, output.columns);
  await writeBinary(ctx.stdout, out);
}

/** `git diff --no-index`: two paths, either of them /dev/null; exits 1 when they differ. */
async function diffNoIndex(
  ctx: Ctx,
  git: CfGit,
  vfs: CredentialedVfs,
  paths: string[],
  output: DiffOutput,
): Promise<number> {
  if (paths.length !== 2) {
    await ctx.stderr.write('usage: git diff --no-index [<options>] <path> <path>\n');
    return 129;
  }
  const key = (path: string) => normalizeVfsPath(path.startsWith('/') ? path : `${ctx.cwd}/${path}`);
  const isDir = paths.map((path) => path !== '/dev/null' && vfs.isDirectory(key(path)));
  if (isDir[0] && isDir[1]) {
    await ctx.stderr.write('error: --no-index between two directories is not supported\n');
    return 129;
  }
  // fixup_paths: a directory against a file means that file's namesake inside it.
  if (isDir[0] !== isDir[1]) {
    const dirSide = isDir[0] ? 0 : 1;
    const file = paths[1 - dirSide];
    paths[dirSide] = `${paths[dirSide].replace(/\/+$/, '')}/${file.slice(file.lastIndexOf('/') + 1)}`;
  }
  const specs: DiffSpec[] = [];
  for (const path of paths) {
    if (path === '/dev/null') {
      specs.push(absentSpec(path));
      continue;
    }
    let st: VfsStat;
    try {
      st = vfs.lstat(key(path));
    } catch {
      await ctx.stderr.write(`error: Could not access '${path}'\n`);
      return 1;
    }
    const link = st.type === 'symlink';
    const data = link ? enc.encode(vfs.readlink(key(path))) : vfs.readFile(key(path));
    const { oid } = await git.hashBlob({ object: data });
    // canon_mode: the owner's execute bit alone decides 100755.
    const mode = link ? 0o120000 : st.mode & 0o100 ? 0o100755 : 0o100644;
    specs.push({ path, valid: true, oid, mode, data });
  }
  const [one, two] = specs;
  if (!one.valid && !two.valid) return 0;
  if (one.valid && two.valid && one.oid === two.oid && one.mode === two.mode) return 0;
  await writeDiff(ctx, [async () => ({ one, two })], output);
  return 1;
}

const DIFF_USAGE = 'usage: git diff [--cached] [<commit>] [--] [<path>...]\n'
  + '   or: git diff --no-index [--] <path> <path>\n'
  + 'options: --stat | --name-only | --name-status, -z, -U<n>\n';

async function diffCommand(ctx: Ctx, git: CfGit, fs: unknown, vfs: CredentialedVfs, args: readonly string[]): Promise<number> {
  let cached = false;
  let noIndex = false;
  let dashdash = false;
  const output: DiffOutput = {
    format: 'patch',
    z: false,
    context: DEFAULT_CONTEXT,
    columns: parseInt(ctx.env.COLUMNS ?? '', 10) > 0 ? parseInt(ctx.env.COLUMNS, 10) : 80,
  };
  const positionals: string[] = [];
  const pathArgs: string[] = [];
  for (const arg of args) {
    if (dashdash) {
      pathArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      dashdash = true;
      continue;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const context = /^(?:-U|--unified=)(\d+)$/.exec(arg);
    if (context) {
      output.context = Number(context[1]);
      continue;
    }
    switch (arg) {
      case '--cached': case '--staged': cached = true; continue;
      case '--no-index': noIndex = true; continue;
      case '-z': output.z = true; continue;
      // A patch is the default, and nothing here renames, colors or runs external tools.
      case '-p': case '-u': case '--patch': case '--no-ext-diff': case '--no-renames': case '--no-color': continue;
      case '--stat': case '--name-only': case '--name-status': {
        const format = arg.slice(2) as DiffFormat;
        if (output.format !== 'patch' && output.format !== format) {
          await ctx.stderr.write(`fatal: options '--${output.format}' and '${arg}' cannot be used together\n`);
          return 128;
        }
        output.format = format;
        continue;
      }
    }
    await ctx.stderr.write(`error: unknown option '${arg.replace(/^-+/, '')}'\n${DIFF_USAGE}`);
    return 129;
  }
  if (noIndex) {
    if (cached) {
      await ctx.stderr.write("fatal: options '--cached' and '--no-index' cannot be used together\n");
      return 128;
    }
    return diffNoIndex(ctx, git, vfs, [...positionals, ...pathArgs], output);
  }
  const repo = discoverRepo(vfs, ctx.cwd);
  if (!repo) {
    await ctx.stderr.write(NOT_A_REPOSITORY);
    return 128;
  }
  const root = repo.worktree;
  if (!root) {
    await ctx.stderr.write(NOT_A_WORK_TREE);
    return 128;
  }
  const cache = {};
  const revs: string[] = [];
  for (const arg of positionals) {
    // Before `--` a word is a revision until one is not; then it and the rest must be paths.
    const oid = pathArgs.length && !dashdash ? null : await resolveRevision(git, fs, repo.gitdir, arg, cache);
    if (oid !== null) {
      revs.push(oid);
      continue;
    }
    if (dashdash) {
      await ctx.stderr.write(`fatal: bad revision '${arg}'\n`);
      return 128;
    }
    if (!vfs.exists(normalizeVfsPath(arg.startsWith('/') ? arg : `${ctx.cwd}/${arg}`))) {
      await ctx.stderr.write(ambiguousArgument(arg));
      return 128;
    }
    pathArgs.push(arg);
  }
  if (revs.length > 1) {
    await ctx.stderr.write('fatal: diff between two commits is not supported; compare one commit with the worktree or the index\n');
    return 128;
  }
  const base: DiffBase = cached
    ? { kind: 'tree', ref: revs[0] ?? 'HEAD', cached: true }
    : revs.length ? { kind: 'tree', ref: revs[0], cached: false } : { kind: 'index' };
  const pending = await changedPairs(git, fs, root, cache, base, repoPaths(pathArgs, ctx.cwd, root));
  const withData = output.format === 'patch' || output.format === 'stat';
  const load = async (path: string, pendingSide: PendingSide | null): Promise<DiffSpec> => {
    if (!pendingSide) return absentSpec(path);
    const data = !withData ? new Uint8Array(0)
      : pendingSide.worktree ? vfs.readFile(normalizeVfsPath(`${root}/${path}`))
      : (await git.readBlob({ fs, dir: root, oid: pendingSide.oid, cache })).blob;
    return { path, valid: true, oid: pendingSide.oid, mode: pendingSide.mode, data };
  };
  await writeDiff(ctx, pending.map(({ path, one, two }) => async () => ({
    one: await load(path, one),
    two: await load(path, two),
  })), output);
  return 0;
}

// ── Git subcommand implementations ──────────────────────────────────────

/**
 * The `git` command handler. Split out from registration so it can be
 * lazy-loaded (`await import('./commands.js')`) on first `git` use, keeping
 * this module and its ~106 KB network-facet dependency out of the cold
 * script-eval graph.
 */
export async function runGitCommand(
  ctx: Ctx,
  vfs: SqliteVFS,
  doCtx?: DurableObjectState,
  doEnv?: any,
): Promise<number> {
  const credentialedVfs = vfs.as(requireVfsCred(ctx.cred, 'git'));
  const fs = createGitFs(credentialedVfs);
  let globals: ParsedGitGlobals;
  try {
    globals = parseGitGlobals(ctx.args, getDir(ctx));
  } catch (e: any) {
    ctx.stderr.write(`git: ${e?.message}\n`);
    return 129;
  }
  const { sub, subArgs, dir } = globals;
  // Every subcommand below reads `dir` and the clone's `getDir(ctx)`; `-C`
  // moves both, exactly as `git -C <path>` runs the command from <path>.
  ctx = { ...ctx, cwd: dir };

  if (sub === '--version' || sub === '-v') {
    ctx.stdout.write('git version 2.44.0 (isomorphic-git/cf-git)\n');
    return 0;
  }

  if (!sub || sub === '--help' || sub === '-h') {
    ctx.stdout.write('usage: git <command> [<args>]\n\n');
    ctx.stdout.write('Commands:\n');
    ctx.stdout.write('  init, clone, status, add, commit, log, branch,\n');
    ctx.stdout.write('  checkout, diff, ls-files, rev-parse, remote,\n');
    ctx.stdout.write('  fetch, pull, push, merge, reset, tag, config, --version\n');
    return 0;
  }

  // Lazy-load isomorphic-git only when actually needed.
  // Note: http transport isn't loaded here — network ops (clone/fetch/pull)
  // run inside the git-network-facet which imports its own http transport.
  let git: any;
  try {
    git = await getGit();
  } catch (e: any) {
    ctx.stderr.write(`git: failed to load git module: ${e?.message}\n`);
    return 1;
  }

  try {
    switch (sub) {
      case 'init': {
        // git init [path] — if path given, use it; otherwise use cwd
        let initDir = dir;
        const initPath = subArgs.find((a: string) => !a.startsWith('-'));
        if (initPath) {
          initDir = initPath.startsWith('/') ? initPath : dir + '/' + initPath;
          // Ensure the target directory exists in VFS
          const stripped = initDir.replace(/^\/+/, '');
          if (!credentialedVfs.exists(stripped)) credentialedVfs.mkdir(stripped, { recursive: true });
        }
        await git.init({ fs, dir: initDir });
        if (!subArgs.includes('-q') && !subArgs.includes('--quiet')) {
          ctx.stdout.write(`Initialized empty Git repository in ${initDir}/.git/\n`);
        }
        return 0;
      }

      case 'clone': {
        const { url, dest: destArg, depth, isBg, branch, quiet } = parseCloneArgs(subArgs);
        const progress = quiet ? { write() {} } : ctx.stdout;
        if (!url) { ctx.stderr.write(CLONE_USAGE + '\n'); return 1; }
        // hardening-r5: respect absolute paths. Pre-fix `git clone <url> /tmp/x`
        // resolved to `<cwd>//tmp/x` because the `subArgs[1]` branch
        // unconditionally prepended getDir(ctx). The clone "succeeded" into
        // <cwd>//tmp/x (note double slash) and the user's later `cd /tmp/x`
        // hit ENOENT. Real-world git treats absolute targets as absolute.
        let dest: string;
        if (destArg) {
          dest = destArg.startsWith('/')
            ? destArg
            : getDir(ctx) + '/' + destArg;
        } else {
          dest = dir + '/' + url.split('/').pop()?.replace('.git', '');
        }

        if (!doCtx || !doEnv) {
          ctx.stderr.write('[git] clone requires DO ctx + env (internal configuration error)\n');
          return 1;
        }

        progress.write(`Cloning into '${dest}'...${depth ? ' (shallow, depth=' + depth + ')' : ''}\n`);

        // A clone's closed-world filesystem view is correct only while no
        // other session surface can mutate its destination subtree. Acquire
        // the lease before the facet performs its lstat/readdir emptiness
        // proof; the clone's W7 stream carries the opaque owner capability
        // through the trusted SupervisorRPC binding.
        const mutationLease = vfs.acquireExclusiveMutation(dest, {
          includeMissingAncestors: true,
        });

        // Delegate to git-network-facet: heavy packfile processing runs in
        // a dynamic worker with its own CPU budget, not the supervisor DO.
        const doClone = async (): Promise<boolean> => {
          try {
            const result = await execGitNetwork(doCtx, doEnv, {
              op: 'clone',
              pid: ctx.pid,
              dir: dest as string,
              url,
              ref: branch,
              depth,
              quiet,
              exclusiveDestination: true,
              exclusiveMutationRoot: mutationLease.root,
              mutationOwner: mutationLease.owner,
              // Verification/tuning knob: force a small per-chunk entry bound
              // so ordinary repos exercise the multi-invocation chunked
              // checkout path. Unset in production → the 10k default applies.
              checkoutChunkMaxEntries: ctx.env.NIMBUS_GIT_CHECKOUT_CHUNK_ENTRIES
                ? Number(ctx.env.NIMBUS_GIT_CHECKOUT_CHUNK_ENTRIES) || undefined
                : undefined,
              auth: {
                username: ctx.env.GIT_USERNAME || '',
                password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
              },
            });
            if (result.success) {
              progress.write(
                `\n[git] clone complete (${result.filesWritten} files, ` +
                `${(result.bytesWritten / 1024).toFixed(1)}KB in ${(result.elapsed / 1000).toFixed(1)}s)\n`,
              );
            } else {
              ctx.stderr.write(`\n[git] clone failed: ${result.error}\n`);
            }
            return result.success;
          } finally {
            vfs.releaseExclusiveMutation(mutationLease.owner);
          }
        };

        if (isBg) {
          const task = doClone();
          doCtx.waitUntil(task);
          progress.write('[git] clone running in background...\n');
          return 0;
        } else {
          return (await doClone()) ? 0 : 1;
        }
      }

      case 'status': {
        const matrix = await git.statusMatrix({ fs, dir });
        let clean = true;
        for (const [filepath, head, workdir, stage] of matrix) {
          if (head === workdir && workdir === stage) continue;
          clean = false;
          if (head === 0 && workdir === 2 && stage === 0) ctx.stdout.write(`\x1b[31m?? ${filepath}\x1b[0m\n`);
          else if (head === 0 && stage === 2) ctx.stdout.write(`\x1b[32mA  ${filepath}\x1b[0m\n`);
          else if (head === 1 && workdir === 2 && stage === 2) ctx.stdout.write(`\x1b[32mM  ${filepath}\x1b[0m\n`);
          else if (head === 1 && workdir === 2 && stage === 1) ctx.stdout.write(`\x1b[31m M ${filepath}\x1b[0m\n`);
          else if (head === 1 && workdir === 0) ctx.stdout.write(`\x1b[31m D ${filepath}\x1b[0m\n`);
          else if (head === 1 && stage === 0) ctx.stdout.write(`\x1b[32mD  ${filepath}\x1b[0m\n`);
          else ctx.stdout.write(`   ${filepath} [${head},${workdir},${stage}]\n`);
        }
        if (clean) ctx.stdout.write('nothing to commit, working tree clean\n');
        return 0;
      }

      case 'add': {
        const paths = subArgs.filter(a => !a.startsWith('-'));
        if (paths.length === 0 || paths.includes('.')) await stageAll(git, fs, dir, false);
        else await git.add({ fs, dir, filepath: paths, parallel: false });
        return 0;
      }

      case 'commit': {
        const { messages, quiet, all } = parseCommitArgs(subArgs);
        const message = messages.length ? messages.join('\n\n') : 'commit';
        if (!message) { ctx.stderr.write('error: empty commit message\n'); return 1; }
        if (all) await stageAll(git, fs, dir, true);
        const sha = await git.commit({
          fs, dir, message,
          author: getAuthor(ctx),
        });
        if (!quiet) ctx.stdout.write(`[${sha.slice(0, 7)}] ${message}\n`);
        return 0;
      }

      case 'rev-parse':
        return await revParse(ctx, git, fs, credentialedVfs, subArgs);

      case 'ls-files':
        return await lsFiles(ctx, git, fs, credentialedVfs, subArgs);

      case 'log': {
        const maxCount = parseInt(getFlag(subArgs, '-n') || getFlag(subArgs, '--max-count') || '10');
        const oneline = subArgs.includes('--oneline');
        const commits = await git.log({ fs, dir, depth: maxCount });
        for (const c of commits) {
          if (oneline) {
            ctx.stdout.write(`\x1b[33m${c.oid.slice(0, 7)}\x1b[0m ${c.commit.message.split('\n')[0]}\n`);
          } else {
            ctx.stdout.write(`\x1b[33mcommit ${c.oid}\x1b[0m\n`);
            ctx.stdout.write(`Author: ${c.commit.author.name} <${c.commit.author.email}>\n`);
            ctx.stdout.write(`Date:   ${new Date(c.commit.author.timestamp * 1000).toDateString()}\n\n`);
            ctx.stdout.write(`    ${c.commit.message}\n\n`);
          }
        }
        return 0;
      }

      case 'branch': {
        if (subArgs[0] === '--show-current') {
          // Empty output on a detached HEAD, like git.
          const current = await git.currentBranch({ fs, dir });
          if (current) ctx.stdout.write(`${current}\n`);
          return 0;
        }
        const unknown = subArgs.find((a) => a.startsWith('-') && !['-a', '--list', '-d', '-D'].includes(a));
        if (unknown) {
          ctx.stderr.write(`error: unknown option '${unknown}'\nusage: git branch [-a | --list | --show-current | -d <name> | -D <name> | <name>]\n`);
          return 129;
        }
        if (subArgs.length === 0 || subArgs[0] === '-a' || subArgs[0] === '--list') {
          const branches = await git.listBranches({ fs, dir });
          const current = await git.currentBranch({ fs, dir });
          for (const b of branches) {
            ctx.stdout.write(b === current ? `\x1b[32m* ${b}\x1b[0m\n` : `  ${b}\n`);
          }
          if (subArgs.includes('-a')) {
            try {
              const remotes = await git.listBranches({ fs, dir, remote: 'origin' });
              for (const b of remotes) ctx.stdout.write(`  \x1b[31mremotes/origin/${b}\x1b[0m\n`);
            } catch {}
          }
        } else if (subArgs.includes('-d') || subArgs.includes('-D')) {
          const name = subArgs.find(a => !a.startsWith('-'));
          if (name) {
            await git.deleteBranch({ fs, dir, ref: name });
            ctx.stdout.write(`Deleted branch ${name}\n`);
          }
        } else {
          const name = subArgs[0];
          await git.branch({ fs, dir, ref: name });
          ctx.stdout.write(`Created branch ${name}\n`);
        }
        return 0;
      }

      case 'checkout': {
        const quiet = subArgs.includes('-q') || subArgs.includes('--quiet');
        const ref = subArgs.find(a => !a.startsWith('-'));
        if (!ref) { ctx.stderr.write('error: specify a branch\n'); return 1; }
        if (subArgs.includes('-b')) {
          await git.branch({ fs, dir, ref });
          await git.checkout({ fs, dir, ref });
          if (!quiet) ctx.stdout.write(`Switched to a new branch '${ref}'\n`);
        } else {
          await git.checkout({ fs, dir, ref });
          if (!quiet) ctx.stdout.write(`Switched to branch '${ref}'\n`);
        }
        return 0;
      }

      case 'diff':
        return await diffCommand(ctx, git, fs, credentialedVfs, subArgs);

      case 'remote': {
        if (subArgs[0] === 'add' && subArgs[1] && subArgs[2]) {
          await git.addRemote({ fs, dir, remote: subArgs[1], url: subArgs[2] });
          ctx.stdout.write(`Remote '${subArgs[1]}' added\n`);
        } else if (subArgs[0] === 'remove' || subArgs[0] === 'rm') {
          await git.deleteRemote({ fs, dir, remote: subArgs[1] });
          ctx.stdout.write(`Remote '${subArgs[1]}' removed\n`);
        } else {
          const remotes = await git.listRemotes({ fs, dir });
          for (const r of remotes) {
            ctx.stdout.write(subArgs.includes('-v') ? `${r.remote}\t${r.url} (fetch)\n` : `${r.remote}\n`);
          }
        }
        return 0;
      }

      case 'fetch': {
        const { quiet, rest } = takeQuiet(subArgs);
        const remote = rest[0] || 'origin';
        if (!doCtx || !doEnv) {
          ctx.stderr.write('[git] fetch requires DO ctx + env (internal configuration error)\n');
          return 1;
        }
        if (!quiet) ctx.stdout.write(`Fetching from ${remote}...\n`);
        const result = await execGitNetwork(doCtx, doEnv, {
          op: 'fetch',
          pid: ctx.pid,
          dir,
          remote,
          quiet,
          auth: {
            username: ctx.env.GIT_USERNAME || '',
            password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
          },
        });
        if (result.success) {
          if (!quiet) ctx.stdout.write(`\n[git] fetch complete (${result.filesWritten} files in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
          return 0;
        } else {
          ctx.stderr.write(`\n[git] fetch failed: ${result.error}\n`);
          return 1;
        }
      }

      case 'pull': {
        const { quiet, rest } = takeQuiet(subArgs);
        const remote = rest[0] || 'origin';
        const branch = rest[1] || await git.currentBranch({ fs, dir }) || 'main';
        if (!doCtx || !doEnv) {
          ctx.stderr.write('[git] pull requires DO ctx + env (internal configuration error)\n');
          return 1;
        }
        if (!quiet) ctx.stdout.write(`Pulling from ${remote}/${branch}...\n`);
        const result = await execGitNetwork(doCtx, doEnv, {
          op: 'pull',
          pid: ctx.pid,
          dir,
          remote,
          ref: branch,
          quiet,
          author: getAuthor(ctx),
          auth: {
            username: ctx.env.GIT_USERNAME || '',
            password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
          },
        });
        if (result.success) {
          if (!quiet) ctx.stdout.write(`\n[git] pull complete (${result.filesWritten} files in ${(result.elapsed / 1000).toFixed(1)}s)\n`);
          return 0;
        } else {
          ctx.stderr.write(`\n[git] pull failed: ${result.error}\n`);
          return 1;
        }
      }

      case 'push': {
        const { quiet, rest } = takeQuiet(subArgs);
        const remote = rest[0] || 'origin';
        const branch = rest[1] || await git.currentBranch({ fs, dir }) || 'main';
        if (!doCtx || !doEnv) {
          ctx.stderr.write('[git] push requires DO ctx + env (internal configuration error)\n');
          return 1;
        }
        if (!quiet) ctx.stdout.write(`Pushing to ${remote}/${branch}...\n`);
        const result = await execGitNetwork(doCtx, doEnv, {
          op: 'push',
          pid: ctx.pid,
          dir,
          remote,
          ref: branch,
          quiet,
          auth: {
            username: ctx.env.GIT_USERNAME || '',
            password: ctx.env.GIT_PASSWORD || ctx.env.GIT_TOKEN || '',
          },
        });
        if (result.success) {
          if (!quiet) ctx.stdout.write(`\n[git] push complete (${(result.elapsed / 1000).toFixed(1)}s)\n`);
          return 0;
        } else {
          ctx.stderr.write(`\n[git] push failed: ${result.error}\n`);
          return 1;
        }
      }

      case 'merge': {
        const theirs = subArgs[0];
        if (!theirs) { ctx.stderr.write('usage: git merge <branch>\n'); return 1; }
        await git.merge({
          fs, dir, theirs,
          author: getAuthor(ctx),
        });
        ctx.stdout.write(`Merged ${theirs}\n`);
        return 0;
      }

      case 'reset': {
        const hard = subArgs.includes('--hard');
        const soft = subArgs.includes('--soft');
        const ref = subArgs.find(a => !a.startsWith('-')) || 'HEAD';
        const oid = await git.resolveRef({ fs, dir, ref });

        // Move the current branch to the target OID
        const branch = await git.currentBranch({ fs, dir });
        if (branch) {
          await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
        }

        if (!soft) {
          // Reset index (--mixed behavior, also applies to --hard)
          const matrix = await git.statusMatrix({ fs, dir });
          for (const [filepath] of matrix) {
            try { await git.resetIndex({ fs, dir, filepath }); } catch {}
          }
        }

        if (hard) {
          // Reset working tree to match the target
          await git.checkout({ fs, dir, ref: oid, force: true });
        }

        ctx.stdout.write(`HEAD is now at ${oid.slice(0, 7)}\n`);
        return 0;
      }

      case 'tag': {
        if (subArgs.length === 0) {
          const tags = await git.listTags({ fs, dir });
          for (const t of tags) ctx.stdout.write(t + '\n');
        } else if (subArgs.includes('-d')) {
          const name = subArgs.find(a => !a.startsWith('-'));
          if (name) await git.deleteTag({ fs, dir, ref: name });
        } else {
          const name = subArgs[0];
          await git.tag({ fs, dir, ref: name });
          ctx.stdout.write(`Created tag ${name}\n`);
        }
        return 0;
      }

      case 'config': {
        const key = subArgs.find(a => !a.startsWith('-'));
        const value = subArgs[subArgs.indexOf(key || '') + 1];
        if (key && value) {
          const [section, ...rest] = key.split('.');
          await git.setConfig({ fs, dir, path: key, value });
          ctx.stdout.write(`${key}=${value}\n`);
        } else if (key) {
          try {
            const val = await git.getConfig({ fs, dir, path: key });
            ctx.stdout.write(`${val}\n`);
          } catch { ctx.stderr.write(`config: key '${key}' not set\n`); return 1; }
        } else {
          ctx.stderr.write('usage: git config <key> [value]\n');
          return 1;
        }
        return 0;
      }

      default:
        ctx.stderr.write(`git: '${sub}' is not a git command. See 'git --help'.\n`);
        return 1;
    }
  } catch (e: any) {
    // The reader went away (`git diff | head`): git dies of SIGPIPE, silently.
    if (e?.code === 'EPIPE') return 141;
    ctx.stderr.write(`fatal: ${e?.message || e}\n`);
    return 128;
  }
}
