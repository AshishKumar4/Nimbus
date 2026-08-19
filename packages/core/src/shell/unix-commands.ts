/**
 * unix-commands.ts — Nimbus v2.0 Unix command implementations.
 *
 * Every command is a real implementation operating on SqliteVFS.
 * No stubs, no "not implemented" — each does actual work.
 *
 * Commands: which, env, export, unset, history, clear, alias, date,
 * uptime, tree, find, grep -r, head, tail, wc, diff, sort, uniq,
 * sed (s///), awk (field extract), xargs, tee, chown, ln -s,
 * du, man/help, basename, dirname, printf, true, false, seq, sleep,
 * touch, stat, file, xxd, base64, sha256sum, id, hostname, realpath
 */

import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import { getSymlinkRegistry, type SymlinkRegistry } from '../vfs/symlink-registry.js';
import { requireVfsCred, type VfsCred } from '../runtime/os-contracts.js';
import { dec, enc } from '../_shared/bytes.js';
import { errorText } from '../_shared/error-text.js';
import { NIMBUS_VERSION } from '../constants.js';
import { SinkWriter, streamRange } from '../_shared/byte-stream.js';
import {
  fileTypeChar,
  isCharacterDevice,
  type FileType,
  type VFS,
} from '../substrate/lifo/kernel/vfs/index.js';
import type { Command, CommandInputStream } from '../substrate/lifo/commands/types.js';
import { runSed } from '../substrate/lifo/commands/text/sed.js';
import { parseArgs } from '../substrate/lifo/utils/args.js';
import {
  findUnixGroupName,
  findUnixUserName,
  parseChownOwnership,
} from './unix-accounts.js';
import { createSuCommand, createSudoCommand, createUmaskCommand } from './elevation-commands.js';

/**
 * stdin as the shell hands it over: a pipe reader, whose `readAll` resolves
 * once upstream closes, or the terminal's own stream, which stays open past
 * the command and so is taken from `buffer` instead of awaited.
 */
type ShellStdin = CommandInputStream & {
  feed?(text: string): void;
  buffer?: string[];
};

/**
 * The VFS the caller supplies. The shell hands the kernel's mount-aware tree,
 * so `/dev` and the other mounts resolve; an embedder that invokes a command
 * directly hands a credentialed durable view. `readdirStat` belongs to the
 * first and `isDirectory` to the second, which is why the paths that want
 * either one probe for it.
 */
type CtxVfs = CredentialedVfs | VFS;

/**
 * A stat as either layer reports it. The kernel's tree leaves out what a mount
 * cannot know — ownership, access time — and that is what the fallbacks at the
 * use sites stand in for.
 */
type CtxStat = {
  type: FileType;
  size: number;
  mode: number;
  mtime: number;
  ctime: number;
  atime?: number;
  uid?: number;
  gid?: number;
};

type Ctx = {
  pid: number;
  args: string[];
  /**
   * `writeBytes` is present on sinks that store bytes verbatim — files,
   * `/dev/null` — and absent on textual ones, so a command with binary output
   * uses it when it is there and falls back to decoded text when it is not.
   */
  stdout: { write(s: string): void; writeBytes?(bytes: Uint8Array): void };
  stderr: { write(s: string): void };
  cwd: string;
  env: Record<string, string>;
  /**
   * The shell's stream until `wrap` drains it to a string in place. Command
   * bodies read the string; `head`, wrapped for streaming, reads the stream.
   */
  stdin?: string | ShellStdin;
  cred: VfsCred;
  vfs: CtxVfs;
  signal: AbortSignal;
  setUmask(mask: number): void;
  runAs(cred: VfsCred, argv: string[]): Promise<number>;
  execInterpreterDepth?: number;
};

type CmdFn = (ctx: Ctx) => number | Promise<number>;

type UnixVfs = CredentialedVfs & {
  readonly symlinks: SymlinkRegistry;
};

/**
 * A command the registry resolved. A runtime that is known but not installed
 * is stored as a stub carrying `__nimbusRuntimeInstallHint` (the worker's
 * `shell/npm-bin-entrypoints.ts` sets it), which `which` and `type` must not
 * report as a builtin.
 */
type ResolvedCommand = CmdFn & { __nimbusRuntimeInstallHint?: boolean };

/**
 * The registry these commands dispatch through: registration, and name
 * resolution for `which`, `type`, `command`, `find -exec` and `xargs`.
 * `resolve` answers `unknown` because the registry holds whatever any module
 * registered — and the worker's npm-bin fallback replaces the method outright
 * — so what comes back is a command only once it has been checked.
 */
type UnixCommandRegistry = {
  register(name: string, handler: Command): void;
  resolve(name: string): unknown;
};

/**
 * A resolved entry as a command this module can run. Every handler in the
 * registry takes a command context; the ones registered below read the string
 * `wrap` leaves in `stdin`, and a command dispatched from here is handed that
 * string rather than a reader.
 */
function asResolvedCommand(resolved: unknown): ResolvedCommand | null {
  return typeof resolved === 'function' ? resolved as ResolvedCommand : null;
}

/**
 * stdin as text. `wrap` drains the shell's stream into `ctx.stdin` before a
 * command body runs, so a command that does not read a stream itself sees the
 * string it left there, and nothing at all when there was no stdin.
 */
function stdinText(ctx: Ctx): string | undefined {
  return typeof ctx.stdin === 'string' ? ctx.stdin : undefined;
}

function unixVfsFor(sqliteVfs: SqliteVFS, cred: VfsCred): UnixVfs {
  return {
    ...sqliteVfs.as(cred),
    symlinks: getSymlinkRegistry(sqliteVfs),
  };
}

function withInvocationVfs(
  sqliteVfs: SqliteVFS,
  factory: (vfs: UnixVfs) => CmdFn,
): CmdFn {
  return (ctx) => factory(unixVfsFor(
    sqliteVfs,
    requireVfsCred(ctx.cred, 'unix command dispatch'),
  ))(ctx);
}

function fsErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code === 'EACCES' || code === 'EPERM') return 'Permission denied';
    if (code === 'ENOENT') return 'No such file or directory';
    return error.message;
  }
  return String(error);
}

/** `drwxr-xr-x`-style permission string, shared by `ls -l` and `stat %A`. */
function unixModeString(mode: number, isDir: boolean, isLink: boolean): string {
  if (isLink) return 'lrwxrwxrwx';
  const prefix = fileTypeChar(mode, isDir ? 'directory' : 'file');
  const bits = [
    mode & 0o400 ? 'r' : '-',
    mode & 0o200 ? 'w' : '-',
    mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-',
    mode & 0o020 ? 'w' : '-',
    mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-',
    mode & 0o002 ? 'w' : '-',
    mode & 0o001 ? 'x' : '-',
  ].join('');
  return prefix + bits;
}

function unixUserLabel(vfs: UnixVfs, uid: number): string {
  try {
    return findUnixUserName(vfs, uid) ?? String(uid);
  } catch {
    return String(uid);
  }
}

function unixGroupLabel(vfs: UnixVfs, gid: number): string {
  try {
    return findUnixGroupName(vfs, gid) ?? String(gid);
  } catch {
    return String(gid);
  }
}

function isRuntimeInstallHintHandler(handler: ResolvedCommand | null): boolean {
  return !!handler && !!handler.__nimbusRuntimeInstallHint;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolvePath(cwd: string, p: string): string {
  if (p.startsWith('/')) return p.replace(/^\/+/, '');
  const c = (cwd || '/home/user').replace(/^\/+/, '');
  const parts = (c + '/' + p).split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
}

function readSymlinkTarget(vfs: UnixVfs, path: string): string | null {
  if (vfs.isSymlink(path)) return vfs.readlink(path);
  return vfs.symlinks.readlink(path);
}

function resolveSymlinkPath(vfs: UnixVfs, startPath: string): string | null {
  let current = resolvePath('/', startPath);
  for (let hops = 0; hops < 40; hops++) {
    const target = readSymlinkTarget(vfs, current);
    if (target === null) return current;
    current = target.startsWith('/')
      ? resolvePath('/', target)
      : resolvePath('/' + (current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : ''), target);
  }
  return null;
}

function globMatch(pattern: string, name: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + re + '$').test(name);
}

// ── Command implementations ─────────────────────────────────────────────

/**
 * SHELL-FOLLOWUPS-1 (2026-05-11): POSIX-conformant `which`.
 *
 * Pre-fix: `which clang` printed `clang: nimbus built-in`. Real POSIX
 * which prints the resolved absolute path (`/usr/local/bin/clang`)
 * or exits 1 silently. Scripts using `which` output to feed into
 * `dirname`, `$()`, etc. all broke:
 *   PATH_PREFIX=$(dirname $(which clang))   # expected /usr/local/bin
 *
 * Behaviour matches GNU `which`:
 *   - PATH search: walk `$PATH`, return first hit's absolute path.
 *   - Found in PATH: print path to stdout, exit 0.
 *   - Resolved as shell builtin (no -a): exit 1, NO output.
 *   - Resolved as shell builtin (with -a): print
 *     "<cmd>: shell built-in command" + continue search PATH.
 *   - Not found anywhere: stderr "<cmd>: not in (PATH)", exit 1.
 *
 * For our facet-direct runtimes (clang, node, bun, python, ruby,
 * git, npm, etc.), we don't have real on-disk binaries — they
 * dispatch through the registry. To preserve script compatibility,
 * we return canonical POSIX paths under /usr/local/bin and /usr/bin:
 *
 *   clang, clang++, cc                → /usr/local/bin/clang
 *   wasm-ld, lld                      → /usr/local/bin/wasm-ld
 *   node, nodejs                      → /usr/local/bin/node
 *   bun                               → /usr/local/bin/bun
 *   npm, npx                          → /usr/local/bin/npm
 *   git                               → /usr/bin/git
 *   python, python3                   → /usr/bin/python3
 *   ruby, ruby3                       → /usr/bin/ruby
 *   wrangler, nimbus-wrangler         → /usr/local/bin/wrangler
 *   esbuild, tsc, vite, rollup, etc.  → /usr/local/bin/<name>
 *
 * These paths are virtual but POSIX-shaped so scripts do the right
 * thing with `dirname $(which X)` etc. The paths don't have to
 * exist on the VFS (real GNU which just stat-walks PATH and
 * doesn't require execute bit at lookup time for stdout — it does
 * for exit code, but match what users expect first).
 *
 * If the user has installed a real binary in PATH (npm install + npx
 * resolution into /home/user/node_modules/.bin/X), prefer the actual
 * VFS-resolved path over the canonical fallback.
 */
const _CANONICAL_BIN_PATHS: Record<string, string> = {
  // /usr/local/bin (locally-installed runtimes)
  clang: '/usr/local/bin/clang',
  'clang++': '/usr/local/bin/clang++',
  cc: '/usr/local/bin/clang',
  'wasm-ld': '/usr/local/bin/wasm-ld',
  lld: '/usr/local/bin/wasm-ld',
  node: '/usr/local/bin/node',
  nodejs: '/usr/local/bin/node',
  bun: '/usr/local/bin/bun',
  npm: '/usr/local/bin/npm',
  npx: '/usr/local/bin/npx',
  pnpm: '/usr/local/bin/pnpm',
  yarn: '/usr/local/bin/yarn',
  esbuild: '/usr/local/bin/esbuild',
  tsc: '/usr/local/bin/tsc',
  vite: '/usr/local/bin/vite',
  rollup: '/usr/local/bin/rollup',
  webpack: '/usr/local/bin/webpack',
  wrangler: '/usr/local/bin/wrangler',
  'nimbus-wrangler': '/usr/local/bin/nimbus-wrangler',
  // /usr/bin (system runtimes)
  git: '/usr/bin/git',
  python: '/usr/bin/python3',
  python3: '/usr/bin/python3',
  pip: '/usr/bin/pip',
  pip3: '/usr/bin/pip3',
  ruby: '/usr/bin/ruby',
  ruby3: '/usr/bin/ruby',
  gem: '/usr/bin/gem',
  bundle: '/usr/bin/bundle',
  bundler: '/usr/bin/bundler',
  sh: '/usr/bin/sh',
  bash: '/usr/bin/bash',
  // Framework CLIs
  astro: '/usr/local/bin/astro',
  nuxt: '/usr/local/bin/nuxt',
  nuxi: '/usr/local/bin/nuxi',
  next: '/usr/local/bin/next',
  remix: '/usr/local/bin/remix',
  'svelte-kit': '/usr/local/bin/svelte-kit',
  husky: '/usr/local/bin/husky',
  lefthook: '/usr/local/bin/lefthook',
  'simple-git-hooks': '/usr/local/bin/simple-git-hooks',
  'lint-staged': '/usr/local/bin/lint-staged',
  yorkie: '/usr/local/bin/yorkie',
  // Self
  nimbus: '/usr/local/bin/nimbus',
};

function _pathLookup(
  vfs: UnixVfs,
  name: string,
  envPath: string,
): string | null {
  const paths = (envPath || '/usr/local/bin:/usr/bin:/bin').split(':');
  for (const dir of paths) {
    if (!dir) continue;
    const stripped = dir.replace(/^\/+/, '').replace(/\/+$/, '');
    const fp = stripped + '/' + name;
    if (vfs.exists(fp) && !vfs.isDirectory(fp)) {
      return '/' + fp;
    }
  }
  return null;
}

async function _registryResolved(
  registry: UnixCommandRegistry,
  name: string,
  options: { includeInstallHints?: boolean } = {},
): Promise<ResolvedCommand | null> {
  try {
    const resolved = typeof registry.resolve === 'function'
      ? asResolvedCommand(await registry.resolve(name))
      : null;
    if (resolved && (options.includeInstallHints || !isRuntimeInstallHintHandler(resolved))) {
      return resolved;
    }
  } catch {
    // Registry misses are normal for unknown commands.
  }
  return null;
}

/** Resolve a command name to a path via PATH-walk + canonical-bin
 *  fallback. Returns null if not findable. Skip-canonical when the
 *  caller knows the command is a shell builtin (no fallback). */
async function _whichLookup(
  vfs: UnixVfs,
  registry: UnixCommandRegistry,
  name: string,
  envPath: string,
): Promise<string | null> {
  const diskPath = _pathLookup(vfs, name, envPath);
  if (diskPath) return diskPath;
  const canonicalPath = _CANONICAL_BIN_PATHS[name];
  if (!canonicalPath) return null;
  return await _registryResolved(registry, name, { includeInstallHints: true })
    ? canonicalPath
    : null;
}

function mkWhich(vfs: UnixVfs, registry: UnixCommandRegistry): CmdFn {
  return async (ctx) => {
    // Parse flags. Supports -a (show all matches), -s (silent — no
    // stdout, only exit code). Default behaviour matches GNU which.
    let showAll = false;
    let silent = false;
    const names: string[] = [];
    for (const a of ctx.args) {
      if (a === '-a' || a === '--all') { showAll = true; continue; }
      if (a === '-s' || a === '--silent') { silent = true; continue; }
      if (a.startsWith('-') && a !== '-') {
        // Combined short flags
        for (const ch of a.slice(1)) {
          if (ch === 'a') showAll = true;
          else if (ch === 's') silent = true;
        }
        continue;
      }
      names.push(a);
    }
    if (names.length === 0) {
      ctx.stderr.write('Usage: which [-as] command [command ...]\n');
      return 1;
    }
    let anyMissing = false;
    for (const name of names) {
      // Classify: is it a registry-resolvable command (shell builtin)?
      const resolved = await _registryResolved(registry, name);
      const isBuiltin = !!resolved;
      // 1. PATH-walk + canonical-bin lookup.
      const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
      let found = false;
      if (path) {
        if (!silent) ctx.stdout.write(path + '\n');
        found = true;
      }
      // 2. With -a, also report builtins (real GNU which behaviour).
      if (showAll && isBuiltin) {
        if (!silent) ctx.stdout.write(`${name}: shell built-in command\n`);
        found = true;
      }
      // 3. Without -a, if no PATH match but is builtin: GNU which
      //    exits 1 silently (with -s suppresses stderr too).
      if (!path && isBuiltin && !showAll) {
        // Exit 1; no output. Matches GNU `which` default.
        anyMissing = true;
        continue;
      }
      if (!found) {
        if (!silent) ctx.stderr.write(`which: no ${name} in (${ctx.env.PATH || '/usr/local/bin:/usr/bin:/bin'})\n`);
        anyMissing = true;
      }
    }
    return anyMissing ? 1 : 0;
  };
}

/**
 * SHELL-FOLLOWUPS-2 (2026-05-11): `whereis` companion to `which`.
 * GNU whereis prints binary, source, and manpage paths. We only have
 * binaries on the virtual VFS; print just the binary path. With no
 * match, print just the name (matches `whereis` behavior on missing).
 */
function mkWhereis(vfs: UnixVfs, registry: UnixCommandRegistry): CmdFn {
  return async (ctx) => {
    const names = ctx.args.filter(a => !a.startsWith('-'));
    if (names.length === 0) {
      ctx.stderr.write('Usage: whereis name [name ...]\n');
      return 1;
    }
    for (const name of names) {
      const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
      if (path) {
        ctx.stdout.write(`${name}: ${path}\n`);
      } else {
        // GNU whereis prints just "name:" when nothing found.
        ctx.stdout.write(`${name}:\n`);
      }
    }
    return 0;
  };
}

/**
 * SHELL-FOLLOWUPS-3 (2026-05-11): POSIX `command -v` / `command -V`.
 * Used by shell scripts as the portable alternative to `which`:
 *   command -v clang  → prints path, exit 0 if found, exit 1 if not
 *   command -V clang  → verbose form (similar to `type`)
 *   command clang ARG → invoke clang bypassing any function/alias
 *
 * For the invoke case (no -v/-V), we don't have a way to bypass
 * alias/function from here, so we just dispatch to
 * the registry. Aliases are checked at executeLine time so `command
 * X` going through our normal dispatch IS bypassing the alias
 * (because the interpreter only consults aliases
 * for the head word).
 */
function mkCommand(vfs: UnixVfs, registry: UnixCommandRegistry): CmdFn {
  return async (ctx) => {
    const args = [...ctx.args];
    let mode: '-v' | '-V' | 'invoke' = 'invoke';
    if (args[0] === '-v') { mode = '-v'; args.shift(); }
    else if (args[0] === '-V') { mode = '-V'; args.shift(); }
    if (args.length === 0) {
      if (mode === 'invoke') return 0;
      ctx.stderr.write('command: missing operand\n');
      return 1;
    }
    if (mode === '-v') {
      // Print path or builtin marker; exit 0 if found.
      const name = args[0];
      const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
      if (path) { ctx.stdout.write(path + '\n'); return 0; }
      if (await _registryResolved(registry, name)) { ctx.stdout.write(name + '\n'); return 0; }
      return 1;
    }
    if (mode === '-V') {
      const name = args[0];
      const path = await _whichLookup(vfs, registry, name, ctx.env.PATH || '');
      if (path) { ctx.stdout.write(`${name} is ${path}\n`); return 0; }
      if (await _registryResolved(registry, name)) { ctx.stdout.write(`${name} is a shell builtin\n`); return 0; }
      ctx.stderr.write(`command: ${name}: not found\n`);
      return 1;
    }
    // invoke mode: dispatch directly via registry. Bypasses aliases
    // because we're calling the resolved cmd not the alias name.
    const name = args[0];
    try {
      const resolved = asResolvedCommand(await registry.resolve(name));
      if (!resolved) {
        ctx.stderr.write(`command: ${name}: not found\n`);
        return 127;
      }
      const subCtx = { ...ctx, args: args.slice(1) };
      const code = await resolved(subCtx);
      return typeof code === 'number' ? code : 0;
    } catch (e) {
      ctx.stderr.write(`command: ${name}: ${errorText(e)}\n`);
      return 1;
    }
  };
}

/**
 * shell compatibility (2026-05-11): `type` builtin. The shell did not ship
 * one; pre-fix `type echo` → 'type: command not found'. bash's
 * `type X` reports how X would be interpreted (builtin, alias,
 * function, file, or unknown).
 *
 * Our subset (matches bash `type` output for common shapes):
 *   type echo  → 'echo is a shell builtin'        (Shell.builtins entry)
 *   type ls    → 'ls is a shell builtin'          (lazy registry)
 *   type rm    → 'rm is a shell builtin'          (our wrap'd registry)
 *   type node  → 'node is /usr/bin/node'          (registry but facet-direct)
 *   type X     → 'type: X: not found' + exit 1
 *
 * We can't introspect Shell.builtins from here directly (the ctx
 * doesn't carry shell). Workaround: pass registry which the unix-
 * commands module already has access to; treat any registry resolve
 * as "shell builtin" classification.
 */
function mkType(_vfs: UnixVfs, registry: UnixCommandRegistry): CmdFn {
  return async (ctx) => {
    if (ctx.args.length === 0) return 0;
    let exit = 0;
    for (const name of ctx.args) {
      try {
        const resolved = typeof registry.resolve === 'function'
          ? asResolvedCommand(await registry.resolve(name))
          : null;
        if (resolved && !isRuntimeInstallHintHandler(resolved)) {
          ctx.stdout.write(`${name} is a shell builtin\n`);
        } else {
          ctx.stderr.write(`type: ${name}: not found\n`);
          exit = 1;
        }
      } catch (_e) {
        ctx.stderr.write(`type: ${name}: not found\n`);
        exit = 1;
      }
    }
    return exit;
  };
}

function mkEnv(): CmdFn {
  return (ctx) => {
    for (const [k, v] of Object.entries(ctx.env)) {
      ctx.stdout.write(`${k}=${v}\n`);
    }
    return 0;
  };
}

function mkExport(): CmdFn {
  return (ctx) => {
    for (const arg of ctx.args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        ctx.env[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1);
      } else if (ctx.env[arg] !== undefined) {
        ctx.stdout.write(`export ${arg}="${ctx.env[arg]}"\n`);
      }
    }
    return 0;
  };
}

function mkUnset(): CmdFn {
  return (ctx) => {
    for (const name of ctx.args) { delete ctx.env[name]; }
    return 0;
  };
}

function mkClear(): CmdFn {
  return (ctx) => { ctx.stdout.write('\x1b[2J\x1b[H'); return 0; };
}

/**
 * shell compatibility (2026-05-11): date strftime format support.
 *
 * Pre-fix mkDate only honoured `-u`, `-I`, and `+%s` literal. Any
 * other `+FMT` was a no-op falling to `now.toString()`. Real shell
 * scripts use `date +%Y-%m-%d`, `date +%H:%M:%S`, `date +%F`, etc.
 *
 * Post-fix: full strftime subset:
 *   %Y / %C / %y       year (4-digit / century / 2-digit)
 *   %m / %B / %b / %h  month (numeric / full name / abbrev / abbrev)
 *   %d / %e            day of month (zero-padded / space-padded)
 *   %j                 day of year
 *   %H / %I / %M / %S  hour-24 / hour-12 / minute / second
 *   %p                 AM/PM
 *   %A / %a            weekday (full / abbrev)
 *   %u / %w            ISO weekday (1=Mon..7=Sun) / weekday (0=Sun..6=Sat)
 *   %s                 unix timestamp (seconds)
 *   %N                 nanoseconds (zero-pad to 9 digits)
 *   %F                 %Y-%m-%d
 *   %T / %R            %H:%M:%S / %H:%M
 *   %D                 %m/%d/%y
 *   %z / %Z            timezone offset / name
 *   %%                 literal %
 *   %n / %t            newline / tab
 */
function mkDate(): CmdFn {
  return (ctx) => {
    const now = new Date();
    const useUtc = ctx.args.includes('-u') || ctx.args.includes('--utc');
    // Find the `+FMT` arg (if any). Real `date +FMT [args]` accepts
    // only one format; we honour the first.
    const fmtArg = ctx.args.find(a => a.startsWith('+'));
    if (fmtArg) {
      ctx.stdout.write(strftime(now, fmtArg.slice(1), useUtc) + '\n');
      return 0;
    }
    if (ctx.args.includes('-I') || ctx.args.includes('--iso-8601')) {
      ctx.stdout.write(now.toISOString() + '\n');
      return 0;
    }
    if (useUtc) {
      ctx.stdout.write(now.toUTCString() + '\n');
      return 0;
    }
    ctx.stdout.write(now.toString() + '\n');
    return 0;
  };
}

const _MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const _MONTHS_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _DAYS_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function strftime(d: Date, fmt: string, utc: boolean): string {
  const get = (m: string): number => {
    switch (m) {
      case 'FullYear': return utc ? d.getUTCFullYear() : d.getFullYear();
      case 'Month': return utc ? d.getUTCMonth() : d.getMonth();
      case 'Date': return utc ? d.getUTCDate() : d.getDate();
      case 'Hours': return utc ? d.getUTCHours() : d.getHours();
      case 'Minutes': return utc ? d.getUTCMinutes() : d.getMinutes();
      case 'Seconds': return utc ? d.getUTCSeconds() : d.getSeconds();
      case 'Day': return utc ? d.getUTCDay() : d.getDay();
      case 'Milliseconds': return utc ? d.getUTCMilliseconds() : d.getMilliseconds();
      default: return 0;
    }
  };
  const pad = (n: number, w: number, ch = '0') => String(n).padStart(w, ch);
  const yyyy = get('FullYear');
  const mm0 = get('Month');           // 0..11
  const dd = get('Date');
  const hh = get('Hours');
  const mn = get('Minutes');
  const ss = get('Seconds');
  const dow = get('Day');             // 0..6 (Sun..Sat)
  const ms = get('Milliseconds');
  // Day of year: difference from Jan 1.
  const jan1 = utc
    ? Date.UTC(yyyy, 0, 1)
    : new Date(yyyy, 0, 1).getTime();
  const doy = Math.floor((d.getTime() - jan1) / 86400000) + 1;
  // ISO weekday: 1=Mon..7=Sun.
  const isoDow = dow === 0 ? 7 : dow;
  const ampm = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  // TZ offset in ±HHMM form.
  const tzOff = utc ? '+0000' : (() => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return sign + pad(Math.floor(abs / 60), 2) + pad(abs % 60, 2);
  })();
  const tzName = utc ? 'UTC' : (() => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
      const tz = parts.find(p => p.type === 'timeZoneName');
      return tz ? tz.value : 'UTC';
    } catch { return 'UTC'; }
  })();
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch !== '%') { out += ch; i++; continue; }
    i++;
    const spec = fmt[i] || '';
    i++;
    switch (spec) {
      case 'Y': out += String(yyyy); break;
      case 'C': out += pad(Math.floor(yyyy / 100), 2); break;
      case 'y': out += pad(yyyy % 100, 2); break;
      case 'm': out += pad(mm0 + 1, 2); break;
      case 'B': out += _MONTHS_FULL[mm0]; break;
      case 'b': case 'h': out += _MONTHS_ABBR[mm0]; break;
      case 'd': out += pad(dd, 2); break;
      case 'e': out += String(dd).padStart(2, ' '); break;
      case 'j': out += pad(doy, 3); break;
      case 'H': out += pad(hh, 2); break;
      case 'I': out += pad(h12, 2); break;
      case 'M': out += pad(mn, 2); break;
      case 'S': out += pad(ss, 2); break;
      case 'p': out += ampm; break;
      case 'P': out += ampm.toLowerCase(); break;
      case 'A': out += _DAYS_FULL[dow]; break;
      case 'a': out += _DAYS_ABBR[dow]; break;
      case 'u': out += String(isoDow); break;
      case 'w': out += String(dow); break;
      case 's': out += String(Math.floor(d.getTime() / 1000)); break;
      case 'N': out += pad(ms * 1_000_000, 9); break;
      case 'F': out += `${yyyy}-${pad(mm0 + 1, 2)}-${pad(dd, 2)}`; break;
      case 'T': out += `${pad(hh, 2)}:${pad(mn, 2)}:${pad(ss, 2)}`; break;
      case 'R': out += `${pad(hh, 2)}:${pad(mn, 2)}`; break;
      case 'D': out += `${pad(mm0 + 1, 2)}/${pad(dd, 2)}/${pad(yyyy % 100, 2)}`; break;
      case 'z': out += tzOff; break;
      case 'Z': out += tzName; break;
      case '%': out += '%'; break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      default: out += '%' + spec; break;  // unknown — preserve literal
    }
  }
  return out;
}

function mkUptime(): CmdFn {
  const start = Date.now();
  return (ctx) => {
    const secs = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    ctx.stdout.write(` ${new Date().toTimeString().split(' ')[0]} up ${h}:${String(m).padStart(2, '0')}, 1 user\n`);
    return 0;
  };
}

function mkTree(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const args = ctx.args.filter(a => !a.startsWith('-') && (ctx.args.indexOf(a) !== ctx.args.indexOf('-L') + 1));
    const root = args[0] ? resolvePath(ctx.cwd, args[0]) : (ctx.cwd || '/home/user').replace(/^\/+/, '');
    const maxDepth = ctx.args.includes('-L') ? parseInt(ctx.args[ctx.args.indexOf('-L') + 1]) || 3 : 3;
    const MAX_ENTRIES = 2000; // Safety limit to prevent hanging on huge repos
    let dirs = 0, files = 0, total = 0;
    let truncated = false;
    function walk(path: string, prefix: string, depth: number) {
      if (depth > maxDepth || truncated) return;
      try {
        const entries = vfs.readdir(path).sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < entries.length; i++) {
          if (total >= MAX_ENTRIES) { truncated = true; return; }
          total++;
          const e = entries[i];
          const isLast = i === entries.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const childPrefix = isLast ? '    ' : '│   ';
          ctx.stdout.write(prefix + connector + e.name + '\n');
          if (e.type === 'directory') {
            dirs++;
            walk(path + '/' + e.name, prefix + childPrefix, depth + 1);
          } else { files++; }
        }
      } catch {}
    }
    const name = root.split('/').pop() || root;
    ctx.stdout.write(name + '\n');
    walk(root, '', 1);
    if (truncated) ctx.stdout.write(`\n... truncated at ${MAX_ENTRIES} entries\n`);
    ctx.stdout.write(`\n${dirs} directories, ${files} files\n`);
    return 0;
  };
}

/**
 * `find`'s arguments are an EXPRESSION, not a flag list.
 *
 * The flat AND-list this replaced dropped every token it did not recognise,
 * which does not fail — it answers a different question. `find . ! -name x`
 * ran as `find . -name x`, the exact complement of the requested set, and
 * said nothing. An installer's
 *
 *     find "$dir" -mindepth 1 -maxdepth 1 -type d | head -n 1
 *
 * silently became `-maxdepth 1 -type d`, which emits the start directory at
 * depth 0, so the pipeline selected the container instead of the tree in it.
 *
 * So the fix is not `-mindepth`. It is to parse the real grammar —
 *
 *     expr   := or
 *     or     := and (('-o' | '-or') and)*
 *     and    := unary (('-a' | '-and')? unary)*
 *     unary  := ('!' | '-not') unary | '(' expr ')' | primary
 *
 * — with `-a` binding tighter than `-o`, to evaluate it with short-circuit
 * semantics (which is what makes the `-prune -o -print` idiom work), and to
 * REFUSE any token outside the table below rather than ignore it.
 *
 * Every behaviour here was derived by running the same expression under GNU
 * findutils 4.10.0; tests/unit/find-expression-evaluator.mjs carries the
 * differential.
 *
 * Global options   -maxdepth N, -mindepth N, -depth
 * Operators        !, -not, -a, -and, -o, -or, ( )
 * Tests            -name, -iname, -path, -type, -size, -mtime, -newer, -empty
 * Actions          -print, -print0, -delete, -exec … {} \\; | +, -prune, -quit
 *
 * Anything else is `find: unknown predicate '-x'`, exit 1 — the same
 * honesty `uname -m` keeps by answering `wasm`.
 */

/** A usage error carrying the message GNU find prints for it. */
class FindUsageError extends Error {}

interface FindEntry {
  /** Canonical VFS path (no leading slash) — what the VFS is asked about. */
  vfsPath: string;
  /** Path as find prints it: the start argument plus the relative remainder. */
  display: string;
  name: string;
  type: string;
  depth: number;
}

interface FindState {
  minDepth: number;
  maxDepth: number;
  /** -depth, or implied by -delete: visit children before their parent. */
  depthFirst: boolean;
  /** Set by -prune while the current entry is being evaluated. */
  prune: boolean;
  /** Set by -quit: stop the walk entirely. */
  quit: boolean;
}

/** One `-exec … +` site: its argv template and the matches batched for it. */
interface FindExecBatch {
  argv: string[];
  pending: string[];
}

type FindNode = (entry: FindEntry, st: FindState) => Promise<boolean>;
function mkFind(vfs: UnixVfs, registry: UnixCommandRegistry): CmdFn {
  return async (ctx) => {
    const state: FindState = {
      minDepth: 0,
      maxDepth: Infinity,
      depthFirst: false,
      prune: false,
      quit: false,
    };
    const execBatches: FindExecBatch[] = [];
    let hasAction = false;

    // ── Emission ──────────────────────────────────────────────────────────
    const emit = (entry: FindEntry, terminator: string): void => {
      ctx.stdout.write(entry.display + terminator);
    };

    /** Run one command through the registry the session resolves through. */
    const runExec = async (argv: string[]): Promise<boolean> => {
      const [name, ...rest] = argv;
      if (!name) return false;
      let target: ResolvedCommand | null;
      try { target = asResolvedCommand(await registry.resolve(name)); } catch { target = null; }
      if (!target) {
        ctx.stderr.write(`find: ${name}: No such file or directory\n`);
        return false;
      }
      try {
        const code = await target({
          pid: ctx.pid,
          cred: ctx.cred,
          args: rest,
          env: ctx.env,
          cwd: ctx.cwd,
          vfs: ctx.vfs,
          stdout: ctx.stdout,
          stderr: ctx.stderr,
          stdin: '',
          signal: ctx.signal,
          setUmask: ctx.setUmask,
          runAs: ctx.runAs,
          execInterpreterDepth: ctx.execInterpreterDepth,
        });
        return code === 0;
      } catch (e) {
        ctx.stderr.write(`find: ${name}: ${errorText(e)}\n`);
        return false;
      }
    };

    // ── Parser ────────────────────────────────────────────────────────────
    //
    // Start paths come first: GNU reads operands until the first token that
    // begins an expression, so `find a b -type d` walks both a and b.
    const args = [...ctx.args];
    let pos = 0;
    const startsExpression = (tok: string): boolean =>
      tok.startsWith('-') || tok === '(' || tok === ')' || tok === '!' || tok === ',';

    const startArgs: string[] = [];
    while (pos < args.length && !startsExpression(args[pos])) startArgs.push(args[pos++]);
    if (startArgs.length === 0) startArgs.push('.');

    const peek = (): string | undefined => args[pos];
    const next = (): string | undefined => args[pos++];
    /** The argument a predicate requires, or GNU's missing-argument error. */
    const value = (pred: string): string => {
      const v = args[pos++];
      if (v === undefined) throw new FindUsageError(`missing argument to \`${pred}'`);
      return v;
    };
    const positiveInt = (pred: string): number => {
      const raw = value(pred);
      if (!/^\d+$/.test(raw)) {
        throw new FindUsageError(
          `Expected a positive decimal integer argument to ${pred}, but got \`${raw}'`,
        );
      }
      return parseInt(raw, 10);
    };

    const TRUE: FindNode = async () => true;

    /** Size in the unit's own terms: GNU rounds a partial unit UP. */
    const sizeInUnits = (bytes: number, unit: number): number =>
      unit === 1 ? bytes : Math.ceil(bytes / unit);

    const statOf = (entry: FindEntry) => {
      try { return vfs.stat(entry.vfsPath); } catch { return null; }
    };

    function parsePrimary(): FindNode {
      const tok = next();
      if (tok === undefined) throw new FindUsageError('missing expression');

      switch (tok) {
        // ── Global options: they configure the walk and evaluate true ──
        case '-maxdepth': state.maxDepth = positiveInt('-maxdepth'); return TRUE;
        case '-mindepth': state.minDepth = positiveInt('-mindepth'); return TRUE;
        case '-depth': state.depthFirst = true; return TRUE;

        // ── Tests ──
        case '-name': {
          const pattern = value('-name');
          return async (e) => globMatch(pattern, e.name);
        }
        case '-iname': {
          const pattern = value('-iname').toLowerCase();
          return async (e) => globMatch(pattern, e.name.toLowerCase());
        }
        case '-path': {
          const pattern = value('-path');
          return async (e) => globMatch(pattern, e.display);
        }
        case '-type': {
          const letter = value('-type');
          if (letter !== 'f' && letter !== 'd' && letter !== 'l') {
            throw new FindUsageError(`Unknown argument to -type: ${letter}`);
          }
          const wanted = letter === 'f' ? 'file' : letter === 'd' ? 'directory' : 'symlink';
          return async (e) => e.type === wanted;
        }
        case '-size': {
          const raw = value('-size');
          const m = raw.match(/^([+-]?)(\d+)([ckMG]?)$/);
          if (!m) throw new FindUsageError(`invalid -size type \`${raw.slice(-1)}'`);
          const cmp = m[1];
          const count = parseInt(m[2], 10);
          const unit = m[3] === 'c' ? 1
            : m[3] === 'k' ? 1024
            : m[3] === 'M' ? 1024 * 1024
            : m[3] === 'G' ? 1024 * 1024 * 1024
            : 512;
          return async (e) => {
            const st = statOf(e);
            if (!st) return false;
            const units = sizeInUnits(st.size || 0, unit);
            return cmp === '+' ? units > count : cmp === '-' ? units < count : units === count;
          };
        }
        case '-mtime': {
          const raw = value('-mtime');
          const m = raw.match(/^([+-]?)(\d+)$/);
          if (!m) throw new FindUsageError(`invalid argument \`${raw}' to \`-mtime'`);
          const cmp = m[1];
          const dayMs = 86400 * 1000;
          const threshold = parseInt(m[2], 10) * dayMs;
          const now = Date.now();
          return async (e) => {
            const st = statOf(e);
            if (!st) return false;
            const age = now - (st.mtime || 0);
            return cmp === '+' ? age > threshold + dayMs
              : cmp === '-' ? age < threshold
              : age >= threshold && age < threshold + dayMs;
          };
        }
        case '-newer': {
          const ref = value('-newer');
          let refMtime: number;
          try {
            refMtime = vfs.stat(resolvePath(ctx.cwd, ref)).mtime;
          } catch {
            throw new FindUsageError(`'${ref}': No such file or directory`);
          }
          return async (e) => {
            const st = statOf(e);
            return !!st && (st.mtime || 0) > refMtime;
          };
        }
        case '-empty':
          return async (e) => {
            if (e.type === 'directory') {
              try { return vfs.readdir(e.vfsPath).length === 0; } catch { return false; }
            }
            const st = statOf(e);
            return !!st && (st.size || 0) === 0;
          };

        // ── Actions ──
        case '-print':
          hasAction = true;
          return async (e) => { emit(e, '\n'); return true; };
        case '-print0':
          hasAction = true;
          return async (e) => { emit(e, '\0'); return true; };
        case '-delete':
          hasAction = true;
          // GNU's -delete implies -depth: a directory is removable only once
          // its children are gone.
          state.depthFirst = true;
          return async (e) => {
            try {
              if (e.type === 'directory') vfs.rmdir(e.vfsPath);
              else vfs.unlink(e.vfsPath);
              return true;
            } catch (err) {
              ctx.stderr.write(`find: cannot delete '${e.display}': ${errorText(err)}\n`);
              return false;
            }
          };
        case '-quit':
          hasAction = true;
          return async (_e, st) => { st.quit = true; return true; };
        case '-prune':
          // NOT an action: GNU still adds the implicit -print alongside it,
          // which is what makes `-prune -o -print` print everything else.
          return async (e, st) => {
            if (e.type === 'directory') st.prune = true;
            return true;
          };
        case '-exec': {
          hasAction = true;
          const argv: string[] = [];
          let terminator: ';' | '+' | null = null;
          while (pos < args.length) {
            const a = next()!;
            // Exactly `;`, as GNU requires. The usual `\;` is the shell's
            // escaping of it; a quoted '\;' keeps its backslash and GNU
            // rejects that as a missing terminator, so this does too.
            if (a === ';') { terminator = ';'; break; }
            // `+` terminates only directly after the {} placeholder.
            if (a === '+' && argv[argv.length - 1] === '{}') { terminator = '+'; break; }
            argv.push(a);
          }
          if (terminator === null) {
            throw new FindUsageError("missing argument to `-exec'");
          }
          if (terminator === ';') {
            return async (e) => runExec(argv.map((a) => a.split('{}').join(e.display)));
          }
          // `-exec … {} +`: every match joins one invocation, flushed after
          // the walk. The trailing {} is where the paths go.
          const batch: FindExecBatch = { argv: argv.slice(0, -1), pending: [] };
          execBatches.push(batch);
          return async (e) => { batch.pending.push(e.display); return true; };
        }

        // ── Grouping ──
        case '(': {
          const inner = parseExpr();
          if (next() !== ')') throw new FindUsageError("expected expression after `('");
          return inner;
        }
      }
      throw new FindUsageError(`unknown predicate \`${tok}'`);
    }

    function parseUnary(): FindNode {
      const tok = peek();
      if (tok === '!' || tok === '-not') {
        pos++;
        const operand = parseUnary();
        return async (e, st) => !(await operand(e, st));
      }
      return parsePrimary();
    }

    function parseAnd(): FindNode {
      let left = parseUnary();
      while (pos < args.length) {
        const tok = peek()!;
        if (tok === ')' || tok === '-o' || tok === '-or') break;
        if (tok === '-a' || tok === '-and') pos++;
        const right = parseUnary();
        const l = left;
        left = async (e, st) => (await l(e, st)) && (await right(e, st));
      }
      return left;
    }

    function parseExpr(): FindNode {
      let left = parseAnd();
      while (peek() === '-o' || peek() === '-or') {
        pos++;
        const right = parseAnd();
        const l = left;
        left = async (e, st) => (await l(e, st)) || (await right(e, st));
      }
      return left;
    }

    let predicate: FindNode;
    try {
      predicate = pos < args.length ? parseExpr() : TRUE;
      if (pos < args.length) {
        throw new FindUsageError(`paths must precede expression: \`${args[pos]}'`);
      }
    } catch (e) {
      if (e instanceof FindUsageError) {
        ctx.stderr.write(`find: ${e.message}\n`);
        return 1;
      }
      throw e;
    }

    // With no action anywhere in the expression the whole of it is printed;
    // -prune deliberately does not count, so `-prune -o -print` still prints.
    const test = predicate;
    if (!hasAction) {
      predicate = async (e, st) => {
        const matched = await test(e, st);
        if (matched) emit(e, '\n');
        return matched;
      };
    }

    // ── Walk ──────────────────────────────────────────────────────────────
    let status = 0;

    const visit = async (entry: FindEntry): Promise<void> => {
      state.prune = false;
      if (entry.depth >= state.minDepth) await predicate(entry, state);
    };

    const walk = async (entry: FindEntry): Promise<void> => {
      if (state.quit) return;
      // A pre-order visit must run before the descent it may prune.
      if (!state.depthFirst) {
        await visit(entry);
        if (state.quit || state.prune) return;
      }
      if (entry.type === 'directory' && entry.depth < state.maxDepth) {
        let entries: { name: string; type: string }[] = [];
        try { entries = vfs.readdir(entry.vfsPath); } catch { entries = []; }
        for (const child of entries) {
          if (state.quit) break;
          await walk({
            vfsPath: entry.vfsPath + '/' + child.name,
            display: entry.display + '/' + child.name,
            name: child.name,
            type: child.type,
            depth: entry.depth + 1,
          });
        }
      }
      // Post-order: the visit that -depth and -delete need, after the
      // children it must outlive.
      if (state.depthFirst && !state.quit) await visit(entry);
    };

    for (const startArg of startArgs) {
      if (state.quit) break;
      // `find dir/` prints `dir/empty.txt`, so the separator is not doubled.
      const display = startArg.length > 1 ? startArg.replace(/\/+$/, '') : startArg;
      const vfsPath = resolvePath(ctx.cwd, startArg);
      let type: string;
      try {
        type = vfs.stat(vfsPath).type;
      } catch {
        ctx.stderr.write(`find: '${startArg}': No such file or directory\n`);
        status = 1;
        continue;
      }
      await walk({
        vfsPath,
        display,
        name: display.split('/').pop() || display,
        type,
        depth: 0,
      });
    }

    for (const batch of execBatches) {
      if (batch.pending.length > 0) await runExec([...batch.argv, ...batch.pending]);
    }
    return status;
  };
}

/**
 * `grep`'s argv, carrying `-F` alongside it. Both spellings of the flag — its
 * own word and a letter inside a cluster — land on the parsed argv, which is
 * what the pattern escape below reads.
 */
type GrepArgv = string[] & { __fixedStrings?: boolean };

/**
 * shell compatibility (2026-05-11): grep flag handling.
 *
 * Pre-fix gaps:
 *   -c X    matched lines were printed (count mode ignored from stdin)
 *   -n      didn't prepend line number
 *   -w      word-boundary not added to regex
 *   -l      not implemented (no flag check)
 *   -E      flag parsed but didn't enable extended regex (JS RegExp
 *           already does ERE-equivalent)
 *
 * Fix: parse flags once into a struct; unify stdin + file + recursive
 * paths through a single `processLines` helper that honours every
 * flag consistently.
 */
function mkGrep(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const args: GrepArgv = [...ctx.args];
    // Parse flags. Support combined `-rni` form (single dash + chars).
    let recursive = false, ignoreCase = false, lineNum = false;
    let countOnly = false, invertMatch = false, wordMatch = false;
    let filesOnly = false;  // -l
    let quiet = false;      // -q
    let positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { positional.push(...args.slice(i + 1)); break; }
      if (a === '-r' || a === '-R' || a === '--recursive') { recursive = true; continue; }
      if (a === '-i' || a === '--ignore-case') { ignoreCase = true; continue; }
      if (a === '-n' || a === '--line-number') { lineNum = true; continue; }
      if (a === '-c' || a === '--count') { countOnly = true; continue; }
      if (a === '-v' || a === '--invert-match') { invertMatch = true; continue; }
      if (a === '-w' || a === '--word-regexp') { wordMatch = true; continue; }
      if (a === '-l' || a === '--files-with-matches') { filesOnly = true; continue; }
      if (a === '-q' || a === '--quiet' || a === '--silent') { quiet = true; continue; }
      if (a === '-E' || a === '--extended-regexp') { /* JS regex is ERE-ish */ continue; }
      if (a === '-F' || a === '--fixed-strings') {
        // Mark as literal — handled below via escape.
        args.__fixedStrings = true;
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
        // Combined short flags like -rni
        for (const ch of a.slice(1)) {
          if (ch === 'r' || ch === 'R') recursive = true;
          else if (ch === 'i') ignoreCase = true;
          else if (ch === 'n') lineNum = true;
          else if (ch === 'c') countOnly = true;
          else if (ch === 'v') invertMatch = true;
          else if (ch === 'w') wordMatch = true;
          else if (ch === 'l') filesOnly = true;
          else if (ch === 'q') quiet = true;
          else if (ch === 'E') { /* ERE noop */ }
          else if (ch === 'F') args.__fixedStrings = true;
        }
        continue;
      }
      positional.push(a);
    }
    if (positional.length < 1) { ctx.stderr.write('Usage: grep [-rnicvlqEFw] PATTERN [FILE...]\n'); return 1; }
    let pattern = positional[0];
    const targets = positional.slice(1);
    if (args.__fixedStrings) {
      // -F: escape regex metacharacters for literal match.
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    if (wordMatch) pattern = `\\b(?:${pattern})\\b`;
    const flags = ignoreCase ? 'i' : '';
    let re: RegExp;
    try { re = new RegExp(pattern, flags); } catch { ctx.stderr.write(`grep: invalid regex: ${pattern}\n`); return 1; }
    let found = false;
    let failed = false;

    function processLines(lines: string[], label: string): void {
      let count = 0;
      let matchedHere = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip a trailing empty line from a content that ended with \\n.
        if (i === lines.length - 1 && line === '') continue;
        const isMatch = re.test(line);
        if (isMatch !== invertMatch) {
          found = true;
          matchedHere = true;
          count++;
          // -q asks only whether anything matched; printing is the caller's
          // way of saying it wants to see it.
          if (quiet) return;
          if (filesOnly) {
            // -l: emit file label once, stop scanning.
            ctx.stdout.write(label + '\n');
            return;
          }
          if (!countOnly) {
            const labelPrefix = (targets.length > 1 || recursive) && label ? label + ':' : '';
            const linePrefix = lineNum ? (i + 1) + ':' : '';
            ctx.stdout.write(labelPrefix + linePrefix + line + '\n');
          }
        }
      }
      if (countOnly && !quiet) {
        const labelPrefix = (targets.length > 1 || recursive) && label ? label + ':' : '';
        ctx.stdout.write(labelPrefix + count + '\n');
      }
      void matchedHere;
    }

    function grepFile(path: string, label: string) {
      try {
        const content = vfs.readFileString(path);
        processLines(content.split('\n'), label);
      } catch (error) {
        ctx.stderr.write(`grep: ${label}: ${fsErrorMessage(error)}\n`);
        failed = true;
      }
    }
    function walkDir(dir: string) {
      try {
        for (const e of vfs.readdir(dir)) {
          const fp = dir + '/' + e.name;
          if (e.type === 'file') grepFile(fp, '/' + fp);
          else if (e.type === 'directory') walkDir(fp);
        }
      } catch {}
    }
    if (targets.length === 0 && recursive) {
      walkDir((ctx.cwd || '/home/user').replace(/^\/+/, ''));
    } else if (targets.length === 0) {
      // Read from stdin (if piped) — single virtual "file" with no label.
      const piped = stdinText(ctx);
      if (piped) {
        processLines(piped.split('\n'), '');
      }
    } else {
      for (const target of targets) {
        const fp = resolvePath(ctx.cwd, target);
        try {
          if (vfs.exists(fp) && vfs.isDirectory(fp)) {
            if (recursive) walkDir(fp);
          } else {
            grepFile(fp, target);
          }
        } catch (error) {
          ctx.stderr.write(`grep: ${target}: ${fsErrorMessage(error)}\n`);
          failed = true;
        }
      }
    }
    return !failed && found ? 0 : 1;
  };
}

/**
 * SHELL-R6-B2 follow-on: streaming head.
 *
 * When invoked on a pipeline (`producer | head`), receives a pipe
 * reader (object with .read()) — NOT a coalesced string — and reads
 * line-by-line until N lines are emitted. Closes the reader by
 * draining null (or by the SHELL-R6-2 abort cascade kicking in when
 * we return).
 *
 * Why: the original head implementation read via readAll(), which never returns when
 * upstream is `yes`. Our SHELL-R6-2 pipeline abort only fires when
 * the consumer resolves — so head must resolve quickly via its own
 * line-count termination, which then triggers the cascade.
 *
 * Backward compat: file-args (head FILE) and the string-stdin case
 * (when wrap already coalesced) still work via the same code path.
 */
function mkHead(_vfs: UnixVfs): CmdFn {
  return async (ctx) => {
    const parsed = parseHeadArgs(ctx.args);
    if (parsed.error) { ctx.stderr.write(`head: ${parsed.error}\n`); return 1; }
    const { lines: n, bytes, files } = parsed;

    if (bytes !== undefined) return headBytes(ctx, files, bytes);

    if (files.length === 0) {
      // Pipe / stdin case.
      const stdin = ctx.stdin;
      if (!stdin) return 0;
      // Streaming pipe-reader path: read chunks until N lines.
      if (typeof stdin !== 'string' && typeof stdin.read === 'function') {
        let buffered = '';
        let emitted = 0;
        const out: string[] = [];
        while (emitted < n) {
          const chunk: string | null = await stdin.read();
          if (chunk === null) break;
          buffered += chunk;
          // Process complete lines while we have them.
          while (emitted < n) {
            const nlIdx = buffered.indexOf('\n');
            if (nlIdx === -1) break;
            out.push(buffered.substring(0, nlIdx));
            buffered = buffered.substring(nlIdx + 1);
            emitted++;
          }
        }
        // Handle a partial line if N hit mid-buffer and producer hasn't
        // sent a trailing newline yet — emit it only if we haven't
        // already hit the N-line cap (POSIX head includes partial
        // tail).
        if (emitted < n && buffered.length > 0) {
          out.push(buffered);
        }
        ctx.stdout.write(out.join('\n') + '\n');
        return 0;
      }
      // Legacy string-stdin path (kept for wrap's pre-coalesced case).
      if (typeof stdin === 'string') {
        ctx.stdout.write(stdin.split('\n').slice(0, n).join('\n') + '\n');
        return 0;
      }
      return 0;
    }

    for (const [index, f] of files.entries()) {
      const path = absolutePath(ctx.cwd, f);
      try {
        const content = readWholeFileString(ctx, path);
        if (files.length > 1) ctx.stdout.write(`${index > 0 ? '\n' : ''}==> ${f} <==\n`);
        ctx.stdout.write(content.split('\n').slice(0, n).join('\n') + '\n');
      } catch (error) { ctx.stderr.write(`head: ${f}: ${fsErrorMessage(error)}\n`); return 1; }
    }
    return 0;
  };
}

type HeadArgs = { lines: number; bytes?: number; files: string[]; error?: string };

/** `-c N`, `-cN`, `--bytes=N`, `-n N`, `-nN`, `--lines=N`, `-N`, `-q`, `-v`. */
function parseHeadArgs(args: string[]): HeadArgs {
  const result: HeadArgs = { lines: 10, files: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const option = matchCountOption(arg, args[i + 1], 'c', 'bytes')
      ?? matchCountOption(arg, args[i + 1], 'n', 'lines');

    if (option) {
      i += option.consumed;
      const count = parseByteCount(option.value);
      if (count === null) {
        const what = option.flag === 'c' ? 'bytes' : 'lines';
        return { ...result, error: `invalid number of ${what}: '${option.value}'` };
      }
      if (option.flag === 'c') result.bytes = count; else result.lines = count;
    } else if (/^-\d+$/.test(arg)) {
      result.lines = Number.parseInt(arg.slice(1), 10);
    } else if (arg === '-q' || arg === '--quiet' || arg === '-v' || arg === '--verbose') {
      continue;
    } else if (arg !== '-' && arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      // A cluster of switches, `-qn 1`; `c` and `n` take the rest of the
      // cluster or the next argument.
      let consumed = false;
      for (let j = 1; j < arg.length && !consumed; j++) {
        const flag = arg[j];
        if (flag === 'q' || flag === 'v') continue;
        if (flag !== 'c' && flag !== 'n') {
          return { ...result, error: `invalid option -- '${flag}'` };
        }
        const text = arg.slice(j + 1) || (args[++i] ?? '');
        const count = parseByteCount(text);
        if (count === null) {
          const what = flag === 'c' ? 'bytes' : 'lines';
          return { ...result, error: `invalid number of ${what}: '${text}'` };
        }
        if (flag === 'c') result.bytes = count; else result.lines = count;
        consumed = true;
      }
    } else if (arg !== '-' && arg.startsWith('--')) {
      return { ...result, error: `unrecognized option '${arg}'` };
    } else {
      result.files.push(arg);
    }
  }
  return result;
}

function matchCountOption(
  arg: string,
  next: string | undefined,
  flag: string,
  long: string,
): { flag: string; value: string; consumed: number } | null {
  if (arg === `-${flag}`) return { flag, value: next ?? '', consumed: 1 };
  if (arg.startsWith(`-${flag}`) && arg.length > 2) return { flag, value: arg.slice(2), consumed: 0 };
  if (arg === `--${long}`) return { flag, value: next ?? '', consumed: 1 };
  if (arg.startsWith(`--${long}=`)) return { flag, value: arg.slice(long.length + 3), consumed: 0 };
  return null;
}

/** `head`/`dd`-style counts: plain digits with an optional binary/SI suffix. */
function parseByteCount(value: string): number | null {
  const match = /^(\d+)([bkKmMgG]?[Bb]?)$/.exec(value.trim());
  if (!match) return null;
  const scale: Record<string, number> = {
    '': 1, b: 512, k: 1024, K: 1024, kB: 1000, KB: 1000,
    m: 1024 ** 2, M: 1024 ** 2, mB: 1000 ** 2, MB: 1000 ** 2,
    g: 1024 ** 3, G: 1024 ** 3, gB: 1000 ** 3, GB: 1000 ** 3,
  };
  const factor = scale[match[2]];
  if (factor === undefined) return null;
  return Number.parseInt(match[1], 10) * factor;
}

/**
 * `head -c N` — emit the first N bytes. Streams through the positional read
 * so byte counts hold for any N and character devices such as /dev/zero,
 * which have no stored content to read whole, work like they do on Unix.
 */
async function headBytes(ctx: Ctx, files: string[], limit: number): Promise<number> {
  const writer = new SinkWriter(ctx.stdout);
  if (files.length === 0 || (files.length === 1 && files[0] === '-')) {
    await streamStdinBytes(ctx, writer, limit);
    writer.end();
    return 0;
  }

  let exit = 0;
  for (const f of files) {
    const path = absolutePath(ctx.cwd, f);
    try {
      if (files.length > 1) ctx.stdout.write(`==> ${f} <==\n`);
      streamRange((offset, length) => ctx.vfs.readRange(path, offset, length), writer, {
        length: limit,
        signal: ctx.signal,
      });
    } catch (error) {
      ctx.stderr.write(`head: ${f}: ${fsErrorMessage(error)}\n`);
      exit = 1;
    }
  }
  writer.end();
  return exit;
}

/**
 * Pull at most `limit` bytes from stdin, whether the shell handed us an
 * already-drained string or a live pipe reader. Reading only the string form
 * would make `producer | head -c N` emit nothing at all.
 */
async function streamStdinBytes(ctx: Ctx, writer: SinkWriter, limit: number): Promise<void> {
  const stdin: unknown = ctx.stdin;
  if (typeof stdin === 'string') {
    writer.write(enc.encode(stdin).subarray(0, limit));
    return;
  }
  const reader = stdin as { read?: () => Promise<string | null>; readBytes?: (n: number) => Promise<string | null> };
  if (typeof reader?.read !== 'function') return;

  let copied = 0;
  while (copied < limit) {
    const want = limit - copied;
    const chunk = reader.readBytes ? await reader.readBytes(want) : await reader.read();
    if (chunk === null) break;
    const bytes = enc.encode(chunk).subarray(0, want);
    writer.write(bytes);
    copied += bytes.length;
  }
}

/** Absolute, mount-aware path — `ctx.vfs` resolves virtual mounts like /dev. */
function absolutePath(cwd: string, target: string): string {
  return '/' + resolvePath(cwd, target);
}

function readWholeFileString(ctx: Ctx, path: string): string {
  if (ctx.vfs.stat(path).type === 'directory') {
    throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
  }
  return dec.decode(ctx.vfs.readFile(path));
}

/**
 * `tail [-n N] [-n +N] [-N] [-q] [-v] [FILE…]`.
 *
 * The previous parse only knew a separate `-n N`, matched its operand by
 * `indexOf` (so a file literally named like the count vanished), and sliced
 * the split lines without dropping the empty string a trailing newline leaves
 * behind — `tail -n 1 file` printed a blank line instead of the last line.
 */
function mkTail(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const parsed = parseTailArgs(ctx.args);
    if (parsed.error) { ctx.stderr.write(`tail: ${parsed.error}\n`); return 1; }
    const { count, fromStart, files, verbose } = parsed;

    const emit = (content: string): void => {
      const lines = content.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const selected = fromStart ? lines.slice(Math.max(0, count - 1)) : lines.slice(-count);
      if (selected.length > 0) ctx.stdout.write(selected.join('\n') + '\n');
    };

    if (files.length === 0) {
      const piped = stdinText(ctx);
      if (piped) emit(piped);
      return 0;
    }
    const label = verbose || files.length > 1;
    let exit = 0;
    for (const [index, f] of files.entries()) {
      try {
        const content = readWholeFileString(ctx, absolutePath(ctx.cwd, f));
        if (label) ctx.stdout.write(`${index > 0 ? '\n' : ''}==> ${f} <==\n`);
        emit(content);
      } catch (error) {
        ctx.stderr.write(`tail: ${f}: ${fsErrorMessage(error)}\n`);
        exit = 1;
      }
    }
    void vfs;
    return exit;
  };
}

type TailArgs = {
  count: number;
  /** `-n +N` counts forward from the first line instead of back from the last. */
  fromStart: boolean;
  files: string[];
  verbose: boolean;
  error?: string;
};

function applyTailCount(result: TailArgs, spec: string): string | null {
  const value = /^([+-]?)(\d+)$/.exec(spec.trim());
  if (value === null) return `invalid number of lines: '${spec}'`;
  result.fromStart = value[1] === '+';
  result.count = Number.parseInt(value[2], 10);
  return null;
}

function parseTailArgs(args: string[]): TailArgs {
  const result: TailArgs = { count: 10, fromStart: false, files: [], verbose: false };
  let stop = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (stop || arg === '-' || !arg.startsWith('-')) { result.files.push(arg); continue; }
    if (arg === '--') { stop = true; continue; }

    if (arg.startsWith('--lines=')) {
      const error = applyTailCount(result, arg.slice(8));
      if (error) return { ...result, error };
      continue;
    }
    if (arg === '--lines') {
      const error = applyTailCount(result, args[++i] ?? '');
      if (error) return { ...result, error };
      continue;
    }
    // `-5` is the count on its own; anything else is a cluster of short
    // options, where `n` takes the rest of the cluster or the next argument.
    if (/^-\+?\d+$/.test(arg)) {
      const error = applyTailCount(result, arg.slice(1));
      if (error) return { ...result, error };
      continue;
    }
    let consumedCount = false;
    for (let j = 1; j < arg.length && !consumedCount; j++) {
      const flag = arg[j];
      if (flag === 'q') result.verbose = false;
      else if (flag === 'v') result.verbose = true;
      else if (flag === 'n') {
        const error = applyTailCount(result, arg.slice(j + 1) || (args[++i] ?? ''));
        if (error) return { ...result, error };
        consumedCount = true;
      } else return { ...result, error: `invalid option -- '${flag}'` };
    }
  }
  return result;
}

const WC_SPEC = {
  lines: { type: 'boolean' as const, short: 'l' },
  words: { type: 'boolean' as const, short: 'w' },
  bytes: { type: 'boolean' as const, short: 'c' },
  chars: { type: 'boolean' as const, short: 'm' },
};

function mkWc(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const { flags: parsed, positional, unknown } = parseArgs(ctx.args, WC_SPEC);
    if (unknown.length > 0) {
      ctx.stderr.write(`wc: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
      return 1;
    }
    const hasFlags = parsed.lines === true || parsed.words === true
      || parsed.bytes === true || parsed.chars === true;
    const selected = {
      lines: !hasFlags || parsed.lines === true,
      words: !hasFlags || parsed.words === true,
      bytes: !hasFlags || parsed.bytes === true || parsed.chars === true,
    };
    const columns = Number(selected.lines) + Number(selected.words) + Number(selected.bytes);
    const files = positional;

    // BUG-SWEEP-3 (2026-05-11): the byte count is the raw Uint8Array length,
    // not enc.encode(decoded).length — decoding a binary file substitutes
    // U+FFFD for each invalid byte and re-encoding turns one byte into three.
    const measure = (rawBytes: Uint8Array): number[] => {
      const text = selected.lines || selected.words
        ? new TextDecoder('utf-8').decode(rawBytes)
        : '';
      const counts: number[] = [];
      if (selected.lines) counts.push(text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
      if (selected.words) counts.push(text.split(/\s+/).filter(Boolean).length);
      if (selected.bytes) counts.push(rawBytes.length);
      return counts;
    };

    const emit = (counts: number[], width: number, label: string): void => {
      ctx.stdout.write(
        counts.map((c) => String(c).padStart(width)).join(' ') + (label ? ' ' + label : '') + '\n',
      );
    };

    if (files.length === 0) {
      const bytes = enc.encode(stdinText(ctx) ?? '');
      // Nothing bounds a stream's counts ahead of time, so a multi-column
      // report over standard input uses the fixed width GNU falls back to.
      emit(measure(bytes), columns === 1 ? 0 : 7, '');
      return 0;
    }

    const read: Array<{ label: string; bytes: Uint8Array }> = [];
    let exit = 0;
    for (const f of files) {
      try {
        read.push({ label: f, bytes: vfs.readFile(resolvePath(ctx.cwd, f)) });
      } catch {
        ctx.stderr.write(`wc: ${f}: No such file\n`);
        exit = 1;
      }
    }

    // A file's size bounds every count it can produce, which is the width GNU
    // lays the columns out to. One column of one file needs no padding.
    const width = columns === 1 && read.length <= 1
      ? 1
      : Math.max(1, ...read.map((entry) => String(entry.bytes.length).length));

    const totals = new Array(columns).fill(0);
    for (const entry of read) {
      const counts = measure(entry.bytes);
      counts.forEach((count, i) => { totals[i] += count; });
      emit(counts, width, entry.label);
    }
    if (read.length > 1) emit(totals, width, 'total');
    return exit;
  };
}

const SORT_SPEC = {
  reverse: { type: 'boolean' as const, short: 'r' },
  numeric: { type: 'boolean' as const, short: 'n' },
  unique: { type: 'boolean' as const, short: 'u' },
  'ignore-case': { type: 'boolean' as const, short: 'f' },
};

function mkSort(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, SORT_SPEC);
    if (unknown.length > 0) {
      ctx.stderr.write(`sort: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
      return 1;
    }
    let input = stdinText(ctx) || '';
    if (positional.length > 0 && !input) {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, positional[0])); }
      catch { ctx.stderr.write(`sort: ${positional[0]}: No such file\n`); return 1; }
    }
    const lines = input.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const numeric = flags.numeric === true;
    const fold = flags['ignore-case'] === true;
    const key = (line: string): string => (fold ? line.toLowerCase() : line);
    lines.sort((a, b) => (numeric
      ? (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0)
      : key(a).localeCompare(key(b))));
    if (flags.reverse) lines.reverse();
    // -u drops adjacent duplicates after sorting, so it compares by the same
    // key the sort used rather than by the whole line.
    const result = flags.unique
      ? lines.filter((line, i) => i === 0 || compareSortKeys(lines[i - 1], line, numeric, fold) !== 0)
      : lines;
    if (result.length > 0) ctx.stdout.write(result.join('\n') + '\n');
    return 0;
  };
}

function compareSortKeys(a: string, b: string, numeric: boolean, fold: boolean): number {
  if (numeric) return (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0);
  return fold ? a.toLowerCase().localeCompare(b.toLowerCase()) : a.localeCompare(b);
}

const UNIQ_SPEC = {
  count: { type: 'boolean' as const, short: 'c' },
  repeated: { type: 'boolean' as const, short: 'd' },
  unique: { type: 'boolean' as const, short: 'u' },
  'ignore-case': { type: 'boolean' as const, short: 'i' },
};

function mkUniq(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, UNIQ_SPEC);
    if (unknown.length > 0) {
      ctx.stderr.write(`uniq: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
      return 1;
    }
    // File operands were ignored outright, so `uniq file` read stdin and
    // printed nothing at all.
    let input = stdinText(ctx) || '';
    if (positional.length > 0 && positional[0] !== '-') {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, positional[0])); }
      catch { ctx.stderr.write(`uniq: ${positional[0]}: No such file\n`); return 1; }
    }
    const lines = input.split('\n');
    const countFlag = flags.count === true;
    const dupsOnly = flags.repeated === true;
    const uniquesOnly = flags.unique === true;
    const fold = flags['ignore-case'] === true;
    if (lines[lines.length - 1] === '') lines.pop();

    const same = (a: string, b: string): boolean =>
      fold ? a.toLowerCase() === b.toLowerCase() : a === b;
    const result: string[] = [];
    const flush = (line: string, count: number): void => {
      if (dupsOnly && count < 2) return;
      if (uniquesOnly && count > 1) return;
      result.push(countFlag ? `${String(count).padStart(7)} ${line}` : line);
    };

    let prev: string | null = null;
    let count = 0;
    for (const line of lines) {
      if (prev !== null && same(line, prev)) { count++; continue; }
      if (prev !== null) flush(prev, count);
      prev = line;
      count = 1;
    }
    if (prev !== null) flush(prev, count);

    if (result.length > 0) ctx.stdout.write(result.join('\n') + '\n');
    return 0;
  };
}

function mkSed(vfs: UnixVfs): CmdFn {
  return (ctx) => runSed({
    args: ctx.args,
    cwd: ctx.cwd,
    vfs,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    stdin: typeof ctx.stdin === 'string' ? stringInput(ctx.stdin) : undefined,
  });
}

function stringInput(text: string): { readAll(): Promise<string> } {
  return {
    readAll: async () => text,
  };
}

/**
 * What an awk expression evaluates to. The subset below has neither arrays nor
 * a match operator, so every value is one of the two scalars awk itself has,
 * and `print` decides which spelling to use.
 */
type AwkValue = string | number;

/**
 * shell compatibility (2026-05-11): expanded awk subset.
 *
 * Pre-fix mkAwk supported only:
 *   {print $N}
 *   /pattern/ [{print}]
 * Anything else → 'awk: unsupported program'.
 *
 * This extension adds (all in pure JS — no embedded awk-interpreter):
 *   BEGIN { stmts }     — run before any input line
 *   END   { stmts }     — run after last line
 *   /pat/ { stmts }     — per-line conditional action
 *   { stmts }           — per-line unconditional action
 *   $0, $1..$N, $NF     — field refs in any expression
 *   NR, NF              — record number, field count
 *   print EXPR          — write EXPR to stdout + newline (comma-sep)
 *   printf "fmt", a, b  — printf-style (%s %d %f %x %o + width.prec)
 *   sum += $N           — assignment + compound
 *   simple arithmetic   — + - * / % () in expression position
 *   numeric literals    — integers and decimals
 *   string literals     — "..."
 *   user vars           — assigned via name = expr or compound
 *
 * NOT supported:
 *   - for/while/if (control flow)
 *   - functions
 *   - arrays (assoc / indexed)
 *   - getline
 *   - regex match operator ~/!~ outside pattern position
 *
 * The eval engine is a tiny stmt-list runner that compiles each
 * statement to a JS closure operating on a shared state {vars,
 * fields[], NR, NF, separator, stdout, stderr}. Statements are
 * separated by `;` or `\\n`.
 *
 * Failure mode: if we can't parse a statement, write a clear error
 * to stderr and exit 1 (no silent fail).
 */
function mkAwk(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const allArgs = ctx.args;
    // Parse -F separator if present.
    let separator: string | RegExp = /\s+/;
    const programArgs: string[] = [];
    const fileArgs: string[] = [];
    for (let i = 0; i < allArgs.length; i++) {
      const a = allArgs[i];
      if (a === '-F') {
        const s = allArgs[++i];
        if (s) separator = s.length === 1 ? s : new RegExp(s);
      } else if (a.startsWith('-F')) {
        const s = a.slice(2);
        if (s) separator = s.length === 1 ? s : new RegExp(s);
      } else if (a.startsWith('-')) {
        // Ignore other flags (silent compat).
      } else if (programArgs.length === 0) {
        programArgs.push(a);
      } else {
        fileArgs.push(a);
      }
    }
    const program = programArgs[0] || '';
    let input = stdinText(ctx) || '';
    if (fileArgs.length > 0 && !input) {
      try { input = vfs.readFileString(resolvePath(ctx.cwd, fileArgs[0])); }
      catch { ctx.stderr.write(`awk: ${fileArgs[0]}: No such file\n`); return 1; }
    }

    // ── Parse program into blocks. ──
    // Block forms:
    //   BEGIN { stmts }
    //   END   { stmts }
    //   /pat/ { stmts }
    //   /pat/                    (implicit { print })
    //   { stmts }
    // Multiple blocks may appear (separated by whitespace/newlines).
    interface Block { kind: 'BEGIN' | 'END' | 'PATTERN' | 'MAIN'; pattern?: RegExp; body: string }
    const blocks: Block[] = [];
    let cursor = 0;
    const src = program.trim();
    function skipWS() {
      while (cursor < src.length && /\s/.test(src[cursor])) cursor++;
    }
    function parseBraced(): string {
      // Assumes src[cursor] === '{'
      let depth = 0;
      let start = cursor;
      while (cursor < src.length) {
        const ch = src[cursor];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { cursor++; return src.slice(start + 1, cursor - 1); } }
        else if (ch === '"' || ch === "'") {
          const quote = ch;
          cursor++;
          while (cursor < src.length && src[cursor] !== quote) {
            if (src[cursor] === '\\') cursor++;
            cursor++;
          }
        }
        cursor++;
      }
      return src.slice(start + 1, cursor);
    }
    while (cursor < src.length) {
      skipWS();
      if (cursor >= src.length) break;
      if (src.startsWith('BEGIN', cursor)) {
        cursor += 5;
        skipWS();
        if (src[cursor] !== '{') { ctx.stderr.write('awk: BEGIN without {\n'); return 1; }
        blocks.push({ kind: 'BEGIN', body: parseBraced() });
        continue;
      }
      if (src.startsWith('END', cursor)) {
        cursor += 3;
        skipWS();
        if (src[cursor] !== '{') { ctx.stderr.write('awk: END without {\n'); return 1; }
        blocks.push({ kind: 'END', body: parseBraced() });
        continue;
      }
      if (src[cursor] === '/') {
        // Pattern /pat/ optionally followed by {body}
        const pstart = cursor + 1;
        cursor++;
        while (cursor < src.length && src[cursor] !== '/') {
          if (src[cursor] === '\\') cursor++;
          cursor++;
        }
        const patSrc = src.slice(pstart, cursor);
        cursor++; // past closing /
        skipWS();
        let body = 'print';
        if (cursor < src.length && src[cursor] === '{') body = parseBraced();
        let re: RegExp;
        try { re = new RegExp(patSrc); }
        catch (e) { ctx.stderr.write(`awk: bad regex /${patSrc}/: ${errorText(e)}\n`); return 1; }
        blocks.push({ kind: 'PATTERN', pattern: re, body });
        continue;
      }
      if (src[cursor] === '{') {
        blocks.push({ kind: 'MAIN', body: parseBraced() });
        continue;
      }
      ctx.stderr.write(`awk: parse error at "${src.slice(cursor, cursor + 20)}"\n`);
      return 1;
    }

    // ── Statement evaluator. ──
    // The evaluator processes a body string by splitting on `;` or
    // newline, then executes each statement against a state record.
    // Each statement is matched against shapes:
    //   print EXPR[, EXPR]*    OR  print
    //   printf "fmt", EXPR, …
    //   IDENT = EXPR
    //   IDENT (+|-|*|/|%)= EXPR
    //   next  (skip rest of body for this line — rare)
    interface State {
      vars: Record<string, AwkValue>;
      fields: string[];  // [$0, $1, $2, ...]
      NR: number;
      NF: number;
      printed: boolean;
    }
    /**
     * Expression evaluator without `new Function`. workerd CSP blocks
     * dynamic code generation at request time. This is a small
     * recursive-descent evaluator for the subset:
     *   - literals: number, string ("...")
     *   - field refs: $0, $N, $NF
     *   - builtins: NR, NF
     *   - user vars: identifier (looked up in st.vars; default 0)
     *   - binary ops: + - * / % (numeric)
     *   - parens: (expr)
     *   - string concat happens via space-join in `print` call sites
     *
     * The grammar:
     *   expr     := term (('+'|'-') term)*
     *   term     := factor (('*'|'/'|'%') factor)*
     *   factor   := number | string | '$' (number | 'NF') | ident | '(' expr ')'
     */
    function evalExpr(expr: string, st: State): AwkValue {
      const text = expr.trim();
      let pos = 0;
      function skipWs() { while (pos < text.length && /\s/.test(text[pos])) pos++; }
      function peek(): string { return text[pos]; }
      function consume(ch: string): boolean { skipWs(); if (text[pos] === ch) { pos++; return true; } return false; }
      function expect(ch: string): void { if (!consume(ch)) throw new Error(`expected '${ch}' at "${text.slice(pos, pos + 20)}"`); }
      function parseExpr(): AwkValue {
        let left = parseTerm();
        for (;;) {
          skipWs();
          const op = text[pos];
          if (op === '+' || op === '-') {
            pos++;
            const right = parseTerm();
            const ln = toNum(left), rn = toNum(right);
            left = op === '+' ? ln + rn : ln - rn;
          } else break;
        }
        return left;
      }
      function parseTerm(): AwkValue {
        let left = parseFactor();
        for (;;) {
          skipWs();
          const op = text[pos];
          if (op === '*' || op === '/' || op === '%') {
            pos++;
            const right = parseFactor();
            const ln = toNum(left), rn = toNum(right);
            left = op === '*' ? ln * rn : op === '/' ? ln / rn : ln % rn;
          } else break;
        }
        return left;
      }
      function parseFactor(): AwkValue {
        skipWs();
        if (pos >= text.length) throw new Error(`unexpected end of expression`);
        const ch = text[pos];
        // Number
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[pos + 1]))) {
          let start = pos;
          while (pos < text.length && /[0-9.]/.test(text[pos])) pos++;
          return parseFloat(text.slice(start, pos));
        }
        // String literal (double or single quotes)
        if (ch === '"' || ch === "'") {
          const quote = ch;
          pos++;
          let s = '';
          while (pos < text.length && text[pos] !== quote) {
            if (text[pos] === '\\' && pos + 1 < text.length) {
              const esc = text[pos + 1];
              s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === "'" ? "'" : esc;
              pos += 2;
            } else {
              s += text[pos];
              pos++;
            }
          }
          if (pos < text.length) pos++; // skip closing quote
          return s;
        }
        // Parenthesised
        if (ch === '(') {
          pos++;
          const v = parseExpr();
          expect(')');
          return v;
        }
        // Unary minus
        if (ch === '-') {
          pos++;
          return -toNum(parseFactor());
        }
        // Unary plus
        if (ch === '+') {
          pos++;
          return toNum(parseFactor());
        }
        // Field ref: $N or $NF
        if (ch === '$') {
          pos++;
          skipWs();
          if (text.startsWith('NF', pos)) {
            pos += 2;
            return st.fields[st.NF] ?? '';
          }
          // Parens around index? $($1+1) etc — not supported, just digits.
          let nStart = pos;
          while (pos < text.length && /[0-9]/.test(text[pos])) pos++;
          if (nStart === pos) throw new Error(`expected field index after $ at "${text.slice(pos, pos + 10)}"`);
          const idx = parseInt(text.slice(nStart, pos), 10);
          return st.fields[idx] ?? '';
        }
        // Identifier: NR, NF, user var
        if (/[A-Za-z_]/.test(ch)) {
          let start = pos;
          while (pos < text.length && /[A-Za-z0-9_]/.test(text[pos])) pos++;
          const name = text.slice(start, pos);
          if (name === 'NR') return st.NR;
          if (name === 'NF') return st.NF;
          return st.vars[name] !== undefined ? st.vars[name] : 0;
        }
        throw new Error(`unexpected '${ch}' at "${text.slice(pos, pos + 20)}"`);
      }
      function toNum(v: AwkValue): number {
        if (typeof v === 'number') return v;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      }
      try {
        const v = parseExpr();
        skipWs();
        if (pos < text.length) {
          // Trailing junk — could be intentional (e.g. tail of stmt is
          // separator). Be permissive — return what we have.
        }
        return v;
      } catch (e) {
        throw new Error(`expr error: ${errorText(e)} in "${expr}"`);
      }
    }
    function stripStringsForScan(s: string): string {
      // Replace string contents with same-length spaces so positions stay aligned.
      let out = '';
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          out += ch;
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') { out += ' '; i++; }
            out += ' ';
            i++;
          }
          if (i < s.length) { out += ch; i++; }
        } else {
          out += ch;
          i++;
        }
      }
      return out;
    }
    function remapUserVars(s: string): string {
      // Find identifiers (a-z_), skip ones that are reserved or already
      // remapped. The simple approach: scan tokens outside string
      // literals.
      const RESERVED = new Set([
        '__f', '__nr', '__nf', '__v',
        'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
        'Math', 'String', 'Number', 'Array', 'Object',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite',
        'length',  // for str/array .length access — not a free identifier here
      ]);
      let out = '';
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          out += ch;
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') { out += s[i]; i++; }
            out += s[i]; i++;
          }
          if (i < s.length) { out += s[i]; i++; }
          continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
          let start = i;
          while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++;
          const ident = s.slice(start, i);
          // Skip if previous non-ws char is `.` (member access).
          let prev = start - 1;
          while (prev >= 0 && /\s/.test(out[prev])) prev--;
          if (out[prev] === '.') { out += ident; continue; }
          if (RESERVED.has(ident)) { out += ident; continue; }
          // Replace with (__v.ident !== undefined ? __v.ident : 0)
          out += `(__v.${ident}!==undefined?__v.${ident}:0)`;
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }
    function splitStmts(body: string): string[] {
      const stmts: string[] = [];
      let depth = 0;
      let cur = '';
      let i = 0;
      while (i < body.length) {
        const ch = body[i];
        if (ch === '"' || ch === "'") {
          cur += ch;
          i++;
          while (i < body.length && body[i] !== ch) {
            if (body[i] === '\\') { cur += body[i]; i++; }
            cur += body[i]; i++;
          }
          if (i < body.length) { cur += body[i]; i++; }
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (depth === 0 && (ch === ';' || ch === '\n')) {
          const t = cur.trim();
          if (t) stmts.push(t);
          cur = '';
          i++;
          continue;
        }
        cur += ch;
        i++;
      }
      const t = cur.trim();
      if (t) stmts.push(t);
      return stmts;
    }
    function execStmt(stmt: string, st: State): void {
      // print [expr[, expr]*]
      if (stmt === 'print' || stmt.startsWith('print ') || stmt.startsWith('print\t')) {
        const rest = stmt.slice(5).trim();
        if (!rest) { ctx.stdout.write(st.fields[0] + '\n'); st.printed = true; return; }
        // Comma-separated exprs (space joiner). We must split at top-level commas only.
        const parts = splitTopLevel(rest, ',');
        const out = parts.map(p => stringify(evalExpr(p, st))).join(' ');
        ctx.stdout.write(out + '\n');
        st.printed = true;
        return;
      }
      // printf "fmt", arg, arg, ...
      if (stmt.startsWith('printf ') || stmt.startsWith('printf(')) {
        let rest = stmt.startsWith('printf(') ? stmt.slice(7).replace(/\)\s*$/, '') : stmt.slice(7);
        rest = rest.trim();
        const parts = splitTopLevel(rest, ',');
        if (parts.length === 0) return;
        const fmt = evalExpr(parts[0], st);
        const fargs = parts.slice(1).map(p => evalExpr(p, st));
        ctx.stdout.write(printfFormat(String(fmt), fargs));
        st.printed = true;
        return;
      }
      // next: skip rest of body (no-op here since we re-enter each block fresh)
      if (stmt === 'next') return;
      // assignment: IDENT [op]= EXPR
      // We require a top-level `=` not part of `==` `<=` `>=` `!=`.
      const eqIdx = findAssignmentEq(stmt);
      if (eqIdx > 0) {
        const lhs = stmt.slice(0, eqIdx).trim();
        const rhs = stmt.slice(eqIdx + 1).trim();
        // Compound: lhs ends with op (e.g. `sum +`).
        let op: string | null = null;
        let name = lhs;
        if (/[+\-*/%]$/.test(lhs)) {
          op = lhs[lhs.length - 1];
          name = lhs.slice(0, -1).trim();
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(`bad assignment target "${name}"`);
        }
        const rv = evalExpr(rhs, st);
        if (op) {
          const cur = st.vars[name] !== undefined ? st.vars[name] : 0;
          const lhsNum = typeof cur === 'number' ? cur : parseFloat(cur);
          const rvNum = typeof rv === 'number' ? rv : parseFloat(rv);
          const lN = Number.isFinite(lhsNum) ? lhsNum : 0;
          const rN = Number.isFinite(rvNum) ? rvNum : 0;
          st.vars[name] =
            op === '+' ? lN + rN :
            op === '-' ? lN - rN :
            op === '*' ? lN * rN :
            op === '/' ? lN / rN :
            op === '%' ? lN % rN : rv;
        } else {
          st.vars[name] = rv;
        }
        return;
      }
      // Bare expression — evaluate for side effects (rare in awk).
      evalExpr(stmt, st);
    }
    function findAssignmentEq(s: string): number {
      let depth = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') i++;
            i++;
          }
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (depth === 0 && ch === '=') {
          const next = s[i + 1];
          const prev = s[i - 1];
          if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
          return i;
        }
      }
      return -1;
    }
    function splitTopLevel(s: string, sep: string): string[] {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      let i = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          cur += ch;
          i++;
          while (i < s.length && s[i] !== ch) {
            if (s[i] === '\\') { cur += s[i]; i++; }
            cur += s[i]; i++;
          }
          if (i < s.length) { cur += s[i]; i++; }
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (depth === 0 && ch === sep) { out.push(cur.trim()); cur = ''; i++; continue; }
        cur += ch; i++;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
    function stringify(v: AwkValue | null | undefined): string {
      if (v === undefined || v === null) return '';
      if (typeof v === 'number') {
        if (Number.isInteger(v)) return String(v);
        // awk's OFMT default is "%.6g"
        return printfFormat('%.6g', [v]);
      }
      return String(v);
    }
    function printfFormat(fmt: string, fargs: AwkValue[]): string {
      let out = '';
      let i = 0;
      let argIdx = 0;
      while (i < fmt.length) {
        const ch = fmt[i];
        if (ch === '\\' && i + 1 < fmt.length) {
          const esc = fmt[i + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc;
          i += 2;
          continue;
        }
        if (ch === '%' && i + 1 < fmt.length) {
          // Parse: %[flags][width][.prec]specifier
          let spec = '%';
          i++;
          while (i < fmt.length && /[-+ 0#]/.test(fmt[i])) { spec += fmt[i]; i++; }
          while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; }
          if (fmt[i] === '.') { spec += fmt[i]; i++; while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; } }
          const conv = fmt[i];
          i++;
          if (conv === '%') { out += '%'; continue; }
          const arg = fargs[argIdx++];
          out += formatOne(spec + conv, arg);
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }
    function formatOne(spec: string, arg: AwkValue): string {
      const conv = spec[spec.length - 1];
      const flagsAndWidth = spec.slice(1, -1);
      const dotIdx = flagsAndWidth.indexOf('.');
      const widthPart = dotIdx >= 0 ? flagsAndWidth.slice(0, dotIdx) : flagsAndWidth;
      const precPart = dotIdx >= 0 ? flagsAndWidth.slice(dotIdx + 1) : '';
      let flags = '';
      let widthStr = '';
      for (const c of widthPart) {
        if (/[-+ 0#]/.test(c)) flags += c;
        else widthStr += c;
      }
      const width = widthStr ? parseInt(widthStr, 10) : 0;
      const prec = precPart ? parseInt(precPart, 10) : -1;
      let body: string;
      switch (conv) {
        case 's': body = String(arg ?? ''); if (prec >= 0) body = body.slice(0, prec); break;
        case 'd': case 'i': {
          const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(arg));
          body = String(Number.isFinite(n) ? n : 0);
          break;
        }
        case 'f': {
          const n = typeof arg === 'number' ? arg : parseFloat(arg);
          const p = prec < 0 ? 6 : prec;
          body = (Number.isFinite(n) ? n : 0).toFixed(p);
          break;
        }
        case 'g': {
          const n = typeof arg === 'number' ? arg : parseFloat(arg);
          const p = prec < 0 ? 6 : prec;
          body = (Number.isFinite(n) ? n : 0).toPrecision(p).replace(/\.?0+$/, '');
          break;
        }
        case 'x': {
          const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(arg));
          body = (Number.isFinite(n) ? n : 0).toString(16);
          break;
        }
        case 'o': {
          const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(arg));
          body = (Number.isFinite(n) ? n : 0).toString(8);
          break;
        }
        case 'c': {
          if (typeof arg === 'number') body = String.fromCharCode(arg);
          else body = String(arg).charAt(0);
          break;
        }
        default: body = String(arg);
      }
      if (width > body.length) {
        const pad = flags.includes('0') && (conv === 'd' || conv === 'i' || conv === 'f' || conv === 'x' || conv === 'o') ? '0' : ' ';
        body = flags.includes('-') ? body.padEnd(width, ' ') : body.padStart(width, pad);
      }
      return body;
    }

    const state: State = {
      vars: {},
      fields: [],
      NR: 0,
      NF: 0,
      printed: false,
    };

    function runBlock(block: Block): void {
      const stmts = splitStmts(block.body);
      for (const s of stmts) {
        execStmt(s, state);
      }
    }

    try {
      // BEGIN blocks first.
      for (const b of blocks) if (b.kind === 'BEGIN') runBlock(b);
      // Main loop over input lines.
      const lines = input.split('\n');
      // awk default: drop the final empty line if input ended with \n.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const parts = typeof separator === 'string' && separator.length === 1
          ? line.split(separator)
          : line.split(separator);
        state.NR = li + 1;
        state.NF = parts.filter(p => p !== '').length;
        state.fields = [line, ...parts];
        for (const b of blocks) {
          if (b.kind === 'BEGIN' || b.kind === 'END') continue;
          if (b.kind === 'PATTERN') {
            if (b.pattern!.test(line)) runBlock(b);
          } else {
            // MAIN block (no pattern) — always runs.
            runBlock(b);
          }
        }
      }
      // END blocks last.
      for (const b of blocks) if (b.kind === 'END') runBlock(b);
    } catch (e) {
      ctx.stderr.write(`awk: ${errorText(e)}\n`);
      return 1;
    }

    return 0;
  };
}

/**
 * shell compatibility (2026-05-11): real xargs implementation.
 *
 * Pre-fix the impl printed the command-line it WOULD execute and
 * returned 0. Real xargs runs the command, possibly batched (-n),
 * with arguments substituted (-I).
 *
 * We do cross-command dispatch through the shell registry, so xargs can drive
 * `echo`, `cat`, `rm`, `seq`, lazy-loaded builtins — anything in the registry. The execution
 * runs IN-SUPERVISOR (not through facet spawn) which means it
 * works for pure-builtins but NOT for facet-direct commands like
 * `node`, `git`, `npm` (the registry resolver returns those by
 * name but invoking them requires the cp/facet pipeline).
 *
 * Supported flags:
 *   -n NUM        run command with at most NUM args per invocation
 *   -I REPL       replace REPL in command with the input item
 *   -0            null-byte separator (rare; bash xargs -0 idiom)
 *   default args  use args.split(/\s+/) from stdin
 *
 * Unsupported (document as gap): -P (parallel), -L (per-line), -p (prompt).
 */
function mkXargs(vfs: UnixVfs, registry: UnixCommandRegistry): CmdFn {
  return async (ctx) => {
    // NOT trimmed: `-0` exists so a name may carry the whitespace a split
    // would eat, and trimming the stream rewrites its first and last item.
    // The default split already drops the empties a trim would have removed.
    const input = stdinText(ctx) || '';
    if (!input) return 0;

    // Parse flags first
    const args = [...ctx.args];
    let batchSize = Infinity;
    let replaceTok: string | null = null;
    let nullSep = false;
    while (args.length > 0 && args[0].startsWith('-')) {
      const a = args.shift()!;
      if (a === '-n') {
        const n = parseInt(args.shift() || '', 10);
        if (Number.isFinite(n) && n > 0) batchSize = n;
      } else if (a.startsWith('-n')) {
        const n = parseInt(a.slice(2), 10);
        if (Number.isFinite(n) && n > 0) batchSize = n;
      } else if (a === '-I') {
        replaceTok = args.shift() || '{}';
        batchSize = 1; // -I implies one-arg-per-invocation
      } else if (a === '-0' || a === '--null') {
        nullSep = true;
      } else if (a === '--') {
        break;
      } else {
        // Unknown flag — push back as cmd token (best-effort behavior)
        args.unshift(a);
        break;
      }
    }

    // Remaining args: cmd + initial-args. Default: echo.
    const cmdName = args.shift() || 'echo';
    const cmdArgsInitial = args;

    // Split stdin into items
    const items = nullSep
      ? input.split('\u0000').filter(Boolean)
      : input.split(/\s+/).filter(Boolean);

    // Resolve target command from registry (handles both eager + lazy maps).
    let target: ResolvedCommand | null;
    try {
      target = asResolvedCommand(await registry.resolve(cmdName));
    } catch { target = null; }
    if (!target) {
      // Defer to write-to-stderr; mimic real xargs which would exec(2) and fail.
      ctx.stderr.write(`xargs: ${cmdName}: command not found\n`);
      return 127;
    }

    // Run in batches.
    const newCtx = (newArgs: string[]) => ({
      pid: ctx.pid,
      cred: ctx.cred,
      args: newArgs,
      env: ctx.env,
      cwd: ctx.cwd,
      vfs: ctx.vfs,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      stdin: '',  // xargs doesn't pipe its own stdin to children
      signal: ctx.signal,
      setUmask: ctx.setUmask,
      runAs: ctx.runAs,
      execInterpreterDepth: ctx.execInterpreterDepth,
    });

    let exit = 0;
    if (replaceTok) {
      // -I: one invocation per item, replacing token in initial args.
      for (const item of items) {
        const subbed = cmdArgsInitial.map(a => a.split(replaceTok!).join(item));
        try {
          const code = await target(newCtx(subbed));
          if (typeof code === 'number' && code !== 0) exit = code;
        } catch (e) {
          ctx.stderr.write(`xargs: ${cmdName}: ${errorText(e)}\n`);
          exit = 1;
        }
      }
    } else {
      // -n N (or unlimited): batch items, append to initial args.
      const step = Number.isFinite(batchSize) ? batchSize : items.length;
      for (let i = 0; i < items.length; i += step) {
        const batch = items.slice(i, i + step);
        try {
          const code = await target(newCtx([...cmdArgsInitial, ...batch]));
          if (typeof code === 'number' && code !== 0) exit = code;
        } catch (e) {
          ctx.stderr.write(`xargs: ${cmdName}: ${errorText(e)}\n`);
          exit = 1;
        }
        if (!Number.isFinite(batchSize)) break;  // single batch when no -n
      }
    }
    return exit;
  };
}

function mkTee(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const input = stdinText(ctx) || '';
    const append = ctx.args.includes('-a');
    const files = ctx.args.filter(a => !a.startsWith('-'));
    ctx.stdout.write(input);
    for (const f of files) {
      const fp = resolvePath(ctx.cwd, f);
      if (append && vfs.exists(fp)) {
        const existing = vfs.readFileString(fp);
        vfs.writeFile(fp, existing + input);
      } else {
        vfs.writeFile(fp, input);
      }
    }
    return 0;
  };
}

/**
 * shell compatibility (2026-05-11): du flag parsing for combined forms.
 * Pre-fix `du -sh` didn't activate -h because we checked for literal
 * `-h` only — `-sh` is a single arg containing both flags. POSIX
 * conformant short-flag stacking.
 */
function mkDu(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    // Parse flags supporting stacked short flags like `-sh`, `-ah`.
    let showAll = false, human = false, sumOnly = false;
    const positional: string[] = [];
    for (const a of ctx.args) {
      if (a.startsWith('-') && a !== '-' && !a.startsWith('--')) {
        for (const ch of a.slice(1)) {
          if (ch === 'a') showAll = true;
          else if (ch === 'h') human = true;
          else if (ch === 's') sumOnly = true;
        }
      } else if (a.startsWith('--')) {
        if (a === '--all') showAll = true;
        else if (a === '--human-readable') human = true;
        else if (a === '--summarize') sumOnly = true;
      } else {
        positional.push(a);
      }
    }
    const target = positional[0] || '.';
    const root = resolvePath(ctx.cwd, target);
    const fmt = (b: number) => human ? (b >= 1e6 ? (b / 1e6).toFixed(1) + 'M' : b >= 1e3 ? (b / 1e3).toFixed(1) + 'K' : b + 'B') : String(Math.ceil(b / 1024));
    let total = 0;
    function walk(path: string): number {
      let size = 0;
      try {
        const entries = vfs.readdir(path);
        for (const e of entries) {
          const fp = path + '/' + e.name;
          if (e.type === 'directory') {
            const dirSize = walk(fp);
            size += dirSize;
            if (!sumOnly) ctx.stdout.write(`${fmt(dirSize)}\t/${fp}\n`);
          } else {
            try {
              const st = vfs.stat(fp);
              size += st.size;
              if (showAll && !sumOnly) ctx.stdout.write(`${fmt(st.size)}\t/${fp}\n`);
            } catch {}
          }
        }
      } catch {}
      return size;
    }
    total = walk(root);
    if (sumOnly || !showAll) ctx.stdout.write(`${fmt(total)}\t/${root}\n`);
    return 0;
  };
}

function mkDiff(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    if (ctx.args.length < 2) { ctx.stderr.write('Usage: diff FILE1 FILE2\n'); return 1; }
    const f1 = resolvePath(ctx.cwd, ctx.args[0]);
    const f2 = resolvePath(ctx.cwd, ctx.args[1]);
    try {
      const a = vfs.readFileString(f1).split('\n');
      const b = vfs.readFileString(f2).split('\n');
      let hasDiff = false;
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        if (a[i] !== b[i]) {
          hasDiff = true;
          if (a[i] !== undefined && b[i] === undefined) ctx.stdout.write(`${i + 1}d${i}\n< ${a[i]}\n`);
          else if (a[i] === undefined && b[i] !== undefined) ctx.stdout.write(`${i}a${i + 1}\n> ${b[i]}\n`);
          else ctx.stdout.write(`${i + 1}c${i + 1}\n< ${a[i]}\n---\n> ${b[i]}\n`);
        }
      }
      return hasDiff ? 1 : 0;
    } catch (e) {
      // `diff` reports the thrown value's `message`, whatever it holds, rather
      // than the value: a throw carrying none has always printed `undefined`.
      const message = typeof e === 'object' && e !== null && 'message' in e ? e.message : undefined;
      ctx.stderr.write(`diff: ${String(message)}\n`);
      return 2;
    }
  };
}

/**
 * shell compatibility (2026-05-11): POSIX rm with proper -f semantics.
 *
 * The original rm implementation called `r.vfs.stat(...)` and caught `e instanceof VFSError`.
 * Our SqliteVFSProvider's stat method delegates to SqliteVFS.stat which
 * throws raw `Error("ENOENT: ...")` — NOT VFSError. That rm path
 * therefore falls through to `else throw e`, the error propagates up,
 * and executeCommand returns exit 1.
 *
 * Real-world impact: every `rm -rf <nonexistent> && ...` short-circuits.
 * The most common cleanup idiom in shell scripts.
 *
 * Fix: register rm in the registry's `commands` map. Treat -f silently when target is
 * missing (return 0). Handle both files (unlink) and directories
 * (rmdir recursive when -r). Translate raw errors so the unix-command
 * contract is honoured.
 */
/** The single-character backslash escapes `echo -e` and `printf` both expand. */
const BACKSLASH_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
};

/**
 * Expand POSIX backslash escapes in one pass.
 *
 * A pass per escape needs somewhere to park a literal `\` so the later passes
 * cannot read it as the start of an escape, and whatever character that is, the
 * text may hold one already — or an earlier escape may have just produced one.
 * NUL was the parking spot, so `printf 'a\0b'` and `echo -e 'a\x00b'` both came
 * back as `a\b`: the NUL they had just produced was restored as a backslash.
 * One left-to-right pass consumes `\\` as a unit and needs no parking spot.
 */
function expandBackslashEscapes(text: string): string {
  return text.replace(
    /\\(?:([\\ntrabfv])|0([0-7]{1,3})?|x([0-9a-fA-F]{1,2}))/g,
    (_match, simple: string | undefined, octal: string | undefined, hex: string | undefined) => {
      if (simple !== undefined) return BACKSLASH_ESCAPES[simple];
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      return String.fromCharCode(octal ? parseInt(octal, 8) : 0);
    },
  );
}

/**
 * shell compatibilityb (2026-05-11): registry-level echo so `X | xargs echo`
 * resolves. `echo` is a Shell.builtins entry, NOT in the
 * registry map. xargs's cross-command dispatch goes through
 * registry.resolve(name) — without a registry entry for echo it falls
 * back to 'command not found'. The init.ts override for echo flag
 * handling targets Shell.builtins; we additionally register a copy
 * here so registry-driven callers (xargs) can find it. Behaviour
 * matches the BUG-SWEEP-4 nimbusEcho impl: -n / -e / -E / combined.
 */
function mkEcho(): CmdFn {
  return (ctx) => {
    const args = ctx.args;
    let interpretEscapes = false;
    let suppressNewline = false;
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a === '-n') { suppressNewline = true; i++; continue; }
      if (a === '-e') { interpretEscapes = true; i++; continue; }
      if (a === '-E') { interpretEscapes = false; i++; continue; }
      if (/^-[neE]+$/.test(a)) {
        for (const ch of a.slice(1)) {
          if (ch === 'n') suppressNewline = true;
          else if (ch === 'e') interpretEscapes = true;
          else if (ch === 'E') interpretEscapes = false;
        }
        i++;
        continue;
      }
      break;
    }
    let out = args.slice(i).join(' ');
    if (interpretEscapes) {
      out = expandBackslashEscapes(out);
    }
    ctx.stdout.write(suppressNewline ? out : out + '\n');
    return 0;
  };
}

/**
 * SHELL-R6-4 (2026-05-12): symlink-aware `ls`.
 *
 * Pre-fix: the lazy `ls` implementation formatted `mode` with first-char
 * `d` or `-`; it had no symlink concept,
 * and our SymlinkRegistry entries are not in the VFS dir listing at all,
 * so `ls -l` after `ln -s t.txt l.txt` showed ONLY `t.txt`.
 *
 * Post-fix:
 *   - `ls` lists VFS dir entries AND SymlinkRegistry entries whose link
 *     path lives in the queried directory.
 *   - `ls -l` shows `lrwxrwxrwx  1 user user  N <mtime> <name> -> <target>`
 *     for symlinks (`N` = target string length, matches GNU coreutils).
 *   - Non-symlink rows go through the same formatter so columns line up.
 *   - Hidden-file rule (skip if leading `.`) still honored unless `-a`.
 *
 * Args supported: `-l` long, `-a` all, `-1` one-per-line, `-n` numeric
 * ownership, `-d` directory itself, plus path
 * positional. Matches the shell `ls` flag surface so we don't regress.
 */
function mkLs(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const args = ctx.args;
    const flags = new Set(args
      .filter((arg) => arg.startsWith('-') && !arg.startsWith('--'))
      .flatMap((arg) => [...arg.slice(1)]));
    const flagLong = flags.has('l') || flags.has('n');
    const flagAll = flags.has('a');
    const flagOne = flags.has('1');
    const flagNumeric = flags.has('n');
    const flagDirectory = flags.has('d');
    const positionals = args.filter(a => !a.startsWith('-'));
    const targets = positionals.length > 0 ? positionals : [ctx.cwd];

    const reg = vfs.symlinks;
    const kvfs = ctx.vfs;

    function fmtTime(mtime: number): string {
      const d = new Date(mtime);
      const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
      const day = String(d.getDate()).padStart(2, ' ');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${mon} ${day} ${hh}:${mm}`;
    }

    type Entry = {
      name: string;
      type: 'file' | 'directory' | 'symlink';
      size: number;
      mtime: number;
      mode: number;
      uid: number;
      gid: number;
      linkTarget?: string;
    };

    /** An entry as either VFS layer lists it, before the row is rendered. */
    type ListedEntry = {
      name: string;
      type: FileType;
      size: number;
      mtime: number;
      mode: number;
      uid?: number;
      gid?: number;
    };

    let exit = 0;

    function listDir(dirPath: string): Entry[] {
      const fp = resolvePath(ctx.cwd, dirPath);
      const out: Entry[] = [];
      // Real entries via ctx.vfs.readdirStat (Kernel.VFS — handles
      // mounts like /dev) with fallback to closure-captured SqliteVFS.
      let real: ListedEntry[] = [];
      try {
        if (kvfs && 'readdirStat' in kvfs && typeof kvfs.readdirStat === 'function') {
          real = kvfs.readdirStat(fp);
        } else {
          const names = vfs.readdir(fp);
          real = names.map(n => {
            const childPath = (fp === '/' ? '' : fp.replace(/^\/+/, '').replace(/\/+$/, ''))
              + '/' + n.name;
            try {
              const s = vfs.stat(childPath);
              return { name: n.name, type: n.type, size: s.size ?? 0,
                       mtime: s.mtime ?? Date.now(), mode: s.mode ?? 0o644,
                       uid: s.uid ?? ctx.cred.uid, gid: s.gid ?? ctx.cred.gid };
            } catch {
              return { name: n.name, type: n.type, size: 0, mtime: Date.now(), mode: 0o644,
                       uid: ctx.cred.uid, gid: ctx.cred.gid };
            }
          });
        }
      } catch (e) {
        ctx.stderr.write(`ls: cannot access '${dirPath}': ${fsErrorMessage(e)}\n`);
        exit = 2;
        return [];
      }
      for (const r of real) {
        const type = r.type === 'directory'
          ? 'directory'
          : r.type === 'symlink'
            ? 'symlink'
            : 'file';
        const childPath = fp ? `${fp}/${r.name}` : r.name;
        out.push({
          name: r.name,
          type,
          size: r.size ?? 0,
          mtime: r.mtime ?? Date.now(),
          mode: r.mode ?? 0o644,
          uid: r.uid ?? ctx.cred.uid,
          gid: r.gid ?? ctx.cred.gid,
          ...(type === 'symlink'
            ? { linkTarget: readSymlinkTarget(vfs, childPath) ?? undefined }
            : {}),
        });
      }
      // Inject symlink entries whose link path is in this directory.
      const normDir = fp.replace(/^\/+/, '').replace(/\/+$/, '');
      for (const { link, target } of reg.list()) {
        const linkNorm = link.replace(/^\/+/, '').replace(/\/+$/, '');
        const lastSlash = linkNorm.lastIndexOf('/');
        const linkDir = lastSlash >= 0 ? linkNorm.substring(0, lastSlash) : '';
        if (linkDir === normDir) {
          const linkName = lastSlash >= 0 ? linkNorm.substring(lastSlash + 1) : linkNorm;
          if (out.some(entry => entry.name === linkName)) continue;
          // Filter dotfiles unless -a (consistent with real entries).
          if (!flagAll && linkName.startsWith('.')) continue;
          out.push({
            name: linkName,
            type: 'symlink',
            size: target.length,
            mtime: Date.now(),
            mode: 0o777,
            uid: ctx.cred.uid,
            gid: ctx.cred.gid,
            linkTarget: target,
          });
        }
      }
      // Filter dotfiles among real entries unless -a.
      const filtered = flagAll ? out : out.filter(e => !e.name.startsWith('.'));
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      return filtered;
    }

    function fmtRow(e: Entry, long: boolean): string {
      if (!long) return e.name;
      const isDir = e.type === 'directory';
      const isLink = e.type === 'symlink';
      const mode = unixModeString(e.mode, isDir, isLink);
      const size = String(e.size).padStart(6, ' ');
      const time = fmtTime(e.mtime);
      const arrow = isLink && e.linkTarget ? ` -> ${e.linkTarget}` : '';
      const user = flagNumeric ? String(e.uid) : unixUserLabel(vfs, e.uid);
      const group = flagNumeric ? String(e.gid) : unixGroupLabel(vfs, e.gid);
      return `${mode}  1 ${user} ${group} ${size} ${time} ${e.name}${arrow}`;
    }

    // First pass: separate file-args from dir-args (real `ls` lists
    // each file inline; dirs get listed as their contents).
    const fileEntries: Entry[] = [];
    const dirArgs: string[] = [];
    for (const arg of targets) {
      const fp = resolvePath(ctx.cwd, arg);
      // Symlink check: a symlink-arg is displayed as the link itself
      // (without -L which we don't implement).
      const target = readSymlinkTarget(vfs, fp);
      if (target !== null) {
        fileEntries.push({
          name: arg,
          type: 'symlink',
          size: target.length,
          mtime: Date.now(),
          mode: 0o777,
          uid: ctx.cred.uid,
          gid: ctx.cred.gid,
          linkTarget: target,
        });
        continue;
      }
      try {
        const s: CtxStat = kvfs && typeof kvfs.stat === 'function' ? kvfs.stat(fp) : vfs.stat(fp);
        if (s.type === 'directory' && !flagDirectory) {
          dirArgs.push(arg);
        } else {
          fileEntries.push({
            name: arg,
            type: s.type === 'directory' ? 'directory' : 'file',
            size: s.size ?? 0,
            mtime: s.mtime ?? Date.now(),
            mode: s.mode ?? 0o644,
            uid: s.uid ?? ctx.cred.uid,
            gid: s.gid ?? ctx.cred.gid,
          });
        }
      } catch (e) {
        ctx.stderr.write(`ls: cannot access '${arg}': ${errorText(e)}\n`);
        exit = 1;
      }
    }

    // Render file-args first.
    if (fileEntries.length > 0) {
      if (flagLong) {
        for (const e of fileEntries) ctx.stdout.write(fmtRow(e, true) + '\n');
      } else if (flagOne) {
        for (const e of fileEntries) ctx.stdout.write(e.name + '\n');
      } else {
        ctx.stdout.write(fileEntries.map(e => e.name).join('  ') + '\n');
      }
    }
    // Then dir-args (with header if multiple).
    for (let i = 0; i < dirArgs.length; i++) {
      const d = dirArgs[i];
      if (dirArgs.length > 1 || fileEntries.length > 0) {
        if (fileEntries.length > 0 || i > 0) ctx.stdout.write('\n');
        ctx.stdout.write(`${d}:\n`);
      }
      const rows = listDir(d);
      if (flagLong) {
        for (const e of rows) ctx.stdout.write(fmtRow(e, true) + '\n');
      } else if (flagOne) {
        for (const e of rows) ctx.stdout.write(e.name + '\n');
      } else if (rows.length > 0) {
        ctx.stdout.write(rows.map(e => e.name).join('  ') + '\n');
      }
    }
    return exit;
  };
}

/**
 * shell compatibilityc (2026-05-11): registry-level cat (for xargs cross-
 * command dispatch). Behaves like the shell cat command: reads files (or
 * stdin if none), concatenates to stdout.
 *
 * Operands stream through one shared writer, so concatenating six 1 MB files
 * emits 6 MB in 64 KiB steps rather than materialising each file whole.
 */
function mkCat(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const files = ctx.args.filter(a => !a.startsWith('-'));
    if (files.length === 0) {
      const piped = stdinText(ctx);
      if (piped) ctx.stdout.write(piped);
      return 0;
    }
    // Resolve both native VFS symlinks and the legacy registry before reads.
    let exit = 0;
    const writer = new SinkWriter(ctx.stdout);
    for (const fOrig of files) {
      const f = (() => {
        const fp = resolvePath(ctx.cwd, fOrig);
        const resolved = resolveSymlinkPath(vfs, fp);
        if (resolved === null) {
          // ELOOP: too many hops
          ctx.stderr.write(`cat: ${fOrig}: Too many levels of symbolic links\n`);
          return null;
        }
        return resolved === fp ? fOrig : '/' + resolved;
      })();
      if (f === null) { exit = 1; continue; }
      try {
        const path = f.startsWith('/') ? f : `${ctx.cwd}/${f}`;
        const stat = ctx.vfs.stat(path);
        if (stat.type === 'directory') throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
        if (stat.size > 0) {
          // A regular file's size is its exact extent — read precisely that.
          streamRange((offset, length) => ctx.vfs.readRange(path, offset, length), writer, {
            length: stat.size,
            signal: ctx.signal,
          });
        } else {
          // Size 0 covers empty files, /dev/null and synthesised /proc entries.
          // Endless character devices reject this unbounded read by design.
          writer.write(ctx.vfs.readFile(path));
        }
      } catch (error) {
        ctx.stderr.write(`cat: ${fOrig}: ${fsErrorMessage(error)}\n`);
        exit = 1;
      }
    }
    writer.end();
    return exit;
  };
}

function mkRm(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const args = ctx.args;
    const recursive = args.some(a => a === '-r' || a === '-R' || a === '-rf' || a === '-Rf' || a === '-rR' || a === '--recursive' || (a.startsWith('-') && !a.startsWith('--') && (a.includes('r') || a.includes('R'))));
    const force = args.some(a => a === '-f' || a === '--force' || (a.startsWith('-') && !a.startsWith('--') && a.includes('f')));
    const targets = args.filter(a => !a.startsWith('-'));
    if (targets.length === 0) {
      if (force) return 0;  // POSIX: rm -f with no operands is silent success
      ctx.stderr.write('rm: missing operand\n');
      return 1;
    }
    // SHELL-R6-5: SymlinkRegistry awareness. Real `rm` removes the
    // LINK, not the target. Pre-fix this loop went straight to
    // vfs.exists which is false for registry-only symlink entries
    // (no real file), producing "No such file or directory" while
    // `readlink` still reported the registry entry.
    const reg = vfs.symlinks;
    let exit = 0;
    for (const t of targets) {
      const fp = resolvePath(ctx.cwd, t);
      // Symlink path FIRST. If `fp` is registered as a symlink we
      // delete the registry entry and skip the vfs-level operations.
      // Real `rm` never follows symlinks (it removes the link
      // itself); recursive flag has no effect on the symlink itself
      // either — it acts on the link node only.
      if (reg.isSymlink(fp)) {
        reg.delete(fp);
        continue;
      }
      if (!vfs.exists(fp)) {
        if (force) continue;  // silent success
        ctx.stderr.write(`rm: cannot remove '${t}': No such file or directory\n`);
        exit = 1;
        continue;
      }
      try {
        if (vfs.isDirectory(fp)) {
          if (!recursive) {
            ctx.stderr.write(`rm: cannot remove '${t}': Is a directory\n`);
            exit = 1;
            continue;
          }
          vfs.removeRecursive(fp);
        } else {
          vfs.unlink(fp);
        }
      } catch (e) {
        // -f suppresses ENOENT only (file disappeared mid-loop); other
        // errors (ENOTEMPTY because of a logic bug, ENOTDIR mismatches,
        // permission errors) must still surface. Pre-fix the broad
        // `if (force) continue` masked the readdir-iteration bug that
        // left directories undeleted.
        const msg = errorText(e);
        if (force && /ENOENT/.test(msg)) continue;
        ctx.stderr.write(`rm: cannot remove '${t}': ${fsErrorMessage(e)}\n`);
        exit = 1;
      }
    }
    return exit;
  };
}

function mkTouch(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const targetVfs = ctx.vfs ?? vfs;
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      const fp = resolvePath(ctx.cwd, f);
      // Ensure parent dirs
      const parts = fp.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (dir && !targetVfs.exists(dir)) targetVfs.mkdir(dir, { recursive: true });
      }
      if (!targetVfs.exists(fp)) {
        targetVfs.writeFile(fp, '');
        continue;
      }
      // Every view reaching here implements `isDirectory`: the lifo VFS gained
      // it alongside `isFile`, which is what stopped `touch` failing on an
      // existing file. The `stat` fallback this replaced narrowed to `never`
      // once the surface was typed — the type system reporting that the guard
      // it sat behind can no longer be false.
      const isDirectory = targetVfs.isDirectory(fp);
      if (!isDirectory) {
        // Update mtime by re-writing the same content
        const content = targetVfs.readFile(fp);
        targetVfs.writeFile(fp, content);
      }
    }
    return 0;
  };
}

/**
 * `stat` formatting.
 *
 * Every GNU directive is answered, using what this filesystem actually knows:
 *
 *   - inode (%i): paths are the identity here — there are no hard links, so a
 *     path maps to exactly one file. %i is a stable hash of the path, which
 *     gives (dev,ino) comparisons the right answer instead of the zero an
 *     inode-less filesystem would otherwise report for everything.
 *   - link count (%h) is always 1, device numbers are 0: one store, no
 *     hard links, no device nodes.
 *   - birth time (%w/%W) prints `-`/`0`, GNU's own convention for a
 *     filesystem that does not record it. Change time (%z/%Z) tracks mtime.
 *   - SELinux context (%C) prints `?`, as GNU does where there is none.
 */
const STAT_TERSE_FORMAT = '%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o %C';
const STATFS_TERSE_FORMAT = '%n %i %l %t %s %S %b %f %a %c %d';
/** Longest component the VFS accepts, reported by %l and `Namelen`. */
const STAT_NAME_MAX = 255;
/** Reported by %o: the VFS reads and writes in 64 KiB chunks. */
const STAT_IO_BLOCK_SIZE = 65536;
/** %b/%B count 512-byte units, as GNU does. */
const STAT_BLOCK_UNIT = 512;

interface StatFacts {
  size: number;
  type: string;
  mode: number;
  uid: number;
  gid: number;
  atime: number;
  mtime: number;
  ctime?: number;
}

interface StatFsFacts {
  blockSize: number;
  totalBlocks: number;
  freeBlocks: number;
  totalInodes: number;
  freeInodes: number;
}

/** Stable 53-bit identity for a path — see the %i note above. */
function statPathId(path: string): number {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) >>> 0;
  low = Math.imul(low ^ (low >>> 13), 3266489909) >>> 0;
  return high * 0x200000 + (low >>> 11);
}

function statDirective(
  directive: string,
  stat: StatFacts,
  path: string,
  labels: { user: string; group: string },
): string | null {
  const isDir = stat.type === 'directory';
  const isLink = stat.type === 'symlink';
  const changeTime = stat.ctime ?? stat.mtime;
  switch (directive) {
    case 'n': return path;
    case 'N': return `'${path}'`;
    case 's': return String(stat.size);
    case 'b': return String(Math.ceil(stat.size / STAT_BLOCK_UNIT));
    case 'B': return String(STAT_BLOCK_UNIT);
    case 'o': return String(STAT_IO_BLOCK_SIZE);
    case 'a': return (stat.mode & 0o7777).toString(8);
    case 'A': return unixModeString(stat.mode, isDir, isLink);
    case 'f': return (stat.mode >>> 0).toString(16);
    case 'u': return String(stat.uid);
    case 'U': return labels.user;
    case 'g': return String(stat.gid);
    case 'G': return labels.group;
    case 'F':
      if (isDir) return 'directory';
      if (isLink) return 'symbolic link';
      return isCharacterDevice(stat.mode) ? 'character special file' : 'regular file';
    case 'h': return '1';
    case 'i': return String(statPathId(path));
    case 'd': return '0';
    case 'D': return '0';
    case 't': return '0';
    case 'T': return '0';
    case 'm': return '/';
    case 'C': return '?';
    case 'w': return '-';
    case 'W': return '0';
    case 'Y': return String(Math.floor(stat.mtime / 1000));
    case 'y': return new Date(stat.mtime).toISOString();
    case 'X': return String(Math.floor(stat.atime / 1000));
    case 'x': return new Date(stat.atime).toISOString();
    case 'Z': return String(Math.floor(changeTime / 1000));
    case 'z': return new Date(changeTime).toISOString();
    case '%': return '%';
    default: return null;
  }
}

function statFsDirective(directive: string, fs: StatFsFacts, path: string): string | null {
  switch (directive) {
    case 'n': return path;
    case 'i': return String(statPathId('/'));
    case 'l': return String(STAT_NAME_MAX);
    case 't': return '0';
    case 'T': return 'nimbus-sqlite';
    case 's': return String(fs.blockSize);
    case 'S': return String(fs.blockSize);
    case 'b': return String(fs.totalBlocks);
    case 'f': return String(fs.freeBlocks);
    case 'a': return String(fs.freeBlocks);
    case 'c': return String(fs.totalInodes);
    case 'd': return String(fs.freeInodes);
    case '%': return '%';
    default: return null;
  }
}

function expandStatFormat(
  format: string,
  expand: (directive: string) => string | null,
): { text: string } | { error: string } {
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === '\\' && i + 1 < format.length) {
      const esc = format[++i];
      out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '0' ? '\0' : esc;
      continue;
    }
    if (ch !== '%') {
      out += ch;
      continue;
    }
    const directive = format[++i];
    if (directive === undefined) return { error: "stat: trailing '%' in format" };
    const expanded = expand(directive);
    if (expanded === null) return { error: `stat: unrecognized format directive '%${directive}'` };
    out += expanded;
  }
  return { text: out };
}

const STAT_USAGE = [
  'Usage: stat [OPTION]... FILE...',
  'Display file or file system status.',
  '',
  '  -L, --dereference     follow links (Nimbus always follows)',
  '  -f, --file-system     display file system status instead of file status',
  '  -c, --format=FORMAT   use the specified FORMAT instead of the default',
  '      --printf=FORMAT   like --format, but interpret escapes and omit the newline',
  '  -t, --terse           print the information in terse form',
  '      --cached=MODE     always|default|never (Nimbus attributes are never cached)',
  '      --help            display this help and exit',
  '      --version         output version information and exit',
  '',
].join('\n');

function mkStat(vfs: UnixVfs, sqliteVfs: SqliteVFS): CmdFn {
  return (ctx) => {
    let format: string | null = null;
    // `--printf` differs from `-c` only in not appending a newline.
    let formatAddsNewline = true;
    let fileSystemMode = false;
    let terse = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-c' || arg === '--format' || arg === '--printf') {
        const value = args[++i];
        if (value === undefined) {
          ctx.stderr.write(`stat: option '${arg}' requires an argument\n`);
          return 1;
        }
        format = value;
        formatAddsNewline = arg !== '--printf';
      } else if (arg.startsWith('--format=') || arg.startsWith('--printf=')) {
        format = arg.slice(arg.indexOf('=') + 1);
        formatAddsNewline = !arg.startsWith('--printf=');
      } else if (arg === '-f' || arg === '--file-system') {
        fileSystemMode = true;
      } else if (arg === '-t' || arg === '--terse') {
        terse = true;
      } else if (arg === '-L' || arg === '--dereference') {
        // Symlinks are already followed; accept the flag rather than drop it.
      } else if (arg.startsWith('--cached=')) {
        const mode = arg.slice('--cached='.length);
        if (mode !== 'always' && mode !== 'default' && mode !== 'never') {
          ctx.stderr.write(`stat: invalid argument '${mode}' for '--cached'\n`);
          return 1;
        }
        // Attributes are read live from the VFS, which satisfies every mode.
      } else if (arg === '--help') {
        ctx.stdout.write(STAT_USAGE);
        return 0;
      } else if (arg === '--version') {
        ctx.stdout.write(`stat (nimbus coreutils) ${NIMBUS_VERSION}\n`);
        return 0;
      } else if (arg === '--') {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith('-') && arg !== '-') {
        ctx.stderr.write(`stat: invalid option '${arg}'\n`);
        ctx.stderr.write(STAT_USAGE);
        return 1;
      } else {
        files.push(arg);
      }
    }

    if (files.length === 0) {
      ctx.stderr.write('stat: missing operand\n');
      return 1;
    }

    const write = (text: string) => {
      ctx.stdout.write(formatAddsNewline ? text + '\n' : text);
    };

    if (fileSystemMode) {
      const stats = sqliteVfs.getStats();
      const facts: StatFsFacts = {
        blockSize: STAT_IO_BLOCK_SIZE,
        totalBlocks: Math.floor(stats.capacityBytes / STAT_IO_BLOCK_SIZE),
        freeBlocks: Math.max(
          0,
          Math.floor((stats.capacityBytes - stats.usedBytes) / STAT_IO_BLOCK_SIZE),
        ),
        totalInodes: stats.files + stats.directories,
        freeInodes: 0,
      };
      const activeFormat = format ?? (terse ? STATFS_TERSE_FORMAT : null);
      for (const f of files) {
        const displayPath = f.startsWith('/') ? f : resolvePath(ctx.cwd, f).replace(/^\/*/, '/');
        if (activeFormat !== null) {
          const expanded = expandStatFormat(
            activeFormat,
            (directive) => statFsDirective(directive, facts, displayPath),
          );
          if ('error' in expanded) {
            ctx.stderr.write(expanded.error + '\n');
            return 1;
          }
          write(expanded.text);
          continue;
        }
        ctx.stdout.write(`  File: "${displayPath}"\n`);
        ctx.stdout.write(`    ID: 0        Namelen: ${STAT_NAME_MAX}     Type: nimbus-sqlite\n`);
        ctx.stdout.write(
          `Block size: ${facts.blockSize}       Fundamental block size: ${facts.blockSize}\n`,
        );
        ctx.stdout.write(
          `Blocks: Total: ${facts.totalBlocks}  Free: ${facts.freeBlocks}  Available: ${facts.freeBlocks}\n`,
        );
        ctx.stdout.write(`Inodes: Total: ${facts.totalInodes}  Free: ${facts.freeInodes}\n`);
      }
      return 0;
    }

    const activeFormat = format ?? (terse ? STAT_TERSE_FORMAT : null);
    // shell compatibility follow-up: try Kernel.VFS (ctx.vfs) first so /dev
    // mount paths resolve. Same pattern as mkCat.
    const kvfs = ctx.vfs;
    for (const f of files) {
      let st: CtxStat | null = null;
      let displayPath = f;
      // Try Kernel.VFS first (sees mounts).
      if (kvfs && typeof kvfs.stat === 'function') {
        try {
          st = kvfs.stat(f.startsWith('/') ? f : ctx.cwd + '/' + f);
          displayPath = f.startsWith('/') ? f : `/${ctx.cwd}/${f}`.replace(/^\/+/, '/');
        } catch (_e) { /* fall through to SqliteVFS */ }
      }
      // Fall back to SqliteVFS direct for non-mounted paths.
      if (!st) {
        try {
          const fp = resolvePath(ctx.cwd, f);
          st = vfs.stat(fp);
          displayPath = '/' + fp;
        } catch (_e) {
          ctx.stderr.write(`stat: cannot statx '${f}': No such file or directory\n`);
          return 1;
        }
      }
      const uid = st.uid ?? ctx.cred.uid;
      const gid = st.gid ?? ctx.cred.gid;
      const labels = {
        user: unixUserLabel(vfs, uid),
        group: unixGroupLabel(vfs, gid),
      };
      const facts: StatFacts = {
        size: st.size,
        type: st.type,
        mode: st.mode,
        uid,
        gid,
        atime: st.atime ?? st.mtime,
        mtime: st.mtime,
        ctime: st.ctime,
      };
      if (activeFormat !== null) {
        const expanded = expandStatFormat(
          activeFormat,
          (directive) => statDirective(directive, facts, displayPath, labels),
        );
        if ('error' in expanded) {
          ctx.stderr.write(expanded.error + '\n');
          return 1;
        }
        write(expanded.text);
        continue;
      }
      ctx.stdout.write(`  File: ${displayPath}\n`);
      const kind = isCharacterDevice(st.mode) ? 'character special file' : st.type;
      ctx.stdout.write(`  Size: ${st.size}\tType: ${kind}\n`);
      ctx.stdout.write(`Access: (0${st.mode.toString(8)})  Uid: (${uid}/${labels.user})   Gid: (${gid}/${labels.group})\n`);
      ctx.stdout.write(`Modify: ${new Date(st.mtime).toISOString()}\n`);
    }
    return 0;
  };
}

const BASE64_SPEC = {
  decode: { type: 'boolean' as const, short: 'd' },
  'ignore-garbage': { type: 'boolean' as const, short: 'i' },
  wrap: { type: 'string' as const, short: 'w' },
};

/**
 * Encodes and decodes the real bytes. Reading the input as a string first put
 * every byte that is not valid UTF-8 through U+FFFD, so encoding any binary
 * file produced base64 of something else; `-w`, which GNU wraps at 76 columns
 * by default, was not implemented at all, so `base64 -w 0` read `0` as a file.
 */
function mkBase64(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, BASE64_SPEC);
    if (unknown.length > 0) {
      ctx.stderr.write(`base64: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
      return 1;
    }
    const wrapText = typeof flags.wrap === 'string' && flags.wrap !== '' ? flags.wrap : '76';
    const wrap = Number.parseInt(wrapText, 10);
    if (Number.isNaN(wrap) || wrap < 0) {
      ctx.stderr.write(`base64: invalid wrap size: '${wrapText}'\n`);
      return 1;
    }

    const file = positional[0];
    let bytes: Uint8Array;
    if (file !== undefined && file !== '-') {
      try { bytes = vfs.readFile(resolvePath(ctx.cwd, file)); }
      catch (error) { ctx.stderr.write(`base64: ${file}: ${fsErrorMessage(error)}\n`); return 1; }
    } else {
      bytes = enc.encode(stdinText(ctx) ?? '');
    }

    if (flags.decode) {
      const source = dec.decode(bytes).replace(/\s+/g, '');
      let decoded: Uint8Array;
      try {
        const binary = atob(source);
        decoded = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      } catch { ctx.stderr.write('base64: invalid input\n'); return 1; }
      if (ctx.stdout.writeBytes) ctx.stdout.writeBytes(decoded);
      else ctx.stdout.write(dec.decode(decoded));
      return 0;
    }

    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    if (encoded === '') return 0;
    const lines = wrap > 0
      ? (encoded.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? [encoded])
      : [encoded];
    ctx.stdout.write(lines.join('\n') + '\n');
    return 0;
  };
}

function mkSeq(): CmdFn {
  return (ctx) => {
    const nums = ctx.args.map(Number).filter(n => !isNaN(n));
    let start = 1, step = 1, end = 1;
    if (nums.length === 1) end = nums[0];
    else if (nums.length === 2) { start = nums[0]; end = nums[1]; }
    else if (nums.length >= 3) { start = nums[0]; step = nums[1]; end = nums[2]; }
    for (let i = start; step > 0 ? i <= end : i >= end; i += step) ctx.stdout.write(i + '\n');
    return 0;
  };
}

function mkId(sqliteVfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const vfs = sqliteVfs.as(ctx.cred);
    const user = findUnixUserName(vfs, ctx.cred.uid) ?? String(ctx.cred.uid);
    const group = findUnixGroupName(vfs, ctx.cred.gid) ?? String(ctx.cred.gid);
    const groupIds = [...new Set([ctx.cred.gid, ...ctx.cred.groups])];
    const groups = groupIds
      .map((gid) => `${gid}(${findUnixGroupName(vfs, gid) ?? gid})`)
      .join(',');
    ctx.stdout.write(`uid=${ctx.cred.uid}(${user}) gid=${ctx.cred.gid}(${group}) groups=${groups}\n`);
    return 0;
  };
}

function mkChown(sqliteVfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const recursive = ctx.args.includes('-R') || ctx.args.includes('--recursive');
    const positional = ctx.args.filter((arg) => arg !== '-R' && arg !== '--recursive');
    if (positional.length < 2) {
      ctx.stderr.write('chown: missing operand\n');
      return 1;
    }

    const vfs = sqliteVfs.as(ctx.cred);
    let ownership: { uid: number | null; gid: number | null };
    try {
      ownership = parseChownOwnership(vfs, positional[0]);
    } catch (error) {
      ctx.stderr.write(`chown: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }

    let exitCode = 0;
    const apply = (path: string): void => {
      if (recursive && vfs.stat(path).type === 'directory') {
        for (const child of vfs.readdir(path)) apply(`${path}/${child.name}`);
      }
      vfs.chown(path, ownership.uid, ownership.gid);
    };

    for (const file of positional.slice(1)) {
      try {
        apply(resolvePath(ctx.cwd, file));
      } catch (error) {
        ctx.stderr.write(`chown: ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
        exitCode = 1;
      }
    }
    return exitCode;
  };
}

function mkTest(sqliteVfs: SqliteVFS): CmdFn {
  return (ctx) => {
    const args = ctx.args.filter((arg) => arg !== ']');
    if (args.length === 0) return 1;
    const vfs = sqliteVfs.as(ctx.cred);
    const path = resolvePath(ctx.cwd, args[1] ?? '');
    try {
      if (args[0] === '-r') vfs.access(path, 0o4);
      else if (args[0] === '-w') vfs.access(path, 0o2);
      else if (args[0] === '-x') vfs.access(path, 0o1);
      else if (args[0] === '-f') return vfs.stat(path).type === 'file' ? 0 : 1;
      else if (args[0] === '-d') return vfs.stat(path).type === 'directory' ? 0 : 1;
      else if (args[0] === '-e') vfs.stat(path);
      else if (args[0] === '-z') return (!args[1] || args[1] === '') ? 0 : 1;
      else if (args[0] === '-n') return args[1] ? 0 : 1;
      else if (args[1] === '=') return args[0] === args[2] ? 0 : 1;
      else if (args[1] === '!=') return args[0] !== args[2] ? 0 : 1;
      else return args[0] ? 0 : 1;
      return 0;
    } catch {
      return 1;
    }
  };
}

function mkHostname(): CmdFn {
  return (ctx) => { ctx.stdout.write('nimbus\n'); return 0; };
}

function mkBasename(): CmdFn {
  return (ctx) => {
    const p = ctx.args[0] || '';
    const suffix = ctx.args[1] || '';
    let base = p.split('/').pop() || '';
    if (suffix && base.endsWith(suffix)) base = base.slice(0, -suffix.length);
    ctx.stdout.write(base + '\n');
    return 0;
  };
}

function mkDirname(): CmdFn {
  return (ctx) => {
    const p = ctx.args[0] || '';
    const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '.';
    ctx.stdout.write((dir || '/') + '\n');
    return 0;
  };
}

function mkRealpath(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    for (const p of ctx.args) {
      const fp = resolvePath(ctx.cwd, p);
      if (vfs.exists(fp)) ctx.stdout.write('/' + fp + '\n');
      else { ctx.stderr.write(`realpath: ${p}: No such file\n`); return 1; }
    }
    return 0;
  };
}

/**
 * shell compatibility (2026-05-11): printf full POSIX format set.
 *
 * Pre-fix mkPrintf only handled %s and %d via simple replace —
 * `printf "%x\\n" 255` output literal `%x`, `printf "%5d" 7` output
 * literal `%5d`. Common shell scripts use %x (hex), %o (octal),
 * %f (float), %g (general), %c (char), width+precision specifiers,
 * and flag chars (- + 0 # space).
 *
 * Real bash printf cycles through args, re-running the format
 * string if there are more args than format specifiers. We
 * replicate that.
 */
function mkPrintf(): CmdFn {
  return (ctx) => {
    if (ctx.args.length === 0) return 0;
    const rawFmt = ctx.args[0];
    const vals = ctx.args.slice(1);
    // Process backslash escapes in the format string first.
    const fmt = expandBackslashEscapes(rawFmt);

    let out = '';
    let argIdx = 0;

    function applyFormat(): boolean {
      // Run the format string once; return true if it consumed any args.
      let i = 0;
      const startArg = argIdx;
      while (i < fmt.length) {
        const ch = fmt[i];
        if (ch !== '%') { out += ch; i++; continue; }
        if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
        // Parse format spec: %[flags][width][.prec]conversion
        let spec = '%';
        i++;
        while (i < fmt.length && /[-+ 0#]/.test(fmt[i])) { spec += fmt[i]; i++; }
        while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; }
        if (fmt[i] === '.') {
          spec += fmt[i]; i++;
          while (i < fmt.length && /[0-9]/.test(fmt[i])) { spec += fmt[i]; i++; }
        }
        const conv = fmt[i];
        i++;
        const arg = vals[argIdx++];
        out += formatOneArg(spec + conv, arg);
      }
      return argIdx > startArg;
    }

    // bash printf: re-run the format until args are exhausted; if
    // format consumes zero args (no %X specifiers), run it once.
    if (vals.length === 0) {
      applyFormat();
    } else {
      while (argIdx < vals.length) {
        if (!applyFormat()) break;
      }
    }
    ctx.stdout.write(out);
    return 0;
  };
}

function formatOneArg(spec: string, arg: string | undefined): string {
  const conv = spec[spec.length - 1];
  const flagsAndWidth = spec.slice(1, -1);
  const dotIdx = flagsAndWidth.indexOf('.');
  const widthPart = dotIdx >= 0 ? flagsAndWidth.slice(0, dotIdx) : flagsAndWidth;
  const precPart = dotIdx >= 0 ? flagsAndWidth.slice(dotIdx + 1) : '';
  let flags = '';
  let widthStr = '';
  for (const c of widthPart) {
    if (/[-+ 0#]/.test(c)) flags += c;
    else widthStr += c;
  }
  const width = widthStr ? parseInt(widthStr, 10) : 0;
  const prec = precPart ? parseInt(precPart, 10) : -1;
  let body: string;
  switch (conv) {
    case 's': {
      body = String(arg ?? '');
      if (prec >= 0) body = body.slice(0, prec);
      break;
    }
    case 'd': case 'i': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      const v = Number.isFinite(n) ? n : 0;
      body = String(Math.abs(v));
      const sign = v < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      body = sign + body;
      break;
    }
    case 'u': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      body = String(Math.max(0, Number.isFinite(n) ? n : 0));
      break;
    }
    case 'f': case 'F': {
      const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
      const p = prec < 0 ? 6 : prec;
      body = (Number.isFinite(n) ? n : 0).toFixed(p);
      if (n >= 0 && flags.includes('+')) body = '+' + body;
      else if (n >= 0 && flags.includes(' ')) body = ' ' + body;
      break;
    }
    case 'e': case 'E': {
      const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
      const p = prec < 0 ? 6 : prec;
      body = (Number.isFinite(n) ? n : 0).toExponential(p);
      if (conv === 'E') body = body.toUpperCase();
      break;
    }
    case 'g': case 'G': {
      const n = typeof arg === 'number' ? arg : parseFloat(String(arg ?? '0'));
      const p = prec < 0 ? 6 : prec || 1;
      body = (Number.isFinite(n) ? n : 0).toPrecision(p);
      // Strip trailing zeros + dot (POSIX %g behavior) unless # flag.
      if (!flags.includes('#')) body = body.replace(/(\.\d*?)0+($|e)/, '$1$2').replace(/\.($|e)/, '$1');
      if (conv === 'G') body = body.toUpperCase();
      break;
    }
    case 'x': case 'X': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      body = (Number.isFinite(n) ? n >>> 0 : 0).toString(16);
      if (conv === 'X') body = body.toUpperCase();
      if (flags.includes('#') && body !== '0') body = (conv === 'X' ? '0X' : '0x') + body;
      break;
    }
    case 'o': {
      const n = typeof arg === 'number' ? Math.trunc(arg) : Math.trunc(parseFloat(String(arg ?? '0')));
      body = (Number.isFinite(n) ? n >>> 0 : 0).toString(8);
      if (flags.includes('#') && !body.startsWith('0')) body = '0' + body;
      break;
    }
    case 'b': {
      // bash printf %b: interpret backslash escapes in the arg
      let s = String(arg ?? '');
      s = s.replace(/\\\\/g, '\u0000')
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
        .replace(/\\u0000/g, '\\');
      body = s;
      break;
    }
    case 'c': {
      if (typeof arg === 'number') body = String.fromCharCode(arg);
      else body = String(arg ?? '').charAt(0);
      break;
    }
    case 'q': {
      // bash printf %q: shell-quote
      const s = String(arg ?? '');
      if (/^[A-Za-z0-9_/.,:=+@%-]+$/.test(s)) body = s;
      else body = "'" + s.replace(/'/g, `'\\''`) + "'";
      break;
    }
    default: body = '%' + conv;
  }
  // Apply width padding.
  if (width > body.length) {
    const zeroPad = flags.includes('0') && /[diouxXfFeEgG]/.test(conv) && !flags.includes('-');
    const padCh = zeroPad ? '0' : ' ';
    if (flags.includes('-')) body = body.padEnd(width, ' ');
    else {
      // For zero-pad on negative numbers, keep the sign at the front.
      if (zeroPad && (body.startsWith('-') || body.startsWith('+') || body.startsWith(' '))) {
        body = body[0] + body.slice(1).padStart(width - 1, padCh);
      } else {
        body = body.padStart(width, padCh);
      }
    }
  }
  return body;
}

function mkTrue(): CmdFn { return () => 0; }
function mkFalse(): CmdFn { return () => 1; }

/**
 * shell compatibility (2026-05-11): readlink stub.
 *
 * Real readlink reads the symlink target. Our VFS doesn't yet
 * support real symlinks (ln -s currently does a regular file
 * copy — tracked as deferred). For graceful failure:
 *   - if path is a regular file/dir, exit 1 (matches GNU readlink)
 *   - if path is missing, write error to stderr + exit 1
 *   - explicit handling avoids 'readlink: command not found'.
 *
 * When real symlinks land in VFS, this command will become the
 * read-side of the symlink table.
 */
/**
 * SHELL-FOLLOWUPS-4 (2026-05-11): real symlink readlink.
 * Pre-fix: ln -s did file-copy; readlink returned exit 1 with no
 * output (no symlink table existed). Now backed by SymlinkRegistry:
 *   - GNU readlink prints target (relative or absolute as stored)
 *   - exit 1 silently for non-symlinks (matches GNU readlink default)
 *   - exit 1 + stderr for missing files
 * Flags: -f (canonicalize — follow chain to final target), default
 * (one-hop). -e variant (verify) deferred.
 */
function mkReadlink(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const args = [...ctx.args];
    let canonicalize = false;
    const targets: string[] = [];
    for (const a of args) {
      if (a === '-f' || a === '--canonicalize') { canonicalize = true; continue; }
      if (a.startsWith('-') && a !== '-') {
        for (const ch of a.slice(1)) if (ch === 'f') canonicalize = true;
        continue;
      }
      targets.push(a);
    }
    if (targets.length === 0) {
      ctx.stderr.write('readlink: missing operand\n');
      return 1;
    }
    let exit = 0;
    for (const t of targets) {
      const fp = resolvePath(ctx.cwd, t);
      if (canonicalize) {
        // -f: follow chain; succeed even if target doesn't exist YET
        // (matches `readlink -f` which canonicalizes anyway).
        const resolved = resolveSymlinkPath(vfs, fp);
        if (resolved !== null) {
          ctx.stdout.write('/' + resolved + '\n');
          continue;
        }
        ctx.stderr.write(`readlink: ${t}: Too many levels of symbolic links\n`);
        exit = 1;
        continue;
      }
      // Default: one-hop. Print target verbatim (preserves relative/absolute).
      const direct = readSymlinkTarget(vfs, fp);
      if (direct !== null) {
        ctx.stdout.write(direct + '\n');
        continue;
      }
      // Not a symlink. GNU readlink exits 1 silently for regular
      // files / dirs; emits stderr for missing.
      if (!vfs.exists(fp)) {
        ctx.stderr.write(`readlink: ${t}: No such file or directory\n`);
      }
      exit = 1;
    }
    return exit;
  };
}

const SHA256SUM_SPEC = {
  check: { type: 'boolean' as const, short: 'c' },
  binary: { type: 'boolean' as const, short: 'b' },
  text: { type: 'boolean' as const, short: 't' },
  quiet: { type: 'boolean' as const, short: 'q' },
  status: { type: 'boolean' as const },
};

/**
 * Real SHA-256 over the file's real bytes.
 *
 * The digest used to be taken over `enc.encode(readFileString(path))` — a
 * UTF-8 decode and re-encode, which replaces every byte that is not valid
 * UTF-8 with U+FFFD. For any binary file that hashes something the file does
 * not contain, and it never announced a problem: an installer verifying a
 * downloaded tarball got a mismatch on a perfectly good download, every time.
 */
function mkSha256sum(vfs: UnixVfs): CmdFn {
  const digest = async (bytes: Uint8Array): Promise<string> => {
    const ab = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(ab)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  return async (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, SHA256SUM_SPEC);
    if (unknown.length > 0) {
      ctx.stderr.write(`sha256sum: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`);
      return 1;
    }

    if (flags.check) return verifySha256Sums(ctx, vfs, positional, digest, flags.status === true);

    if (positional.length === 0 || (positional.length === 1 && positional[0] === '-')) {
      ctx.stdout.write(`${await digest(enc.encode(stdinText(ctx) ?? ''))}  -\n`);
      return 0;
    }

    let exit = 0;
    for (const f of positional) {
      try {
        ctx.stdout.write(`${await digest(vfs.readFile(resolvePath(ctx.cwd, f)))}  ${f}\n`);
      } catch {
        ctx.stderr.write(`sha256sum: ${f}: No such file or directory\n`);
        exit = 1;
      }
    }
    return exit;
  };
}

/** `sha256sum -c LIST` — each line is `HASH  FILENAME`, as this command prints. */
async function verifySha256Sums(
  ctx: Ctx,
  vfs: UnixVfs,
  lists: string[],
  digest: (bytes: Uint8Array) => Promise<string>,
  quiet: boolean,
): Promise<number> {
  let exit = 0;
  for (const list of lists) {
    let body: string;
    try {
      body = vfs.readFileString(resolvePath(ctx.cwd, list));
    } catch {
      ctx.stderr.write(`sha256sum: ${list}: No such file or directory\n`);
      exit = 1;
      continue;
    }
    for (const line of body.split('\n')) {
      const entry = /^([0-9a-fA-F]{64})\s[\s*](.*)$/.exec(line);
      if (entry === null) continue;
      const [, expected, name] = entry;
      let actual: string | null = null;
      try {
        actual = await digest(vfs.readFile(resolvePath(ctx.cwd, name)));
      } catch { /* reported as FAILED open below */ }
      if (actual === null) {
        ctx.stderr.write(`sha256sum: ${name}: No such file or directory\n`);
        if (!quiet) ctx.stdout.write(`${name}: FAILED open or read\n`);
        exit = 1;
      } else if (actual.toLowerCase() === expected.toLowerCase()) {
        if (!quiet) ctx.stdout.write(`${name}: OK\n`);
      } else {
        if (!quiet) ctx.stdout.write(`${name}: FAILED\n`);
        exit = 1;
      }
    }
  }
  return exit;
}

function mkFile(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      const fp = resolvePath(ctx.cwd, f);
      try {
        if (vfs.isDirectory(fp)) { ctx.stdout.write(`${f}: directory\n`); continue; }
        // BUG-SWEEP-3 (2026-05-11): scan raw bytes for NUL or non-text
        // bytes BEFORE attempting a UTF-8 decode. Pre-fix every binary
        // file was reported as "UTF-8 text" because readFileString
        // silently U+FFFD-substituted invalid sequences.
        const bytes = vfs.readFile(fp);
        let isBinary = false;
        const scanLimit = Math.min(bytes.length, 8192);
        for (let i = 0; i < scanLimit; i++) {
          const b = bytes[i];
          if (b === 0) { isBinary = true; break; }
          // Bytes 0x01-0x08 + 0x0E-0x1F (excluding TAB/LF/CR/FF) are
          // strong signals of non-text content.
          if (b < 0x09 || (b > 0x0d && b < 0x20)) { isBinary = true; break; }
        }
        if (isBinary) {
          // Magic-byte sniff for common formats.
          if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
            ctx.stdout.write(`${f}: ELF executable\n`);
          } else if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
            ctx.stdout.write(`${f}: WebAssembly (wasm) binary module\n`);
          } else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
            ctx.stdout.write(`${f}: PNG image data\n`);
          } else if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            ctx.stdout.write(`${f}: gzip compressed data\n`);
          } else if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
            ctx.stdout.write(`${f}: Zip archive data\n`);
          } else {
            ctx.stdout.write(`${f}: data\n`);
          }
          continue;
        }
        const content = new TextDecoder('utf-8').decode(bytes);
        if (content.startsWith('<!DOCTYPE') || content.startsWith('<html')) ctx.stdout.write(`${f}: HTML document\n`);
        else if (content.startsWith('{') || content.startsWith('[')) ctx.stdout.write(`${f}: JSON data\n`);
        else if (content.startsWith('#!')) ctx.stdout.write(`${f}: script, ${content.split('\n')[0]}\n`);
        else if (f.endsWith('.ts') || f.endsWith('.tsx')) ctx.stdout.write(`${f}: TypeScript source\n`);
        else if (f.endsWith('.js') || f.endsWith('.mjs')) ctx.stdout.write(`${f}: JavaScript source\n`);
        else if (f.endsWith('.css')) ctx.stdout.write(`${f}: CSS stylesheet\n`);
        else ctx.stdout.write(`${f}: ASCII text, ${content.split('\n').length} lines\n`);
      } catch { ctx.stderr.write(`file: ${f}: No such file\n`); return 1; }
    }
    return 0;
  };
}

function mkXxd(vfs: UnixVfs): CmdFn {
  return (ctx) => {
    const file = ctx.args.find(a => !a.startsWith('-'));
    if (!file) { ctx.stderr.write('Usage: xxd FILE\n'); return 1; }
    const fp = resolvePath(ctx.cwd, file);
    try {
      const data = vfs.readFile(fp);
      const len = Math.min(data.length, ctx.args.includes('-l') ? parseInt(ctx.args[ctx.args.indexOf('-l') + 1]) || 256 : 256);
      for (let i = 0; i < len; i += 16) {
        const hex = Array.from(data.slice(i, i + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(data.slice(i, i + 16)).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
        ctx.stdout.write(`${i.toString(16).padStart(8, '0')}: ${hex.padEnd(48)}  ${ascii}\n`);
      }
      return 0;
    } catch { ctx.stderr.write(`xxd: ${file}: No such file\n`); return 1; }
  };
}

// ── Registration ────────────────────────────────────────────────────────

/**
 * Wrap a sync/async command so it always returns Promise<number>.
 * The LIFO shell calls .then() on the return value of every command,
 * so raw numbers cause "E3(...).then is not a function".
 *
 * Also resolves ctx.stdin from a stream object to a string.
 * The shell passes stdin as an object with .readAll() when piping,
 * but our commands expect a plain string.
 */
/**
 * SHELL-R6-B2 follow-on: wrapStreaming for commands that handle pipe
 * readers directly (head, tail, etc — commands that can terminate
 * before the producer drains).
 *
 * Behavior:
 *   - If ctx.stdin is a terminal stdin (has .feed), drain buffered
 *     bytes to a string (same as wrap — terminal stdin's
 *     buffer-then-close pattern doesn't match streaming).
 *   - If ctx.stdin is a pipe reader (has .read), PASS IT THROUGH
 *     unchanged so the command can read line-by-line. The command
 *     is responsible for terminating itself (e.g. head -n N stops
 *     after N lines, triggering the pipeline-abort cascade from
 *     SHELL-R6-2).
 *   - String stdin / other shapes: same as wrap.
 */
function wrapStreaming(fn: CmdFn): (ctx: Ctx) => Promise<number> {
  return async (ctx: Ctx) => {
    try {
      if (ctx.stdin && typeof ctx.stdin !== 'string') {
        const stdinObj = ctx.stdin;
        const isTerminalStdin = typeof stdinObj.feed === 'function';
        if (isTerminalStdin) {
          const buf: string[] = Array.isArray(stdinObj.buffer)
            ? stdinObj.buffer.splice(0)
            : [];
          ctx.stdin = buf.join('');
        }
        // else: leave as pipe reader for the command to handle.
      }
      const result = fn(ctx);
      return await result;
    } catch (e) {
      ctx.stderr.write(`${errorText(e)}\n`);
      return 1;
    }
  };
}

function wrap(fn: CmdFn): (ctx: Ctx) => Promise<number> {
  return async (ctx: Ctx) => {
    try {
      // Resolve stdin: shell passes a stream object with .readAll() when piping.
      //
      // BUG-SWEEP fix (2026-05-11): the shell passes its
      // `terminalStdin` (an Ls instance) as ctx.stdin for EVERY command,
      // not just piped ones. Ls.readAll() loops until close(), which the
      // shell only triggers in its executeLine() finally — AFTER the
      // command returns. Pre-fix, our wrap awaited readAll() and
      // deadlocked: command waits for stdin EOF, shell waits for command.
      //
      // The fix is to distinguish the two stream shapes:
      //   - Pipe reader (Oi.reader): {read, readAll} only. Used when
      //     upstream `echo X |` feeds bytes; upstream calls close()
      //     after writing, so readAll() resolves quickly.
      //   - Terminal stdin (Ls): {feed, close, rawMode, read, readAll,
      //     isWaiting, ...}. close() runs ONLY after the command returns.
      //
      // We treat anything with a `feed` method (Ls signature) as the
      // terminal stdin and drain its already-buffered bytes synchronously
      // without awaiting EOF. Pipe readers (no `feed`) await readAll().
      if (ctx.stdin && typeof ctx.stdin !== 'string') {
        const stdinObj = ctx.stdin;
        const isTerminalStdin = typeof stdinObj.feed === 'function';
        if (isTerminalStdin) {
          // Drain any already-queued bytes (typically empty for the
          // first command on a line; non-empty if the user typed
          // text + Enter before the command was dispatched). DO NOT
          // await — that would wait for the user's next Ctrl-D.
          const buf: string[] = Array.isArray(stdinObj.buffer)
            ? stdinObj.buffer.splice(0)
            : [];
          ctx.stdin = buf.join('');
        } else if (typeof stdinObj.readAll === 'function') {
          // Pipe reader — upstream will close() after writing, so
          // readAll() resolves bounded.
          ctx.stdin = await stdinObj.readAll();
        } else if (typeof stdinObj.toString === 'function') {
          ctx.stdin = stdinObj.toString();
        }
      }
      const result = fn(ctx);
      return await result;
    } catch (e) {
      ctx.stderr.write(`${errorText(e)}\n`);
      return 1;
    }
  };
}

export function registerUnixCommands(
  registry: UnixCommandRegistry,
  sqliteVfs: SqliteVFS,
): void {
  registry.register('which', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkWhich(vfs, registry))));
  registry.register('whereis', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkWhereis(vfs, registry))));
  registry.register('command', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkCommand(vfs, registry))));
  registry.register('type', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkType(vfs, registry))));
  registry.register('env', wrap(mkEnv()));
  registry.register('export', wrap(mkExport()));
  registry.register('unset', wrap(mkUnset()));
  registry.register('clear', wrap(mkClear()));
  registry.register('date', wrap(mkDate()));
  registry.register('uptime', wrap(mkUptime()));
  registry.register('tree', wrap(withInvocationVfs(sqliteVfs, mkTree)));
  registry.register('find', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkFind(vfs, registry))));
  registry.register('grep', wrap(withInvocationVfs(sqliteVfs, mkGrep)));
  // SHELL-R6-B2: head uses streaming wrap so a pipe reader passes
  // through (head terminates after N lines, triggering the abort
  // cascade for upstream producers like `yes`).
  registry.register('head', wrapStreaming(withInvocationVfs(sqliteVfs, mkHead)));
  registry.register('tail', wrap(withInvocationVfs(sqliteVfs, mkTail)));
  registry.register('wc', wrap(withInvocationVfs(sqliteVfs, mkWc)));
  registry.register('sort', wrap(withInvocationVfs(sqliteVfs, mkSort)));
  registry.register('uniq', wrap(withInvocationVfs(sqliteVfs, mkUniq)));
  registry.register('sed', wrap(withInvocationVfs(sqliteVfs, mkSed)));
  registry.register('awk', wrap(withInvocationVfs(sqliteVfs, mkAwk)));
  registry.register('xargs', wrap(withInvocationVfs(sqliteVfs, (vfs) => mkXargs(vfs, registry))));
  registry.register('tee', wrap(withInvocationVfs(sqliteVfs, mkTee)));
  registry.register('du', wrap(withInvocationVfs(sqliteVfs, mkDu)));
  registry.register('diff', wrap(withInvocationVfs(sqliteVfs, mkDiff)));
  // Registry-level echo + cat for xargs cross-command dispatch.
  // Shell.builtins still wins for direct `echo X` invocations; this
  // entry is only reached when a command (xargs etc.) looks them up
  // via the registry path.
  registry.register('echo', wrap(mkEcho()));
  registry.register('cat', wrap(withInvocationVfs(sqliteVfs, mkCat)));
  registry.register('ls', wrap(withInvocationVfs(sqliteVfs, mkLs)));
  registry.register('rm', wrap(withInvocationVfs(sqliteVfs, mkRm)));
  registry.register('touch', wrap(withInvocationVfs(sqliteVfs, mkTouch)));
  registry.register('stat', wrap(withInvocationVfs(sqliteVfs, (v) => mkStat(v, sqliteVfs))));
  registry.register('base64', wrap(withInvocationVfs(sqliteVfs, mkBase64)));
  registry.register('seq', wrap(mkSeq()));
  registry.register('id', wrap(mkId(sqliteVfs)));
  registry.register('hostname', wrap(mkHostname()));
  registry.register('basename', wrap(mkBasename()));
  registry.register('dirname', wrap(mkDirname()));
  registry.register('realpath', wrap(withInvocationVfs(sqliteVfs, mkRealpath)));
  registry.register('printf', wrap(mkPrintf()));
  registry.register('true', wrap(mkTrue()));
  registry.register('false', wrap(mkFalse()));
  registry.register('readlink', wrap(withInvocationVfs(sqliteVfs, mkReadlink)));
  registry.register('sha256sum', wrap(withInvocationVfs(sqliteVfs, mkSha256sum)));
  registry.register('file', wrap(withInvocationVfs(sqliteVfs, mkFile)));
  registry.register('xxd', wrap(withInvocationVfs(sqliteVfs, mkXxd)));

  registry.register('chown', wrap(mkChown(sqliteVfs)));

  // ln — symlink stub (no-ops on VFS but doesn't error)
  /**
   * SHELL-FOLLOWUPS-4 (2026-05-11): real `ln -s` via SymlinkRegistry.
   * Pre-fix: ln -s did file-copy; modifications to the "link"
   * created a new file (no two-way reflection); readlink returned
   * empty.
   *
   * Now:
   *   - `ln -s TARGET LINKPATH` registers LINKPATH → TARGET in the
   *     symlink registry.
   *   - Real GNU `ln -s` doesn't require TARGET to exist (dangling
   *     symlinks are valid). We allow that.
   *   - Hard links (`ln` without -s) still do file-copy — Nimbus
   *     VFS doesn't expose inode-level hard-linking and that's
   *     documented out of scope.
   *
   * Subsequent operations (cat / ls / cat-via-redirect) need to
   * consult the registry to see through the symlink. That work
   * lives in mkCat / mkLs wrappers and the SqliteVFS read-path —
   * for v1, we wire it in the COMMANDS that need it (cat already
   * goes through Kernel.VFS which doesn't yet know about the
   * registry; we patch cat directly here to dereference symlinks).
   */
  registry.register('ln', wrap((ctx) => {
    const vfs = unixVfsFor(sqliteVfs, ctx.cred);
    const args = ctx.args;
    const symbolic = args.some(a => a === '-s' || (a.startsWith('-') && !a.startsWith('--') && a.includes('s')));
    const force = args.some(a => a === '-f' || (a.startsWith('-') && !a.startsWith('--') && a.includes('f')));
    const positional = args.filter(a => !a.startsWith('-'));
    if (positional.length < 2) {
      ctx.stderr.write('ln: missing operand\n');
      return 1;
    }
    const target = positional[0];  // what the link points TO
    const linkPath = positional[1];  // the link file itself
    const linkFp = resolvePath(ctx.cwd, linkPath);
    if (symbolic) {
      // Symbolic link via registry. Don't require target to exist.
      const reg = vfs.symlinks;
      // GNU `ln` without -f errors if link exists.
      if (!force && (vfs.exists(linkFp) || reg.isSymlink(linkFp))) {
        ctx.stderr.write(`ln: failed to create symbolic link '${linkPath}': File exists\n`);
        return 1;
      }
      // Remove existing real-file at linkPath if -f and not a symlink.
      if (force && vfs.exists(linkFp) && !reg.isSymlink(linkFp)) {
        try { vfs.unlink(linkFp); } catch { /* fail-soft */ }
      }
      reg.set(linkFp, target);
      return 0;
    }
    // Hard link mode (default): file-copy semantics (legacy behaviour).
    const srcFp = resolvePath(ctx.cwd, target);
    try {
      const content = vfs.readFileString(srcFp);
      vfs.writeFile(linkFp, content);
    } catch (e) {
      ctx.stderr.write(`ln: ${target}: ${errorText(e)}\n`);
      return 1;
    }
    return 0;
  }));

  registry.register('test', wrap(mkTest(sqliteVfs)));
  registry.register('[', wrap(mkTest(sqliteVfs)));

  // read — read a line (stub, returns empty for non-interactive)
  // shell-polish (2026-05-12): `read VAR` is registered here as a
  // NO-OP fallback (matches the pre-existing stub behaviour). The
  // REAL working implementation lives in src/session/init.ts as a
  // shell builtin (shellAny.builtins.set('read', ...)).
  //
  // Why two registrations: the interpreter executes registered
  // shell commands with `ctx.env = { ...this.config.env }` — a SHALLOW
  // COPY.
  // Mutating ctx.env inside a registered command therefore CANNOT
  // propagate the var-assignment back to the shell. Builtins, by
  // contrast, run inside the interp instance with direct access to
  // `this.env` (the real shell env). The wait builtin in shell/compat/r6 uses
  // the same workaround.
  //
  // Keep the registry stub so `type read` reports "shell builtin" and
  // `which read` doesn't error; the builtin always wins dispatch
  // (interp.executeSimpleCommand checks builtins.get BEFORE
  // registry.resolve — index-Djm2onjx.js:5182-5186).
  registry.register('read', wrap((ctx) => {
    const args = ctx.args.filter((a) => !a.startsWith('-'));
    const varName = args[0] || 'REPLY';
    ctx.env[varName] = '';
    return 0;
  }));

  // exit — exit with code
  registry.register('exit', wrap((ctx) => {
    return parseInt(ctx.args[0] || '0') || 0;
  }));

  // source / . — source a file (stub)
  registry.register('source', wrap(() => 0));
  registry.register('.', wrap(() => 0));

  // noop commands that scripts might call
  registry.register('set', wrap(() => 0));
  registry.register('shopt', wrap(() => 0));
  registry.register('trap', wrap(() => 0));
  registry.register('umask', createUmaskCommand());
  registry.register('su', createSuCommand());
  registry.register('sudo', createSudoCommand());
  registry.register('ulimit', wrap(() => 0));
}
