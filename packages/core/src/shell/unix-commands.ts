/**
 * unix-commands.ts — the Unix commands that need the shell's own machinery:
 * credentials, mounts, command resolution (which/type/command/xargs) and the
 * durable store's metadata. Every command is a real implementation; the
 * pure byte/text tools are the substrate's (substrate/lifo/commands), which
 * `textCommand` wraps where this module registers one of them.
 * `registerUnixCommands` at the end is the list.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { ProcessView } from '../runtime/process-files.js';
import { requireVfsCred, type VfsCred } from '../runtime/os-contracts.js';
import { dec, enc } from '../_shared/bytes.js';
import { errorText } from '../_shared/error-text.js';
import { shellEscape } from '../_shared/shell-quote.js';
import { NIMBUS_VERSION } from '../constants.js';
import type { VfsFileType as FileType } from '../vfs/vfs.js';
import type { ChildExit, Command, CommandInputStream, RunAsOptions } from '../substrate/lifo/commands/types.js';
import { resolveContext, type ResolveContext } from '../substrate/lifo/commands/registry.js';
import { resolutionOf, searchPath, type PathSearchResult } from './exec-dispatch.js';
import { BASH_BUILTINS } from '../substrate/lifo/shell/bash-builtins.js';
import sedCommand from '../substrate/lifo/commands/text/sed.js';
import grepCommand from '../substrate/lifo/commands/text/grep.js';
import tailCommand from '../substrate/lifo/commands/text/tail.js';
import wcCommand from '../substrate/lifo/commands/text/wc.js';
import sortCommand from '../substrate/lifo/commands/text/sort.js';
import uniqCommand from '../substrate/lifo/commands/text/uniq.js';
import catCommand from '../substrate/lifo/commands/fs/cat.js';
import * as checksum from '../substrate/lifo/commands/system/checksum.js';
import { isBrokenPipe } from '../substrate/lifo/utils/bytes-io.js';
import headCommand from '../substrate/lifo/commands/text/head.js';
import tacCommand from '../substrate/lifo/commands/text/tac.js';
import teeCommand from '../substrate/lifo/commands/io/tee.js';
import { parseArgs } from '../substrate/lifo/utils/args.js';
import { echoOutput, expandBackslashEscapes } from '../substrate/lifo/utils/backslash-escapes.js';
import { dirname, resolve } from '../substrate/lifo/utils/path.js';
import { encode } from '../substrate/lifo/utils/encoding.js';
import {
  findUnixGroupName,
  findUnixUserName,
  parseChownOwnership,
} from './unix-accounts.js';
import { createSuCommand, createSudoCommand, createUmaskCommand } from './elevation-commands.js';
import { isVfsError, syscallError, VFS_STRERROR, strerror } from '../vfs/vfs-error.js';
import { parseDateTime, realDay } from '../substrate/lifo/utils/parse-datetime.js';
import { globMatch } from '../substrate/lifo/utils/glob.js';
import { humanReadable, parseSuffixedCount } from '../substrate/lifo/utils/size-units.js';
import { formatUptime, uptimeSeconds } from '../substrate/lifo/utils/system-info.js';
import { isCharacterDevice, isDirectory, fileTypeChar, lstatOrThrow, statOrThrow } from '../vfs/vfs.js';
import { direntTypeIn } from '../vfs/dirent-type.js';

/**
 * stdin as the shell hands it over: a pipe reader, whose `readAll` resolves
 * once upstream closes (which may be never: a child process's stdin stays open
 * until its parent ends it), or the terminal's own stream, which stays open
 * past the command and is drained in place via `drainBuffered`.
 */
type ShellStdin = CommandInputStream & {
  feed?(text: string): void;
};

/**
 * The VFS the caller supplies. The shell hands the kernel's mount-aware tree,
 * so `/dev` and the other mounts resolve; an embedder that invokes a command
 * directly hands a credentialed durable view. `readdirStat` belongs to the
 * first and `isDirectory` to the second, which is why the paths that want
 * either one probe for it.
 */
type CtxVfs = ProcessView;

/**
 * A stat as either layer reports it. The kernel's tree leaves out what a mount
 * cannot know — ownership, access time — and that is what the fallbacks at the
 * use sites stand in for.
 */
type CtxStat = {
  type: FileType;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  atimeMs?: number;
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
  stdout: { write(s: string): void | Promise<void>; writeBytes?(bytes: Uint8Array): void | Promise<void> };
  stderr: { write(s: string): void | Promise<void> };
  cwd: string;
  env: Record<string, string>;
  /**
   * The shell's pipe reader, or text: what `wrap` leaves of a terminal's
   * stream, or what `stdinText` read of a pipe. A command that reads stdin
   * reads it itself, when it does (stdinText, or the stream); one that does
   * not never waits on it.
   */
  stdin?: string | ShellStdin;
  cred: VfsCred;
  vfs: CtxVfs;
  signal: AbortSignal;
  setUmask(mask: number): void;
  runAs(cred: VfsCred, argv: string[], options?: RunAsOptions): Promise<ChildExit>;
  execInterpreterDepth?: number;
};

type CmdFn = (ctx: Ctx) => number | Promise<number>;

type UnixVfs = ProcessView;

/**
 * A command the registry resolved. A runtime that is known but not installed
 * is stored as a stub carrying `__nimbusRuntimeInstallHint` (the worker's
 * `shell/npm-bin-entrypoints.ts` sets it), which `which` and `type` must not
 * report as a builtin.
 */
type ResolvedCommand = CmdFn & { __nimbusRuntimeInstallHint?: boolean };

/**
 * The registry these commands dispatch through: registration, and name
 * resolution for `which`, `type`, `command` and `xargs`.
 * `resolve` answers `unknown` because the registry holds whatever any module
 * registered — and the worker's npm-bin fallback replaces the method outright
 * — so what comes back is a command only once it has been checked.
 */
type UnixCommandRegistry = {
  register(name: string, handler: Command): void;
  resolve(name: string, from?: ResolveContext): unknown;
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
 * stdin as text, read to its end when a command asks for it (and kept in
 * `ctx.stdin`, for a command it dispatches); nothing at all when there was no
 * stdin. Only a command that reads its stdin waits for its end.
 */
async function stdinText(ctx: Ctx): Promise<string | undefined> {
  const stdin = ctx.stdin;
  if (stdin === undefined || typeof stdin === 'string') return stdin;
  ctx.stdin = await stdin.readAll();
  return ctx.stdin;
}

/**
 * A text command shared with the lifo registry: one implementation, reading
 * standard input as the byte stream it is, not a decoded string.
 */
function textCommand(command: Command): (ctx: Ctx) => Promise<number> {
  return wrap(withInvocationVfs(() => command as unknown as CmdFn));
}

/** `factory`'s command over the invocation's own view, once the call carries a credential. */
function withInvocationVfs(factory: (vfs: UnixVfs) => CmdFn): CmdFn {
  return async (ctx) => {
    requireVfsCred(ctx.cred, 'unix command dispatch');
    return (await factory(ctx.vfs)(ctx));
  };
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

async function unixUserLabel(vfs: UnixVfs, uid: number): Promise<string> {
  try {
    return (await findUnixUserName(vfs, uid)) ?? String(uid);
  } catch {
    return String(uid);
  }
}

async function unixGroupLabel(vfs: UnixVfs, gid: number): Promise<string> {
  try {
    return (await findUnixGroupName(vfs, gid)) ?? String(gid);
  } catch {
    return String(gid);
  }
}

function isRuntimeInstallHintHandler(handler: ResolvedCommand | null): boolean {
  return !!handler && !!handler.__nimbusRuntimeInstallHint;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * `p` as an absolute path, against `cwd`: the path a command's operand
 * names, which is also what its errors name (never a storage key).
 */
function resolvePath(cwd: string, p: string): string {
  return resolve(cwd || '/home/user', p);
}

async function readSymlinkTarget(vfs: UnixVfs, path: string): Promise<string | null> {
  return await vfs.isSymlink(path) ? (await vfs.readlink(path)) : null;
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
  // Hex dumps — the real tools live under /usr/bin on Unix
  od: '/usr/bin/od',
  hexdump: '/usr/bin/hexdump',
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

async function _registryResolved(
  registry: UnixCommandRegistry,
  name: string,
  from: ResolveContext,
  options: { includeInstallHints?: boolean } = {},
): Promise<ResolvedCommand | null> {
  try {
    const resolved = typeof registry.resolve === 'function'
      ? asResolvedCommand(await registry.resolve(name, from))
      : null;
    if (resolved && (options.includeInstallHints || !isRuntimeInstallHintHandler(resolved))) {
      return resolved;
    }
  } catch {
    // Registry misses are normal for unknown commands.
  }
  return null;
}

/**
 * The first executable named `name` that execvp's search of the caller's
 * PATH finds, as the caller sees the namespace. A directory that cannot be
 * read (an I/O error) finds nothing, as the stat of bash's and GNU which's
 * searches finds nothing there.
 */
async function _pathExecutable(name: string, from: ResolveContext): Promise<string | null> {
  let hit: PathSearchResult = null;
  try {
    hit = await searchPath(name, from);
  } catch (error) {
    if (!isVfsError(error)) throw error;
  }
  return hit?.kind === 'program' ? hit.path : null;
}

/**
 * Where a user sees a command the workspace knows by name (registered, an npm
 * bin, or a runtime it would install on first use): the first executable of
 * that name on PATH (a gem's wrapper in ~/.gem/bin), else the runtime's
 * canonical bin; null for a shell builtin.
 */
async function _knownCommandPath(name: string, from: ResolveContext): Promise<string | null> {
  return await _pathExecutable(name, from) ?? _CANONICAL_BIN_PATHS[name] ?? null;
}

/**
 * What `which` knows of a name, from one search of PATH: the executable file
 * on the caller's PATH, else, for a registered command, where a user sees
 * it; and whether the name is a registered command, which `which -a` calls a
 * shell built-in.
 */
async function _whichLookup(
  registry: UnixCommandRegistry,
  name: string,
  from: ResolveContext,
): Promise<{ path: string | null; builtin: boolean }> {
  if (name.includes('/')) return { path: null, builtin: false };
  const registered = await _registryResolved(registry, name, { ...from, search: false }, { includeInstallHints: true });
  const builtin = registered !== null && !isRuntimeInstallHintHandler(registered);
  if (registered !== null) return { path: await _knownCommandPath(name, from), builtin };
  return { path: await _pathExecutable(name, from), builtin };
}

/**
 * What `command -v`/`-V` and `type` report a name as: what runs it, at the
 * file a user sees. A program a search of PATH found is that file
 * (executable or not, as bash reports either); a path is itself; a command
 * that is one of bash's builtins is a shell builtin, whatever PATH holds of
 * its name, as bash classifies builtins before files; any other command the
 * workspace knows (external, runtime, npm or gem) is where
 * `_knownCommandPath` puts it, or else a shell builtin (a runtime's install
 * hint with no bin is not found). A resolution that failed is not found.
 */
async function _describeCommand(
  registry: UnixCommandRegistry,
  name: string,
  from: ResolveContext,
): Promise<{ kind: 'file'; path: string } | { kind: 'builtin' } | null> {
  const resolved = await _registryResolved(registry, name, from, { includeInstallHints: true });
  if (resolved === null) return null;
  const resolution = resolutionOf(resolved);
  if (resolution?.kind === 'failed') return null;
  if (resolution?.kind === 'program') return { kind: 'file', path: resolution.path };
  if (name.includes('/')) return { kind: 'file', path: name };
  const hint = isRuntimeInstallHintHandler(resolved);
  if (!hint && BASH_BUILTINS.has(name)) return { kind: 'builtin' };
  const path = await _knownCommandPath(name, from);
  if (path !== null) return { kind: 'file', path };
  return hint ? null : { kind: 'builtin' };
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
      (await ctx.stderr.write('Usage: which [-as] command [command ...]\n'));
      return 1;
    }
    let anyMissing = false;
    const from = resolveContext(ctx.cwd, ctx.env, vfs);
    for (const name of names) {
      const { path, builtin: isBuiltin } = await _whichLookup(registry, name, from);
      let found = false;
      if (path) {
        if (!silent) (await ctx.stdout.write(path + '\n'));
        found = true;
      }
      // 2. With -a, also report builtins (real GNU which behaviour).
      if (showAll && isBuiltin) {
        if (!silent) (await ctx.stdout.write(`${name}: shell built-in command\n`));
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
        if (!silent) (await ctx.stderr.write(`which: no ${name} in (${from.path})\n`));
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
      (await ctx.stderr.write('Usage: whereis name [name ...]\n'));
      return 1;
    }
    const from = resolveContext(ctx.cwd, ctx.env, vfs);
    for (const name of names) {
      const { path } = await _whichLookup(registry, name, from);
      if (path) {
        (await ctx.stdout.write(`${name}: ${path}\n`));
      } else {
        // GNU whereis prints just "name:" when nothing found.
        (await ctx.stdout.write(`${name}:\n`));
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
      (await ctx.stderr.write('command: missing operand\n'));
      return 1;
    }
    const from = resolveContext(ctx.cwd, ctx.env, vfs);
    if (mode === '-v' || mode === '-V') {
      const name = args[0];
      const described = await _describeCommand(registry, name, from);
      if (mode === '-v') {
        if (described === null) return 1;
        (await ctx.stdout.write(`${described.kind === 'file' ? described.path : name}\n`));
        return 0;
      }
      if (described === null) {
        (await ctx.stderr.write(`command: ${name}: not found\n`));
        return 1;
      }
      (await ctx.stdout.write(described.kind === 'file' ? `${name} is ${described.path}\n` : `${name} is a shell builtin\n`));
      return 0;
    }
    // invoke mode: dispatch directly via registry. Bypasses aliases
    // because we're calling the resolved cmd not the alias name.
    const name = args[0];
    try {
      const resolved = asResolvedCommand(await registry.resolve(name, from));
      if (!resolved) {
        (await ctx.stderr.write(`command: ${name}: not found\n`));
        return 127;
      }
      const subCtx = { ...ctx, args: args.slice(1) };
      const code = await resolved(subCtx);
      return typeof code === 'number' ? code : 0;
    } catch (e) {
      (await ctx.stderr.write(`command: ${name}: ${errorText(e)}\n`));
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
function mkType(vfs: UnixVfs, registry: UnixCommandRegistry): CmdFn {
  return async (ctx) => {
    if (ctx.args.length === 0) return 0;
    let exit = 0;
    const from = resolveContext(ctx.cwd, ctx.env, vfs);
    for (const name of ctx.args) {
      const described = await _describeCommand(registry, name, from);
      if (described === null) {
        (await ctx.stderr.write(`type: ${name}: not found\n`));
        exit = 1;
      } else {
        (await ctx.stdout.write(described.kind === 'file' ? `${name} is ${described.path}\n` : `${name} is a shell builtin\n`));
      }
    }
    return exit;
  };
}

function mkExport(): CmdFn {
  return async (ctx) => {
    for (const arg of ctx.args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        ctx.env[arg.substring(0, eqIdx)] = arg.substring(eqIdx + 1);
      } else if (ctx.env[arg] !== undefined) {
        (await ctx.stdout.write(`export ${arg}="${ctx.env[arg]}"\n`));
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

const ACL_BITS = { r: 4, w: 2, x: 1 } as const;

function aclTriple(bits: number): string {
  return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
}

/**
 * `setfacl -d -m u::rwx,g::rwx,o::r-x DIR` (a directory's default ACL base
 * entries) and `setfacl -k DIR` (remove it). Named users and groups are not
 * supported (EINVAL). The ACL is SQLite's directory attribute, set as the
 * invoking credential.
 */
function mkSetfacl(sqliteVfs: SqliteVFS): CmdFn {
  return async (ctx) => {
    const cred = requireVfsCred(ctx.cred, 'setfacl');
    const vfs = sqliteVfs.as(cred);
    let remove = false;
    let spec: string | null = null;
    let isDefault = false;
    const targets: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i]!;
      if (arg === '-k' || arg === '--remove-default') remove = true;
      else if (arg === '-d' || arg === '--default') isDefault = true;
      else if (arg === '-m' || arg === '--modify') spec = ctx.args[++i] ?? null;
      else if (arg.startsWith('-')) {
        for (const ch of arg.slice(1)) {
          if (ch === 'k') remove = true;
          else if (ch === 'd') isDefault = true;
          else if (ch === 'm') spec = ctx.args[++i] ?? null;
          else { (await ctx.stderr.write(`setfacl: unsupported option -${ch}\n`)); return 2; }
        }
      } else targets.push(arg);
    }
    if ((!remove && (spec === null || !isDefault)) || targets.length === 0) {
      (await ctx.stderr.write('usage: setfacl -d -m u::rwx,g::rwx,o::r-x DIR... | setfacl -k DIR...\n'));
      return 2;
    }
    for (const target of targets) {
      const path = resolvePath(ctx.cwd, target);
      try {
        if (remove) { vfs.setDefaultAcl(path, null); continue; }
        let perms = vfs.getDefaultAcl(path) ?? 0o755;
        for (const entry of spec!.split(',')) {
          const match = /^(u|user|g|group|o|other)::([rwx-]{0,3})$/.exec(entry.trim());
          if (!match) throw syscallError('EINVAL', 'setfacl', path, { detail: `only base entries (u::, g::, o::) are supported: ${entry}` });
          const bits = [...match[2]!].reduce((sum, ch) => sum | (ACL_BITS[ch as keyof typeof ACL_BITS] ?? 0), 0);
          const shift = match[1]![0] === 'u' ? 6 : match[1]![0] === 'g' ? 3 : 0;
          perms = (perms & ~(7 << shift)) | (bits << shift);
        }
        vfs.setDefaultAcl(path, perms);
      } catch (error) {
        (await ctx.stderr.write(`setfacl: ${target}: ${strerror(error)}\n`));
        return 1;
      }
    }
    return 0;
  };
}

/** `getfacl DIR...`: owner, group, the access entries and any default base entries. */
function mkGetfacl(sqliteVfs: SqliteVFS): CmdFn {
  return async (ctx) => {
    const cred = requireVfsCred(ctx.cred, 'getfacl');
    const vfs = sqliteVfs.as(cred);
    let status = 0;
    for (const target of ctx.args.filter((arg) => !arg.startsWith('-'))) {
      const path = resolvePath(ctx.cwd, target);
      try {
        const stat = vfs.stat(path);
        const perms = stat.mode & 0o777;
        const lines = [
          `# file: ${path.replace(/^\/+/, '')}`, `# owner: ${stat.uid}`, `# group: ${stat.gid}`,
          ...(stat.mode & 0o7000 ? [`# flags: ${stat.mode & 0o4000 ? 's' : '-'}${stat.mode & 0o2000 ? 's' : '-'}${stat.mode & 0o1000 ? 't' : '-'}`] : []),
          `user::${aclTriple(perms >> 6)}`, `group::${aclTriple(perms >> 3)}`, `other::${aclTriple(perms)}`,
        ];
        const acl = vfs.getDefaultAcl(path);
        if (acl !== null) lines.push(`default:user::${aclTriple(acl >> 6)}`, `default:group::${aclTriple(acl >> 3)}`, `default:other::${aclTriple(acl)}`);
        (await ctx.stdout.write(`${lines.join('\n')}\n\n`));
      } catch (error) {
        (await ctx.stderr.write(`getfacl: ${target}: ${strerror(error)}\n`));
        status = 1;
      }
    }
    return status;
  };
}

function mkClear(): CmdFn {
  return async (ctx) => { (await ctx.stdout.write('\x1b[2J\x1b[H')); return 0; };
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
  return async (ctx) => {
    const now = new Date();
    const useUtc = ctx.args.includes('-u') || ctx.args.includes('--utc');
    // Find the `+FMT` arg (if any). Real `date +FMT [args]` accepts
    // only one format; we honour the first.
    const fmtArg = ctx.args.find(a => a.startsWith('+'));
    if (fmtArg) {
      (await ctx.stdout.write(strftime(now, fmtArg.slice(1), useUtc) + '\n'));
      return 0;
    }
    if (ctx.args.includes('-I') || ctx.args.includes('--iso-8601')) {
      (await ctx.stdout.write(now.toISOString() + '\n'));
      return 0;
    }
    if (useUtc) {
      (await ctx.stdout.write(now.toUTCString() + '\n'));
      return 0;
    }
    (await ctx.stdout.write(now.toString() + '\n'));
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

/** uptime as procps prints it, counting from the shell's start (the registration below starts the clock). */
function mkUptime(): CmdFn {
  uptimeSeconds();
  return async (ctx) => {
    (await ctx.stdout.write(` ${new Date().toTimeString().split(' ')[0]} up ${formatUptime(uptimeSeconds())},  1 user\n`));
    return 0;
  };
}

/** tree: `-L n` bounds the depth (unbounded without it), `-d` lists directories alone. */
function mkTree(vfs: UnixVfs): CmdFn {
  return async (ctx) => {
    const level = ctx.args.indexOf('-L');
    const dirsOnly = ctx.args.includes('-d');
    // `-L n` takes the next word; the first other non-option word is the directory.
    const operand = ctx.args.find((a, i) => !a.startsWith('-') && (level === -1 || i !== level + 1)) ?? '.';
    const root = resolvePath(ctx.cwd, operand);
    const maxDepth = level === -1 ? Infinity : parseInt(ctx.args[level + 1]) || Infinity;
    const MAX_ENTRIES = 2000; // Safety limit to prevent hanging on huge repos
    let dirs = 0, files = 0, total = 0;
    let truncated = false;
    async function walk(path: string, prefix: string, depth: number) {
      if (depth > maxDepth || truncated) return;
      try {
        const listed = await Promise.all((await vfs.readdir(path)).map(async (e) => ({
          name: e.name,
          directory: (await direntTypeIn(vfs, path, e)) === 'directory',
        })));
        const entries = listed.filter((e) => !dirsOnly || e.directory).sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < entries.length; i++) {
          if (total >= MAX_ENTRIES) { truncated = true; return; }
          total++;
          const e = entries[i];
          const isLast = i === entries.length - 1;
          const connector = isLast ? '└── ' : '├── ';
          const childPrefix = isLast ? '    ' : '│   ';
          (await ctx.stdout.write(prefix + connector + e.name + '\n'));
          if (e.directory) {
            dirs++;
            (await walk(resolvePath(path, e.name), prefix + childPrefix, depth + 1));
          } else { files++; }
        }
      } catch {}
    }
    // tree prints the directory as the caller named it, and refuses one it cannot open.
    if (!(await isDirectory(vfs, root))) {
      (await ctx.stdout.write(`${operand}  [error opening dir]\n\n0 directories, 0 files\n`));
      return 2;
    }
    (await ctx.stdout.write(operand + '\n'));
    (await walk(root, '', 1));
    if (truncated) (await ctx.stdout.write(`\n... truncated at ${MAX_ENTRIES} entries\n`));
    (await ctx.stdout.write(dirsOnly ? `\n${dirs} directories\n` : `\n${dirs} directories, ${files} files\n`));
    return 0;
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
  return async (ctx) => {
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
    // A file operand is the input; stdin only without one.
    let input = '';
    if (fileArgs.length > 0) {
      try { input = (await vfs.readFileString(resolvePath(ctx.cwd, fileArgs[0]))); }
      catch { (await ctx.stderr.write(`awk: ${fileArgs[0]}: No such file\n`)); return 1; }
    } else {
      input = (await stdinText(ctx)) || '';
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
        if (src[cursor] !== '{') { (await ctx.stderr.write('awk: BEGIN without {\n')); return 1; }
        blocks.push({ kind: 'BEGIN', body: parseBraced() });
        continue;
      }
      if (src.startsWith('END', cursor)) {
        cursor += 3;
        skipWS();
        if (src[cursor] !== '{') { (await ctx.stderr.write('awk: END without {\n')); return 1; }
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
        catch (e) { (await ctx.stderr.write(`awk: bad regex /${patSrc}/: ${errorText(e)}\n`)); return 1; }
        blocks.push({ kind: 'PATTERN', pattern: re, body });
        continue;
      }
      if (src[cursor] === '{') {
        blocks.push({ kind: 'MAIN', body: parseBraced() });
        continue;
      }
      (await ctx.stderr.write(`awk: parse error at "${src.slice(cursor, cursor + 20)}"\n`));
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
    async function execStmt(stmt: string, st: State): Promise<void> {
      // print [expr[, expr]*]
      if (stmt === 'print' || stmt.startsWith('print ') || stmt.startsWith('print\t')) {
        const rest = stmt.slice(5).trim();
        if (!rest) { (await ctx.stdout.write(st.fields[0] + '\n')); st.printed = true; return; }
        // Comma-separated exprs (space joiner). We must split at top-level commas only.
        const parts = splitTopLevel(rest, ',');
        const out = parts.map(p => stringify(evalExpr(p, st))).join(' ');
        (await ctx.stdout.write(out + '\n'));
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
        (await ctx.stdout.write(printfFormat(String(fmt), fargs)));
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

    async function runBlock(block: Block): Promise<void> {
      const stmts = splitStmts(block.body);
      for (const s of stmts) {
        (await execStmt(s, state));
      }
    }

    try {
      // BEGIN blocks first.
      for (const b of blocks) if (b.kind === 'BEGIN') (await runBlock(b));
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
            if (b.pattern!.test(line)) (await runBlock(b));
          } else {
            // MAIN block (no pattern) — always runs.
            (await runBlock(b));
          }
        }
      }
      // END blocks last.
      for (const b of blocks) if (b.kind === 'END') (await runBlock(b));
    } catch (e) {
      (await ctx.stderr.write(`awk: ${errorText(e)}\n`));
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
    const input = (await stdinText(ctx)) || '';
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
      target = asResolvedCommand(await registry.resolve(cmdName, resolveContext(ctx.cwd, ctx.env, ctx.vfs)));
    } catch { target = null; }
    if (!target) {
      // Defer to write-to-stderr; mimic real xargs which would exec(2) and fail.
      (await ctx.stderr.write(`xargs: ${cmdName}: command not found\n`));
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
          (await ctx.stderr.write(`xargs: ${cmdName}: ${errorText(e)}\n`));
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
          (await ctx.stderr.write(`xargs: ${cmdName}: ${errorText(e)}\n`));
          exit = 1;
        }
        if (!Number.isFinite(batchSize)) break;  // single batch when no -n
      }
    }
    return exit;
  };
}

/**
 * du -B's block size: a count with GNU's suffixes for it. A unit with no
 * count (`K`, `MB`, `KiB`) is also what du prints after each size: the
 * letter as GNU spells it (`k` for the 1000-based kilo, else upper case)
 * and its `B` or `iB`.
 */
function parseDuBlockSize(text: string): { bytes: number; suffix: string } | null {
  const bytes = parseSuffixedCount(text, 'EgGkKmMPtTYZ0');
  if (bytes === null) return null;
  const unit = /^([a-zA-Z])(iB|B)?$/.exec(text);
  if (unit === null) return { bytes, suffix: '' };
  const letter = unit[2] === 'B' && unit[1].toLowerCase() === 'k' ? 'k' : unit[1].toUpperCase();
  return { bytes, suffix: letter + (unit[2] ?? '') };
}

/**
 * du: disk usage, as GNU du reports it. The VFS allocates a file ceil(size /
 * 512) 512-byte blocks (stat's %b), a directory or a link none; with
 * --apparent-size (-b) a file or link counts its size. Each operand (default
 * `.`) is printed as named, its descendants below it with '/', directories
 * after what they hold, down to -d levels. An entry that cannot be read is
 * reported and skipped, and du then exits 1, as GNU does.
 */
function mkDu(vfs: UnixVfs): CmdFn {
  return async (ctx) => {
    let showAll = false, sumOnly = false, total = false, apparent = false, separateDirs = false, nul = false;
    let countLinks = false;
    let human: 1024 | 1000 | null = null;
    let block = { bytes: 1024, suffix: '' };
    let maxDepth: number | null = null;
    let threshold = 0;
    let follow: 'never' | 'operands' | 'always' = 'never';
    const excludes: string[] = [];
    const operands: string[] = [];
    const usage = async (text: string) => {
      await ctx.stderr.write(`du: ${text}\nTry 'du --help' for more information.\n`);
      return 1;
    };
    const setBlock = async (text: string, option: string) => {
      const size = parseDuBlockSize(text);
      if (!size || size.bytes <= 0) { await ctx.stderr.write(`du: invalid ${option} argument '${text}'\n`); return false; }
      block = size;
      human = null;
      return true;
    };
    const setDepth = async (text: string) => {
      if (!/^\d+$/.test(text)) { await usage(`invalid maximum depth '${text}'`); return false; }
      maxDepth = Number(text);
      return true;
    };
    const setThreshold = async (text: string) => {
      // A signed count in base 0 (0x hex, 0 octal), as GNU's xstrtoimax reads it.
      const negative = text.startsWith('-');
      const bytes = parseSuffixedCount(negative ? text.slice(1) : text, 'kKmMGTPEZYRQ0', 0);
      if (bytes === null || (bytes === 0 && negative)) { await usage(`invalid --threshold argument '${text}'`); return false; }
      threshold = negative ? -bytes : bytes;
      return true;
    };
    const args = ctx.args;
    let options = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!options || a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
      if (a === '--') { options = false; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq < 0 ? a : a.slice(0, eq);
        const valued = ['--max-depth', '--block-size', '--threshold', '--exclude'];
        let value: string | undefined = eq < 0 ? undefined : a.slice(eq + 1);
        if (valued.includes(name) && value === undefined) {
          value = args[++i];
          if (value === undefined) return await usage(`option '${name}' requires an argument`);
        }
        switch (name) {
          case '--all': showAll = true; break;
          case '--human-readable': human = 1024; break;
          case '--si': human = 1000; break;
          case '--summarize': sumOnly = true; break;
          case '--total': total = true; break;
          case '--apparent-size': apparent = true; break;
          case '--bytes': apparent = true; block = { bytes: 1, suffix: '' }; human = null; break;
          case '--kilobytes': block = { bytes: 1024, suffix: '' }; human = null; break;
          case '--megabytes': block = { bytes: 1024 * 1024, suffix: '' }; human = null; break;
          case '--separate-dirs': separateDirs = true; break;
          case '--null': nul = true; break;
          case '--dereference': follow = 'always'; break;
          case '--dereference-args': follow = 'operands'; break;
          case '--no-dereference': follow = 'never'; break;
          case '--count-links': countLinks = true; break;
          case '--one-file-system': break;
          case '--max-depth': if (!(await setDepth(value!))) return 1; break;
          case '--block-size': if (!(await setBlock(value!, '--block-size'))) return 1; break;
          case '--threshold': if (!(await setThreshold(value!))) return 1; break;
          case '--exclude': excludes.push(value!); break;
          case '--time': case '--time-style': case '--exclude-from': case '--files0-from': case '--inodes':
            await ctx.stderr.write(`du: ${name} is not supported here\n`);
            return 1;
          default: return await usage(`unrecognized option '${a}'`);
        }
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        const valued = 'dBt'.includes(ch);
        const value = valued ? (a.slice(j + 1) || args[++i]) : undefined;
        if (valued && value === undefined) return await usage(`option requires an argument -- '${ch}'`);
        switch (ch) {
          case 'a': showAll = true; break;
          case 'h': human = 1024; break;
          case 's': sumOnly = true; break;
          case 'c': total = true; break;
          case 'b': apparent = true; block = { bytes: 1, suffix: '' }; human = null; break;
          case 'k': block = { bytes: 1024, suffix: '' }; human = null; break;
          case 'm': block = { bytes: 1024 * 1024, suffix: '' }; human = null; break;
          case 'S': separateDirs = true; break;
          case '0': nul = true; break;
          case 'L': follow = 'always'; break;
          case 'H': case 'D': follow = 'operands'; break;
          case 'P': follow = 'never'; break;
          case 'l': countLinks = true; break;
          case 'x': break;
          case 'd': if (!(await setDepth(value!))) return 1; break;
          case 'B': if (!(await setBlock(value!, '-B'))) return 1; break;
          case 't': if (!(await setThreshold(value!))) return 1; break;
          case 'X':
            await ctx.stderr.write('du: -X is not supported here\n');
            return 1;
          default: return await usage(`invalid option -- '${ch}'`);
        }
        if (valued) break;
      }
    }
    if (showAll && sumOnly) return await usage('cannot both summarize and show all entries');
    if (sumOnly && maxDepth !== null && maxDepth !== 0) return await usage(`warning: summarizing conflicts with --max-depth=${maxDepth}`);
    if (sumOnly && maxDepth === 0) await ctx.stderr.write('du: warning: summarizing is the same as using --max-depth=0\n');
    if (sumOnly) maxDepth = 0;
    if (operands.length === 0) operands.push('.');
    const end = nul ? '\0' : '\n';
    const fmt = (bytes: number) => (human !== null
      ? humanReadable(bytes, human)
      : `${Math.ceil(bytes / block.bytes)}${block.suffix}`);
    const usageOf = (st: { type: string; size: number }) => (apparent
      ? (st.type === 'directory' ? 0 : st.size)
      : (st.type === 'file' ? Math.ceil(st.size / 512) * 512 : 0));
    const shown = (bytes: number) => (threshold >= 0 ? bytes >= threshold : bytes <= -threshold);
    // --exclude's patterns are fnmatch's, as GNU du reads them: `*` crosses a `/`.
    const excluded = (name: string, path: string) => excludes.some((pattern) => globMatch(pattern, name) || globMatch(pattern, path));
    let failed = false;
    let grand = 0;
    const seen = new Set<string>();
    const why = (e: unknown) => {
      const code = (e as { code?: string })?.code;
      return code === 'EACCES' ? 'Permission denied' : code === 'ENOTDIR' ? 'Not a directory' : 'No such file or directory';
    };
    // Bytes at and below `vfsPath`, printed as `name` (a directory under -S: its own files only).
    // The directories on the current path, by (dev, ino): one met again is a
    // cycle a followed link made, and is skipped, unlisted, as GNU's fts does.
    const onPath = new Set<string>();
    async function walk(vfsPath: string, name: string, depth: number): Promise<{ size: number; dir: boolean }> {
      let st;
      const following = follow === 'always' || (follow === 'operands' && depth === 0);
      try {
        st = following ? await statOrThrow(vfs, vfsPath) : await lstatOrThrow(vfs, vfsPath);
        // A directory reached through a link is walked from where it is, as fts
        // walks by descriptor: its children are never resolved through the
        // link again (a path through `loop -> .` would grow without end).
        if (following && st.type === 'directory') vfsPath = await vfs.realpath(vfsPath);
      } catch (e) {
        await ctx.stderr.write(`du: cannot access '${name}': ${why(e)}\n`);
        failed = true;
        return { size: 0, dir: false };
      }
      const printable = maxDepth === null || depth <= maxDepth;
      // Each inode counts once (a hard link, or a link -L follows to a file
      // already counted), unless -l; one met again is not listed either.
      const inode = `${st.dev ?? 0}:${st.ino ?? vfsPath}`;
      if (st.type === 'directory' && onPath.has(inode)) return { size: 0, dir: true };
      if (!countLinks && seen.has(inode)) return { size: 0, dir: st.type === 'directory' };
      seen.add(inode);
      if (st.type !== 'directory') {
        const size = usageOf(st);
        if ((depth === 0 || showAll) && printable && shown(size)) await ctx.stdout.write(`${fmt(size)}\t${name}${end}`);
        return { size, dir: false };
      }
      let size = usageOf(st);
      let own = size;
      const base = name.endsWith('/') ? name : `${name}/`;
      let entries: { name: string }[] = [];
      try {
        entries = await vfs.readdir(vfsPath);
      } catch (e) {
        await ctx.stderr.write(`du: cannot read directory '${name}': ${why(e)}\n`);
        failed = true;
      }
      onPath.add(inode);
      for (const e of entries) {
        const childName = `${base}${e.name}`;
        if (excluded(e.name, childName)) continue;
        const child = await walk(`${vfsPath}/${e.name}`, childName, depth + 1);
        size += child.size;
        if (!child.dir) own += child.size;
      }
      onPath.delete(inode);
      const printed = separateDirs ? own : size;
      if (printable && shown(printed)) await ctx.stdout.write(`${fmt(printed)}\t${name}${end}`);
      return { size, dir: true };
    }
    for (const operand of operands) {
      grand += (await walk(resolvePath(ctx.cwd, operand), operand, 0)).size;
    }
    if (total) await ctx.stdout.write(`${fmt(grand)}\ttotal${end}`);
    return failed ? 1 : 0;
  };
}

/**
 * pwd(1) as coreutils' program, for what starts one without a shell (find
 * -execdir, xargs, sudo): the working directory with every link resolved,
 * or, under -L (the default with POSIXLY_CORRECT), $PWD when it is an
 * absolute name of that directory with no `.` or `..` in it.
 */
function mkPwd(vfs: UnixVfs): CmdFn {
  return async (ctx) => {
    let logical = ctx.env.POSIXLY_CORRECT !== undefined;
    let operands = 0;
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '--') {
        operands += ctx.args.length - i - 1;
        break;
      }
      if (arg === '--logical' || arg === '--physical') {
        logical = arg === '--logical';
      } else if (arg === '--version') {
        (await ctx.stdout.write(`pwd (nimbus coreutils) ${NIMBUS_VERSION}\n`));
        return 0;
      } else if (arg.startsWith('--')) {
        (await ctx.stderr.write(`pwd: unrecognized option '${arg}'\nTry 'pwd --help' for more information.\n`));
        return 1;
      } else if (arg.startsWith('-') && arg !== '-') {
        for (const letter of arg.slice(1)) {
          if (letter !== 'L' && letter !== 'P') {
            (await ctx.stderr.write(`pwd: invalid option -- '${letter}'\nTry 'pwd --help' for more information.\n`));
            return 1;
          }
          logical = letter === 'L';
        }
      } else {
        operands++;
      }
    }
    if (operands > 0) (await ctx.stderr.write('pwd: ignoring non-option arguments\n'));
    let physical: string;
    try {
      physical = await vfs.realpath(ctx.cwd);
    } catch (error) {
      if (!isVfsError(error)) throw error;
      (await ctx.stderr.write(`pwd: ${VFS_STRERROR[error.code]}\n`));
      return 1;
    }
    const named = ctx.env.PWD;
    if (logical && named !== undefined && named.startsWith('/') && !named.split('/').some((part) => part === '.' || part === '..')) {
      const same = await vfs.realpath(named).then((path) => path === physical, (error: unknown) => {
        if (isVfsError(error)) return false;
        throw error;
      });
      if (same) {
        (await ctx.stdout.write(`${named}\n`));
        return 0;
      }
    }
    (await ctx.stdout.write(`${physical}\n`));
    return 0;
  };
}

/**
 * echo for what runs it by name rather than through the shell (`xargs echo`,
 * `find -exec echo`): the builtin's own output, from the one echoOutput.
 */
function mkEcho(): CmdFn {
  return async (ctx) => { (await ctx.stdout.write(echoOutput(ctx.args))); return 0; };
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
 *   - `ls` lists every entry the filesystem reports for the directory; a
 *     host authority includes its legacy SymlinkRegistry entries there.
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
  return async (ctx) => {
    const args = ctx.args;
    const flags = new Set(args
      .filter((arg) => arg.startsWith('-') && !arg.startsWith('--'))
      .flatMap((arg) => [...arg.slice(1)]));
    const flagLong = flags.has('l') || flags.has('n');
    const flagAll = flags.has('a');
    const flagOne = flags.has('1');
    const flagNumeric = flags.has('n');
    const flagDirectory = flags.has('d');
    // GNU: -L follows every link, -H every command-line link; with neither,
    // a command-line link to a directory is followed unless -l, -d or -F.
    const followOperands = flags.has('L') || flags.has('H');
    const followDirOperands = !followOperands && !flagLong && !flagDirectory && !flags.has('F');
    const positionals = args.filter(a => !a.startsWith('-'));
    const targets = positionals.length > 0 ? positionals : [ctx.cwd];

    const kvfs = ctx.vfs;

    function fmtTime(mtimeMs: number): string {
      const d = new Date(mtimeMs);
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
      mtimeMs: number;
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
      mtimeMs: number;
      mode: number;
      uid?: number;
      gid?: number;
    };

    let exit = 0;

    async function listDir(dirPath: string): Promise<Entry[]> {
      const fp = resolvePath(ctx.cwd, dirPath);
      const out: Entry[] = [];
      // One listing for every entry: ctx.vfs handles mounts like /dev, and a
      // host authority reports legacy registry symlinks here too.
      let real: ListedEntry[] = [];
      try {
        real = await kvfs.readdirStat(fp);
      } catch (e) {
        (await ctx.stderr.write(`ls: cannot access '${dirPath}': ${strerror(e)}\n`));
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
          mtimeMs: r.mtimeMs ?? Date.now(),
          mode: r.mode ?? 0o644,
          uid: r.uid ?? ctx.cred.uid,
          gid: r.gid ?? ctx.cred.gid,
          ...(type === 'symlink'
            ? { linkTarget: (await readSymlinkTarget(vfs, childPath)) ?? undefined }
            : {}),
        });
      }
      // Filter dotfiles among real entries unless -a.
      const filtered = flagAll ? out : out.filter(e => !e.name.startsWith('.'));
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      return filtered;
    }

    async function fmtRow(e: Entry, long: boolean): Promise<string> {
      if (!long) return e.name;
      const isDir = e.type === 'directory';
      const isLink = e.type === 'symlink';
      const mode = unixModeString(e.mode, isDir, isLink);
      const size = String(e.size).padStart(6, ' ');
      const time = fmtTime(e.mtimeMs);
      const arrow = isLink && e.linkTarget ? ` -> ${e.linkTarget}` : '';
      const user = flagNumeric ? String(e.uid) : (await unixUserLabel(vfs, e.uid));
      const group = flagNumeric ? String(e.gid) : (await unixGroupLabel(vfs, e.gid));
      return `${mode}  1 ${user} ${group} ${size} ${time} ${e.name}${arrow}`;
    }

    // First pass: separate file-args from dir-args (real `ls` lists
    // each file inline; dirs get listed as their contents).
    const fileEntries: Entry[] = [];
    const dirArgs: string[] = [];
    for (const arg of targets) {
      const fp = resolvePath(ctx.cwd, arg);
      // A link operand is shown as the link itself unless followed (above).
      const target = (await readSymlinkTarget(vfs, fp));
      const followed = target !== null && (followOperands || (followDirOperands && (await kvfs.isDirectory(fp))));
      if (target !== null && !followed) {
        fileEntries.push({
          name: arg,
          type: 'symlink',
          size: target.length,
          mtimeMs: Date.now(),
          mode: 0o777,
          uid: ctx.cred.uid,
          gid: ctx.cred.gid,
          linkTarget: target,
        });
        continue;
      }
      try {
        const s: CtxStat = kvfs && typeof kvfs.stat === 'function' ? (await statOrThrow(kvfs, fp)) : (await statOrThrow(vfs, fp));
        if (s.type === 'directory' && !flagDirectory) {
          dirArgs.push(arg);
        } else {
          fileEntries.push({
            name: arg,
            type: s.type === 'directory' ? 'directory' : 'file',
            size: s.size ?? 0,
            mtimeMs: s.mtimeMs ?? Date.now(),
            mode: s.mode ?? 0o644,
            uid: s.uid ?? ctx.cred.uid,
            gid: s.gid ?? ctx.cred.gid,
          });
        }
      } catch (e) {
        (await ctx.stderr.write(`ls: cannot access '${arg}': ${strerror(e)}\n`));
        exit = 1;
      }
    }

    // Render file-args first.
    if (fileEntries.length > 0) {
      if (flagLong) {
        for (const e of fileEntries) (await ctx.stdout.write((await fmtRow(e, true)) + '\n'));
      } else if (flagOne) {
        for (const e of fileEntries) (await ctx.stdout.write(e.name + '\n'));
      } else {
        (await ctx.stdout.write(fileEntries.map(e => e.name).join('  ') + '\n'));
      }
    }
    // Then dir-args (with header if multiple).
    for (let i = 0; i < dirArgs.length; i++) {
      const d = dirArgs[i];
      if (dirArgs.length > 1 || fileEntries.length > 0) {
        if (fileEntries.length > 0 || i > 0) (await ctx.stdout.write('\n'));
        (await ctx.stdout.write(`${d}:\n`));
      }
      const rows = (await listDir(d));
      if (flagLong) {
        for (const e of rows) (await ctx.stdout.write((await fmtRow(e, true)) + '\n'));
      } else if (flagOne) {
        for (const e of rows) (await ctx.stdout.write(e.name + '\n'));
      } else if (rows.length > 0) {
        (await ctx.stdout.write(rows.map(e => e.name).join('  ') + '\n'));
      }
    }
    return exit;
  };
}

/**
 * POSIX rm: -f makes a missing target no error (exit 0), -r removes a
 * directory tree, and a failure is reported with the POSIX text.
 */
function mkRm(vfs: UnixVfs): CmdFn {
  return async ctx => {
    const recursive = ctx.args.some(arg => /^-[^-]*[rR]/.test(arg) || arg === '--recursive');
    const force = ctx.args.some(arg => /^-[^-]*f/.test(arg) || arg === '--force');
    const targets = ctx.args.filter(arg => !arg.startsWith('-'));
    if (!targets.length) { if (force) return 0; await ctx.stderr.write('rm: missing operand\n'); return 1; }
    let code = 0;
    for (const target of targets) {
      try { await vfs.remove(resolvePath(ctx.cwd, target), { recursive, force }); }
      catch (error) { await ctx.stderr.write(`rm: cannot remove '${target}': ${strerror(error)}\n`); code = 1; }
    }
    return code;
  };
}

/** A `touch -t` stamp, `[[CC]YY]MMDDhhmm[.ss]`, in UTC, or null. Two-digit years 69-99 are 19xx, 00-68 20xx. */
function parseTouchStamp(text: string, now: number): number | null {
  const m = /^(\d{8}|\d{10}|\d{12})(?:\.(\d{2}))?$/.exec(text);
  if (!m) return null;
  const digits = m[1];
  let year = new Date(now).getUTCFullYear();
  let rest = digits;
  if (digits.length === 12) { year = Number(digits.slice(0, 4)); rest = digits.slice(4); }
  if (digits.length === 10) { const yy = Number(digits.slice(0, 2)); year = yy >= 69 ? 1900 + yy : 2000 + yy; rest = digits.slice(2); }
  const [mo, d, h, mi] = [0, 2, 4, 6].map((i) => Number(rest.slice(i, i + 2)));
  const sec = m[2] ? Number(m[2]) : 0;
  // A calendar day that does not exist (Feb 31) is refused, as GNU refuses it.
  if (!realDay(year, mo, d) || h > 23 || mi > 59 || sec > 60) return null;
  return Date.UTC(year, mo - 1, d, h, mi, sec);
}

/** An error's errno name, as the filesystem gave it. */
function touchErrno(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'EIO';
}

/**
 * touch, as GNU touch: each file's atime and mtime to now, to a -d date, a
 * -t stamp or a -r file's; -a only atime, -m only mtime (--time=atime|mtime);
 * a missing file is created empty unless -c. A missing parent directory is an
 * error, as it is for open(2).
 */
function mkTouch(vfs: UnixVfs): CmdFn {
  return async (ctx) => {
    const targetVfs = ctx.vfs ?? vfs;
    const usage = async (text: string) => {
      await ctx.stderr.write(`touch: ${text}\nTry 'touch --help' for more information.\n`);
      return 1;
    };
    let onlyAtime = false, onlyMtime = false, noCreate = false, noDereference = false;
    let date: string | null = null, stamp: string | null = null, reference: string | null = null;
    const files: string[] = [];
    let options = true;
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!options || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
      if (a === '--') { options = false; continue; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq < 0 ? a : a.slice(0, eq);
        const takesValue = ['--date', '--reference', '--time'].includes(name);
        let value: string | undefined = eq < 0 ? undefined : a.slice(eq + 1);
        if (takesValue && value === undefined) {
          value = args[++i];
          if (value === undefined) return await usage(`option '${name}' requires an argument`);
        }
        if (name === '--no-create') noCreate = true;
        else if (name === '--no-dereference') noDereference = true;
        else if (name === '--date') date = value!;
        else if (name === '--reference') reference = value!;
        else if (name === '--time') {
          if (value === 'atime' || value === 'access' || value === 'use') onlyAtime = true;
          else if (value === 'mtime' || value === 'modify') onlyMtime = true;
          else return await usage(`invalid argument '${value}' for '--time'`);
        } else return await usage(`unrecognized option '${a}'`);
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'a') onlyAtime = true;
        else if (ch === 'm') onlyMtime = true;
        else if (ch === 'c') noCreate = true;
        else if (ch === 'h') noDereference = true;
        else if (ch === 'f') { /* ignored by GNU too */ }
        else if (ch === 'd' || ch === 't' || ch === 'r') {
          const value = a.slice(j + 1) || args[++i];
          if (value === undefined) return await usage(`option requires an argument -- '${ch}'`);
          if (ch === 'd') date = value; else if (ch === 't') stamp = value; else reference = value;
          break;
        } else return await usage(`invalid option -- '${ch}'`);
      }
    }
    if (files.length === 0) return await usage('missing file operand');
    const now = Date.now();
    // null is "now" (UTIME_NOW), which needs only write permission, as GNU
    // touch asks for when no time is given; an explicit time needs ownership.
    let atime: number | null = null, mtime: number | null = null;
    if (reference !== null) {
      try {
        const st = await statOrThrow(targetVfs, resolvePath(ctx.cwd, reference));
        atime = st.atimeMs;
        mtime = st.mtimeMs;
      } catch {
        await ctx.stderr.write(`touch: failed to get attributes of '${reference}': No such file or directory\n`);
        return 1;
      }
    }
    if (date !== null) {
      const at = parseDateTime(date, now);
      if (at === null) { await ctx.stderr.write(`touch: invalid date format '${date}'\n`); return 1; }
      atime = mtime = at;
    }
    if (stamp !== null) {
      const at = parseTouchStamp(stamp, now);
      if (at === null) { await ctx.stderr.write(`touch: invalid date format '${stamp}'\n`); return 1; }
      atime = mtime = at;
    }
    // -a and -m together, or neither, set both; the other is left (UTIME_OMIT).
    const setAtime = onlyAtime || !onlyMtime;
    const setMtime = onlyMtime || !onlyAtime;
    const times = [setAtime ? atime : undefined, setMtime ? mtime : undefined] as const;
    let code = 0;
    for (const f of files) {
      // `-` is standard output: its times are the terminal's, not a file named '-'.
      if (f === '-') continue;
      const fp = resolvePath(ctx.cwd, f);
      try {
        if (noDereference) {
          // -h: a link's own times (lutimes), never its target's, and nothing
          // created (-h implies -c).
          const own = await targetVfs.stat(fp, { follow: false }).catch(() => null);
          if (!own) continue;
          await targetVfs.utimes(fp, times[0], times[1], { follow: false });
          continue;
        }
        // GNU's order (touch.c): open(O_WRONLY|O_CREAT) unless -c, noting its
        // errno; then set the times. Only a failure to set them is reported,
        // as the open's errno when it failed ("cannot touch"), else as the
        // time-setting errno ("setting times of"). -c on a missing file is
        // silence.
        let openErrno: string | null = null;
        const exists = await targetVfs.exists(fp);
        if (!noCreate) {
          if (exists) {
            try { await targetVfs.access(fp, 2); } catch (e) { openErrno = touchErrno(e); }
          } else {
            // open(O_CREAT) makes the file, never its directory (the VFS's writeFile would).
            const parent = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/')) : '';
            if (parent && !(await targetVfs.isDirectory(parent))) {
              openErrno = (await targetVfs.exists(parent)) ? 'ENOTDIR' : 'ENOENT';
            } else {
              try { await targetVfs.writeFile(fp, ''); } catch (e) { openErrno = touchErrno(e); }
            }
          }
        }
        try {
          if (!exists && (noCreate || openErrno)) throw Object.assign(new Error(fp), { code: 'ENOENT' });
          await targetVfs.utimes(fp, times[0], times[1]);
        } catch (e) {
          const errno = touchErrno(e);
          if (openErrno) {
            await ctx.stderr.write(`touch: cannot touch '${f}': ${strerror({ code: openErrno })}\n`);
            code = 1;
          } else if (!(noCreate && errno === 'ENOENT')) {
            await ctx.stderr.write(`touch: setting times of '${f}': ${strerror({ code: errno })}\n`);
            code = 1;
          }
        }
      } catch (e) {
        await ctx.stderr.write(`touch: cannot touch '${f}': ${strerror(e)}\n`);
        code = 1;
      }
    }
    return code;
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
 *     filesystem that does not record it. Change time (%z/%Z) is the
 *     inode's ctime.
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
  atimeMs: number;
  mtimeMs: number;
  ctimeMs?: number;
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
  const changeTime = stat.ctimeMs ?? stat.mtimeMs;
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
    case 'Y': return String(Math.floor(stat.mtimeMs / 1000));
    case 'y': return new Date(stat.mtimeMs).toISOString();
    case 'X': return String(Math.floor(stat.atimeMs / 1000));
    case 'x': return new Date(stat.atimeMs).toISOString();
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
  return async (ctx) => {
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
          (await ctx.stderr.write(`stat: option '${arg}' requires an argument\n`));
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
          (await ctx.stderr.write(`stat: invalid argument '${mode}' for '--cached'\n`));
          return 1;
        }
        // Attributes are read live from the VFS, which satisfies every mode.
      } else if (arg === '--help') {
        (await ctx.stdout.write(STAT_USAGE));
        return 0;
      } else if (arg === '--version') {
        (await ctx.stdout.write(`stat (nimbus coreutils) ${NIMBUS_VERSION}\n`));
        return 0;
      } else if (arg === '--') {
        files.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith('-') && arg !== '-') {
        (await ctx.stderr.write(`stat: invalid option '${arg}'\n`));
        (await ctx.stderr.write(STAT_USAGE));
        return 1;
      } else {
        files.push(arg);
      }
    }

    if (files.length === 0) {
      (await ctx.stderr.write('stat: missing operand\n'));
      return 1;
    }

    const write = async (text: string) => {
      (await ctx.stdout.write(formatAddsNewline ? text + '\n' : text));
    };

    if (fileSystemMode) {
      const stats = sqliteVfs.getStats();
      const usage = sqliteVfs.storageUsage();
      const facts: StatFsFacts = {
        blockSize: STAT_IO_BLOCK_SIZE,
        totalBlocks: Math.floor(usage.size / STAT_IO_BLOCK_SIZE),
        freeBlocks: Math.floor(usage.available / STAT_IO_BLOCK_SIZE),
        totalInodes: stats.files + stats.directories,
        freeInodes: 0,
      };
      const activeFormat = format ?? (terse ? STATFS_TERSE_FORMAT : null);
      for (const f of files) {
        const displayPath = f.startsWith('/') ? f : resolvePath(ctx.cwd, f);
        if (activeFormat !== null) {
          const expanded = expandStatFormat(
            activeFormat,
            (directive) => statFsDirective(directive, facts, displayPath),
          );
          if ('error' in expanded) {
            (await ctx.stderr.write(expanded.error + '\n'));
            return 1;
          }
          (await write(expanded.text));
          continue;
        }
        (await ctx.stdout.write(`  File: "${displayPath}"\n`));
        (await ctx.stdout.write(`    ID: 0        Namelen: ${STAT_NAME_MAX}     Type: nimbus-sqlite\n`));
        (await ctx.stdout.write(
          `Block size: ${facts.blockSize}       Fundamental block size: ${facts.blockSize}\n`,
        ));
        (await ctx.stdout.write(
          `Blocks: Total: ${facts.totalBlocks}  Free: ${facts.freeBlocks}  Available: ${facts.freeBlocks}\n`,
        ));
        (await ctx.stdout.write(`Inodes: Total: ${facts.totalInodes}  Free: ${facts.freeInodes}\n`));
      }
      return 0;
    }

    const activeFormat = format ?? (terse ? STAT_TERSE_FORMAT : null);
    // Through the process's view, so mounted paths (/dev) resolve.
    const kvfs = ctx.vfs;
    for (const f of files) {
      let st: CtxStat | null = null;
      let displayPath = f;
      // Try Kernel.VFS first (sees mounts).
      if (kvfs && typeof kvfs.stat === 'function') {
        try {
          st = (await statOrThrow(kvfs, f.startsWith('/') ? f : ctx.cwd + '/' + f));
          displayPath = f.startsWith('/') ? f : `/${ctx.cwd}/${f}`.replace(/^\/+/, '/');
        } catch (_e) { /* fall through to SqliteVFS */ }
      }
      // Fall back to SqliteVFS direct for non-mounted paths.
      if (!st) {
        try {
          const fp = resolvePath(ctx.cwd, f);
          st = (await statOrThrow(vfs, fp));
          displayPath = fp;
        } catch (_e) {
          (await ctx.stderr.write(`stat: cannot statx '${f}': No such file or directory\n`));
          return 1;
        }
      }
      const uid = st.uid ?? ctx.cred.uid;
      const gid = st.gid ?? ctx.cred.gid;
      const labels = {
        user: (await unixUserLabel(vfs, uid)),
        group: (await unixGroupLabel(vfs, gid)),
      };
      const facts: StatFacts = {
        size: st.size,
        type: st.type,
        mode: st.mode,
        uid,
        gid,
        atimeMs: st.atimeMs ?? st.mtimeMs,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
      };
      if (activeFormat !== null) {
        const expanded = expandStatFormat(
          activeFormat,
          (directive) => statDirective(directive, facts, displayPath, labels),
        );
        if ('error' in expanded) {
          (await ctx.stderr.write(expanded.error + '\n'));
          return 1;
        }
        (await write(expanded.text));
        continue;
      }
      (await ctx.stdout.write(`  File: ${displayPath}\n`));
      const kind = isCharacterDevice(st.mode) ? 'character special file' : st.type;
      (await ctx.stdout.write(`  Size: ${st.size}\tType: ${kind}\n`));
      (await ctx.stdout.write(`Access: (0${st.mode.toString(8)})  Uid: (${uid}/${labels.user})   Gid: (${gid}/${labels.group})\n`));
      (await ctx.stdout.write(`Modify: ${new Date(st.mtimeMs).toISOString()}\n`));
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
  return async (ctx) => {
    const { flags, positional, unknown } = parseArgs(ctx.args, BASE64_SPEC);
    if (unknown.length > 0) {
      (await ctx.stderr.write(`base64: invalid option -- '${unknown[0].replace(/^-+/, '')}'\n`));
      return 1;
    }
    const wrapText = typeof flags.wrap === 'string' && flags.wrap !== '' ? flags.wrap : '76';
    const wrap = Number.parseInt(wrapText, 10);
    if (Number.isNaN(wrap) || wrap < 0) {
      (await ctx.stderr.write(`base64: invalid wrap size: '${wrapText}'\n`));
      return 1;
    }

    const file = positional[0];
    let bytes: Uint8Array;
    if (file !== undefined && file !== '-') {
      try { bytes = (await vfs.readFile(resolvePath(ctx.cwd, file))); }
      catch (error) { (await ctx.stderr.write(`base64: ${file}: ${strerror(error)}\n`)); return 1; }
    } else {
      bytes = enc.encode((await stdinText(ctx)) ?? '');
    }

    if (flags.decode) {
      const source = dec.decode(bytes).replace(/\s+/g, '');
      let decoded: Uint8Array;
      try {
        const binary = atob(source);
        decoded = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      } catch { (await ctx.stderr.write('base64: invalid input\n')); return 1; }
      if (ctx.stdout.writeBytes) (await ctx.stdout.writeBytes(decoded));
      else (await ctx.stdout.write(dec.decode(decoded)));
      return 0;
    }

    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    if (encoded === '') return 0;
    const lines = wrap > 0
      ? (encoded.match(new RegExp(`.{1,${wrap}}`, 'g')) ?? [encoded])
      : [encoded];
    (await ctx.stdout.write(lines.join('\n') + '\n'));
    return 0;
  };
}

function mkId(sqliteVfs: SqliteVFS): CmdFn {
  return async (ctx) => {
    const vfs = ctx.vfs;
    const user = (await findUnixUserName(vfs, ctx.cred.uid)) ?? String(ctx.cred.uid);
    const group = (await findUnixGroupName(vfs, ctx.cred.gid)) ?? String(ctx.cred.gid);
    const groupIds = [...new Set([ctx.cred.gid, ...ctx.cred.groups])];
    const groups = (await Promise.all(groupIds
      .map(async (gid) => `${gid}(${(await findUnixGroupName(vfs, gid)) ?? gid})`)))
      .join(',');
    (await ctx.stdout.write(`uid=${ctx.cred.uid}(${user}) gid=${ctx.cred.gid}(${group}) groups=${groups}\n`));
    return 0;
  };
}

function mkTest(sqliteVfs: SqliteVFS): CmdFn {
  return async (ctx) => {
    const args = ctx.args.filter((arg) => arg !== ']');
    if (args.length === 0) return 1;
    const vfs = ctx.vfs;
    const path = resolvePath(ctx.cwd, args[1] ?? '');
    try {
      if (args[0] === '-r') (await vfs.access(path, 0o4));
      else if (args[0] === '-w') (await vfs.access(path, 0o2));
      else if (args[0] === '-x') (await vfs.access(path, 0o1));
      else if (args[0] === '-f') return (await statOrThrow(vfs, path)).type === 'file' ? 0 : 1;
      else if (args[0] === '-d') return (await statOrThrow(vfs, path)).type === 'directory' ? 0 : 1;
      else if (args[0] === '-e') (await statOrThrow(vfs, path));
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

/**
 * realpath, as GNU coreutils 9.7: -e (every component must exist), -m (none
 * need), and by default all but the last; -P (default) resolves links as it
 * meets them, -L resolves `..` before links, -s prints without resolving
 * links; -q, -z, --relative-to and --relative-base.
 */
function mkRealpath(_vfs: UnixVfs): CmdFn {
  const USAGE = "Try 'realpath --help' for more information.\n";
  const LONG: Record<string, string> = {
    'canonicalize-existing': 'e', 'canonicalize-missing': 'm', logical: 'L', physical: 'P',
    quiet: 'q', strip: 's', 'no-symlinks': 's', zero: 'z',
  };
  return async (ctx) => {
    let mode: 'e' | 'E' | 'm' = 'E';
    let logical = false;
    let noSymlinks = false;
    let quiet = false;
    let zero = false;
    let relativeTo: string | null = null;
    let relativeBase: string | null = null;
    const operands: string[] = [];
    const refuse = async (message: string): Promise<number> => {
      (await ctx.stderr.write(`realpath: ${message}\n${USAGE}`));
      return 1;
    };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--') { operands.push(...args.slice(i + 1)); break; }
      if (arg.startsWith('--')) {
        const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
        if (name === 'relative-to' || name === 'relative-base') {
          const value = inline ?? args[++i];
          if (value === undefined) return refuse(`option '--${name}' requires an argument`);
          if (name === 'relative-to') relativeTo = value; else relativeBase = value;
          continue;
        }
        const flag = LONG[name];
        if (flag === undefined || inline !== undefined) return refuse(`unrecognized option '${arg}'`);
        applyFlag(flag);
        continue;
      }
      if (arg.length > 1 && arg.startsWith('-')) {
        for (const ch of arg.slice(1)) {
          if (!'emLPqsz'.includes(ch)) return refuse(`invalid option -- '${ch}'`);
          applyFlag(ch);
        }
        continue;
      }
      operands.push(arg);
    }
    function applyFlag(flag: string): void {
      if (flag === 'e' || flag === 'm') mode = flag;
      else if (flag === 'L') logical = true;
      else if (flag === 'P') logical = false;
      else if (flag === 'q') quiet = true;
      else if (flag === 's') noSymlinks = true;
      else if (flag === 'z') zero = true;
    }
    if (operands.length === 0) return refuse('missing operand');

    const canonical = (arg: string): Promise<string> =>
      canonicalizePath(ctx.vfs, arg.startsWith('/') ? arg : `/${resolvePath(ctx.cwd, '.')}/${arg}`, {
        mode, logical, noSymlinks,
      });
    let exit = 0;
    const fail = async (arg: string, error: unknown): Promise<void> => {
      exit = 1;
      if (quiet) return;
      const code = isVfsError(error) ? error.code : undefined;
      (await ctx.stderr.write(`realpath: ${arg}: ${code ? VFS_STRERROR[code] : errorText(error)}\n`));
    };
    let to: string | null = null;
    let base: string | null = null;
    try {
      if (relativeTo !== null) to = await canonical(relativeTo);
      if (relativeBase !== null) base = await canonical(relativeBase);
    } catch (error) {
      await fail(relativeTo !== null && to === null ? relativeTo : relativeBase ?? '', error);
      return 1;
    }
    if (base !== null && to === null) to = base;
    // --relative-base: relative only when both the path and the target directory are under it.
    if (base !== null && to !== null && !isUnder(to, base)) { to = null; base = null; }
    for (const arg of operands) {
      let resolved: string;
      try {
        resolved = await canonical(arg);
      } catch (error) {
        await fail(arg, error);
        continue;
      }
      const shown = to !== null && (base === null || isUnder(resolved, base)) ? relativePath(resolved, to) : resolved;
      (await ctx.stdout.write(shown + (zero ? '\0' : '\n')));
    }
    return exit;
  };
}

function isUnder(path: string, dir: string): boolean {
  return dir === '/' || path === dir || path.startsWith(`${dir}/`);
}

/** `path` relative to the directory `from`, both canonical and absolute. */
function relativePath(path: string, from: string): string {
  const a = path.split('/').filter(Boolean);
  const b = from.split('/').filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const parts = [...b.slice(common).map(() => '..'), ...a.slice(common)];
  return parts.length === 0 ? '.' : parts.join('/');
}

/**
 * GNU's canonicalize_filename_mode over a process's view: components are
 * resolved as they are met (links followed, 40 hops), `..` physically unless
 * `logical`; `mode` e: every component must exist, E: all but the last, m:
 * none. A trailing slash asks for a directory.
 */
async function canonicalizePath(
  vfs: ProcessView,
  absolute: string,
  options: { mode: 'e' | 'E' | 'm'; logical: boolean; noSymlinks: boolean },
): Promise<string> {
  const trailingSlash = absolute.length > 1 && absolute.endsWith('/');
  let pending = absolute.split('/').filter(Boolean);
  if (options.logical || options.noSymlinks) {
    const lexical: string[] = [];
    for (const part of pending) {
      if (part === '.') continue;
      if (part === '..') lexical.pop(); else lexical.push(part);
    }
    pending = lexical;
  }
  const resolved: string[] = [];
  let hops = 0;
  let missing = false;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === '.') continue;
    if (part === '..') { resolved.pop(); continue; }
    const candidate = `/${[...resolved, part].join('/')}`;
    const last = pending.length === 0;
    if (missing) { resolved.push(part); continue; }
    const statOf = async (follow: boolean) => {
      try {
        return await vfs.stat(candidate, { follow });
      } catch (error) {
        if (!isVfsError(error, 'ENOTDIR')) throw error;
        return null;
      }
    };
    // -s keeps a link's name, but whether it is a directory is its target's.
    let stat = await statOf(options.noSymlinks);
    if (stat?.type === 'symlink' && !options.noSymlinks) {
      if (++hops > 40) {
        // Under -m a component that loops counts as missing (GNU).
        if (options.mode !== 'm') throw syscallError('ELOOP', 'realpath', candidate);
        missing = true;
        resolved.push(part);
        continue;
      }
      // Where the link leads in this namespace (a mount may read it from its own root).
      const target = await vfs.linkLeadsTo(candidate, await vfs.readlink(candidate));
      if (target !== null) {
        if (target.startsWith('/')) resolved.length = 0;
        pending = [...target.split('/').filter(Boolean), ...pending];
        continue;
      }
      // One whose target the namespace has no name for (a mount nested in
      // its backend covers it) is named by itself, and is what it leads to.
      stat = await statOf(true);
    }
    if (stat === null) {
      if (options.mode === 'e' || (options.mode === 'E' && !last)) throw syscallError('ENOENT', 'realpath', candidate);
      missing = true;
      resolved.push(part);
      continue;
    }
    if (stat.type !== 'directory' && !last && options.mode !== 'm') throw syscallError('ENOTDIR', 'realpath', candidate);
    resolved.push(part);
  }
  const out = `/${resolved.join('/')}`;
  if (trailingSlash && options.mode !== 'm') {
    const stat = await vfs.stat(out);
    if (stat !== null && stat.type !== 'directory') throw syscallError('ENOTDIR', 'realpath', out);
  }
  return out;
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
  return async (ctx) => {
    if (ctx.args.length === 0) return 0;
    const vals = ctx.args.slice(1);
    // Process backslash escapes in the format string first. A `\c` in it,
    // or in a %b argument, ends the output there.
    const { text: fmt, stopped: formatStops } = expandBackslashEscapes(ctx.args[0], 'printf');
    let stopped = false;

    let out = '';
    let argIdx = 0;

    function applyFormat(): boolean {
      // Run the format string once; return true if it consumed any args.
      let i = 0;
      const startArg = argIdx;
      while (i < fmt.length && !stopped) {
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
        if (conv === 'b') {
          // %b: the argument's escapes expanded, then laid out as %s would be.
          const expanded = expandBackslashEscapes(arg ?? '', 'printf-b');
          out += formatOneArg(`${spec}s`, expanded.text);
          stopped = expanded.stopped;
        } else {
          out += formatOneArg(spec + conv, arg);
        }
      }
      return argIdx > startArg;
    }

    // bash printf: re-run the format until args are exhausted; if
    // format consumes zero args (no %X specifiers), run it once.
    if (vals.length === 0 || formatStops) {
      applyFormat();
    } else {
      while (argIdx < vals.length && !stopped) {
        if (!applyFormat()) break;
      }
    }
    (await ctx.stdout.write(out));
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
    case 'c': {
      if (typeof arg === 'number') body = String.fromCharCode(arg);
      else body = String(arg ?? '').charAt(0);
      break;
    }
    case 'q':
      // coreutils printf %q: the argument as quotearg's shell-escape style writes it.
      body = shellEscape(String(arg ?? ''));
      break;
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
/**
 * readlink, as GNU coreutils 9.7: a link's text, or under -f (all but the
 * last component must exist), -e (every one) or -m (none need) the name
 * canonicalized by canonicalizePath, as realpath's. Quiet unless -v: a name
 * it cannot answer for exits 1 and says nothing. -n drops the newline after
 * a lone name; -z ends each with NUL.
 */
function mkReadlink(vfs: UnixVfs): CmdFn {
  const USAGE = "Try 'readlink --help' for more information.\n";
  const LONG: Record<string, string> = {
    canonicalize: 'f', 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', 'no-newline': 'n',
    quiet: 'q', silent: 's', verbose: 'v', zero: 'z',
  };
  return async (ctx) => {
    let mode: 'e' | 'E' | 'm' | null = null;
    let noNewline = false;
    let verbose = false;
    let zero = false;
    const targets: string[] = [];
    const refuse = async (message: string): Promise<number> => {
      (await ctx.stderr.write(`readlink: ${message}\n${USAGE}`));
      return 1;
    };
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i]!;
      if (arg === '--') { targets.push(...ctx.args.slice(i + 1)); break; }
      const flags = arg.startsWith('--') ? LONG[arg.slice(2)] : arg.length > 1 && arg.startsWith('-') ? arg.slice(1) : null;
      if (flags === null) { targets.push(arg); continue; }
      if (flags === undefined) return refuse(`unrecognized option '${arg}'`);
      for (const flag of flags) {
        if (flag === 'f') mode = 'E';
        else if (flag === 'e' || flag === 'm') mode = flag;
        else if (flag === 'n') noNewline = true;
        else if (flag === 'q' || flag === 's') verbose = false;
        else if (flag === 'v') verbose = true;
        else if (flag === 'z') zero = true;
        else return refuse(`invalid option -- '${flag}'`);
      }
    }
    if (targets.length === 0) return refuse('missing operand');
    const end = zero ? '\0' : noNewline && targets.length === 1 ? '' : '\n';
    let exit = 0;
    for (const t of targets) {
      const fp = resolvePath(ctx.cwd, t);
      try {
        const answer = mode === null
          ? await readSymlinkTarget(vfs, fp)
          // The name as given, so a trailing slash still asks for a directory.
          : await canonicalizePath(ctx.vfs, t.startsWith('/') ? t : `${resolvePath(ctx.cwd, '.')}/${t}`, { mode, logical: false, noSymlinks: false });
        if (answer !== null) { (await ctx.stdout.write(answer + end)); continue; }
        // Not a link: EINVAL, as readlink(2) says, once the name is known to exist.
        await statOrThrow(vfs, fp);
        if (verbose) (await ctx.stderr.write(`readlink: ${t}: Invalid argument\n`));
      } catch (error) {
        if (!isVfsError(error)) throw error;
        if (verbose) (await ctx.stderr.write(`readlink: ${t}: ${VFS_STRERROR[error.code]}\n`));
      }
      exit = 1;
    }
    return exit;
  };
}

function mkFile(vfs: UnixVfs): CmdFn {
  return async (ctx) => {
    for (const f of ctx.args.filter(a => !a.startsWith('-'))) {
      const fp = resolvePath(ctx.cwd, f);
      try {
        if ((await vfs.isDirectory(fp))) { (await ctx.stdout.write(`${f}: directory\n`)); continue; }
        if ((await statOrThrow(vfs, fp)).size === 0) { (await ctx.stdout.write(`${f}: empty\n`)); continue; }
        // BUG-SWEEP-3 (2026-05-11): scan raw bytes for NUL or non-text
        // bytes BEFORE attempting a UTF-8 decode. Pre-fix every binary
        // file was reported as "UTF-8 text" because readFileString
        // silently U+FFFD-substituted invalid sequences.
        const bytes = (await vfs.readFile(fp));
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
            (await ctx.stdout.write(`${f}: ELF executable\n`));
          } else if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
            (await ctx.stdout.write(`${f}: WebAssembly (wasm) binary module\n`));
          } else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
            (await ctx.stdout.write(`${f}: PNG image data\n`));
          } else if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            (await ctx.stdout.write(`${f}: gzip compressed data\n`));
          } else if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)) {
            (await ctx.stdout.write(`${f}: Zip archive data\n`));
          } else {
            (await ctx.stdout.write(`${f}: data\n`));
          }
          continue;
        }
        const content = new TextDecoder('utf-8').decode(bytes);
        if (content.startsWith('<!DOCTYPE') || content.startsWith('<html')) (await ctx.stdout.write(`${f}: HTML document\n`));
        else if (content.startsWith('{') || content.startsWith('[')) (await ctx.stdout.write(`${f}: JSON data\n`));
        else if (content.startsWith('#!')) (await ctx.stdout.write(`${f}: script, ${content.split('\n')[0]}\n`));
        else if (f.endsWith('.ts') || f.endsWith('.tsx')) (await ctx.stdout.write(`${f}: TypeScript source\n`));
        else if (f.endsWith('.js') || f.endsWith('.mjs')) (await ctx.stdout.write(`${f}: JavaScript source\n`));
        else if (f.endsWith('.css')) (await ctx.stdout.write(`${f}: CSS stylesheet\n`));
        else (await ctx.stdout.write(`${f}: ASCII text\n`));
      } catch { (await ctx.stderr.write(`file: ${f}: No such file\n`)); return 1; }
    }
    return 0;
  };
}

// ── Hex dumps: od, hexdump, xxd ─────────────────────────────────────────

/**
 * Dump-tool byte counts, as GNU od reads -j/-N: base 0 (`0x` hex, leading-zero
 * octal) and od's suffixes. hexdump and xxd read theirs the same way. Null
 * means the value is not a count these tools accept, or past what is exact.
 */
function parseDumpCount(value: string): number | null {
  const count = parseSuffixedCount(value, 'bEGKkMmPQRTYZ0', 0);
  return count !== null && Number.isSafeInteger(count) ? count : null;
}

/** Little-endian word; a short final chunk reads its missing bytes as zero. */
function leWord(chunk: Uint8Array): number {
  return (chunk[0] ?? 0) | ((chunk[1] ?? 0) << 8);
}

/**
 * Shared row suppression: a formatted row equal to the one before it prints
 * as `*`, and runs of repeats collapse into that single marker. GNU od and
 * util-linux hexdump suppress the address together with the row, so callers
 * classify the body alone and print the marker bare.
 */
class RowDedup {
  private previous: string | null = null;
  private starred = false;

  classify(row: string, verbose: boolean): 'print' | 'star' | 'skip' {
    if (verbose || row !== this.previous) {
      this.previous = row;
      this.starred = false;
      return 'print';
    }
    if (this.starred) return 'skip';
    this.starred = true;
    return 'star';
  }
}

// ── od ──────────────────────────────────────────────────────────────────
// GNU od (coreutils 9.7), byte for byte: od.c's field widths, its padding of
// every type to one block width, raw-block duplicate suppression, a short
// final word read with zero fill, and floats in their shortest round-trip
// form (ftoastr). Traditional `od file +offset` operands are not taken.

type OdRadix = 'o' | 'd' | 'x' | 'n';

/** Row addresses: 7 octal or decimal digits, 6 hex digits, growing as needed. */
function odAddress(radix: OdRadix, offset: number): string {
  if (radix === 'n') return '';
  if (radix === 'o') return offset.toString(8).padStart(7, '0');
  if (radix === 'd') return String(offset).padStart(7, '0');
  return offset.toString(16).padStart(6, '0');
}

/** `-tc` escapes; other bytes outside printable ASCII print as three octal digits. */
const OD_CHAR_ESCAPES: Readonly<Record<number, string>> = {
  0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r',
};

/** `-ta` names: the byte's low seven bits. */
const OD_NAMED = [
  'nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si',
  'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp',
];

const odPrintable = (byte: number): boolean => byte >= 0x20 && byte < 0x7f;

interface OdSpec {
  size: number;
  width: number;
  trailer: boolean;
  render: (view: DataView, at: number, little: boolean) => string;
}

/** Field widths (od.c): the widest value of the type, sign included. */
const OD_INT_WIDTHS: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  d: { 1: 4, 2: 6, 4: 11, 8: 20 },
  u: { 1: 3, 2: 5, 4: 10, 8: 20 },
  o: { 1: 3, 2: 6, 4: 11, 8: 22 },
  x: { 1: 2, 2: 4, 4: 8, 8: 16 },
};
const OD_INT_NAMED_SIZES: Readonly<Record<string, number>> = { C: 1, S: 2, I: 4, L: 8 };
const OD_FLOAT_NAMED_SIZES: Readonly<Record<string, string>> = { F: '4', D: '8', H: 'H', B: 'B' };

function odInteger(letter: string, size: number): OdSpec {
  const width = OD_INT_WIDTHS[letter][size];
  const read = (view: DataView, at: number, little: boolean): bigint => {
    if (size === 1) return letter === 'd' ? BigInt(view.getInt8(at)) : BigInt(view.getUint8(at));
    if (size === 2) return BigInt(letter === 'd' ? view.getInt16(at, little) : view.getUint16(at, little));
    if (size === 4) return BigInt(letter === 'd' ? view.getInt32(at, little) : view.getUint32(at, little));
    return letter === 'd' ? view.getBigInt64(at, little) : view.getBigUint64(at, little);
  };
  return {
    size, width, trailer: false,
    render: (view, at, little) => {
      const value = read(view, at, little);
      if (letter === 'o') return value.toString(8).padStart(width, '0');
      if (letter === 'x') return value.toString(16).padStart(width, '0');
      return value.toString();
    },
  };
}

/** A half (IEEE binary16) as the float it widens to. */
function odHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * C's `%.*g` of `value` at `precision` significant digits: fixed notation
 * when the exponent is at least -4 and below the precision, else scientific
 * with at least two exponent digits; trailing zeros dropped.
 */
function odFormatG(value: number, precision: number): string {
  const [mantissa, exponentText] = value.toExponential(precision - 1).split('e');
  const exponent = Number(exponentText);
  const trim = (text: string) => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);
  if (exponent >= -4 && exponent < precision) return trim(value.toFixed(Math.max(0, precision - 1 - exponent)));
  const digits = String(Math.abs(exponent)).padStart(2, '0');
  return `${trim(mantissa)}e${exponent < 0 ? '-' : '+'}${digits}`;
}

/**
 * ftoastr: the fewest significant digits (from the type's DIG, or 1 below its
 * smallest normal) whose `%g` reads back as the same value.
 */
function odFloat(value: number, negative: boolean, single: boolean): string {
  if (Number.isNaN(value)) return negative ? '-nan' : 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  if (value === 0) return negative ? '-0' : '0';
  const smallest = single ? 1.1754943508222875e-38 : 2.2250738585072014e-308;
  const same = single ? (text: string) => Math.fround(Number(text)) === value : (text: string) => Number(text) === value;
  for (let precision = Math.abs(value) < smallest ? 1 : single ? 6 : 15; ; precision++) {
    const text = odFormatG(value, precision);
    if (same(text) || precision >= (single ? 9 : 17)) return text;
  }
}

function odFloatSpec(kind: string): OdSpec | null {
  if (kind === '4') {
    return { size: 4, width: 15, trailer: false, render: (view, at, little) => {
      const bits = view.getUint32(at, little);
      return odFloat(view.getFloat32(at, little), (bits >>> 31) === 1, true);
    } };
  }
  if (kind === '8') {
    return { size: 8, width: 24, trailer: false, render: (view, at, little) => {
      const high = view.getUint8(at + (little ? 7 : 0));
      return odFloat(view.getFloat64(at, little), (high & 0x80) !== 0, false);
    } };
  }
  if (kind === 'H' || kind === 'B') {
    return { size: 2, width: 15, trailer: false, render: (view, at, little) => {
      const bits = view.getUint16(at, little);
      const value = kind === 'H' ? odHalf(bits) : new Float32Array(new Uint32Array([bits << 16]).buffer)[0];
      return odFloat(value, (bits & 0x8000) !== 0, true);
    } };
  }
  return null;
}

const OD_CHAR_SPEC: OdSpec = {
  size: 1, width: 3, trailer: false,
  render: (view, at) => {
    const byte = view.getUint8(at);
    return OD_CHAR_ESCAPES[byte] ?? (odPrintable(byte) ? String.fromCharCode(byte) : byte.toString(8).padStart(3, '0'));
  },
};
const OD_NAMED_SPEC: OdSpec = {
  size: 1, width: 3, trailer: false,
  render: (view, at) => {
    const byte = view.getUint8(at) & 0x7f;
    return byte === 0x7f ? 'del' : OD_NAMED[byte] ?? String.fromCharCode(byte);
  },
};

/** A `-t` string: letters, each with an optional size and an optional `z`. */
function parseOdTypes(text: string): OdSpec[] | string {
  const specs: OdSpec[] = [];
  const invalid = (why: string) => `od: invalid type string \u2018${text}\u2019;\n${why}`;
  for (let i = 0; i < text.length;) {
    const letter = text[i++];
    let spec: OdSpec | null;
    if (letter === 'a' || letter === 'c') {
      spec = letter === 'a' ? OD_NAMED_SPEC : OD_CHAR_SPEC;
    } else if (letter === 'd' || letter === 'o' || letter === 'u' || letter === 'x') {
      let size = 4;
      const named = OD_INT_NAMED_SIZES[text[i]];
      if (named !== undefined) { size = named; i++; } else {
        const digits = /^\d+/.exec(text.slice(i))?.[0];
        if (digits !== undefined) {
          i += digits.length;
          size = Number(digits);
          if (!(size in OD_INT_WIDTHS[letter])) return invalid(`this system doesn't provide a ${size}-byte integral type`);
        }
      }
      spec = odInteger(letter, size);
    } else if (letter === 'f') {
      let kind = '8';
      const named = OD_FLOAT_NAMED_SIZES[text[i]];
      if (named !== undefined) { kind = named; i++; } else if (text[i] === 'L') {
        return invalid("this system doesn't provide a long double type od can print");
      } else {
        const digits = /^\d+/.exec(text.slice(i))?.[0];
        if (digits !== undefined) {
          i += digits.length;
          kind = digits === '2' ? 'H' : digits;
          if (kind !== 'H' && kind !== '4' && kind !== '8') return invalid(`this system doesn't provide a ${digits}-byte floating point type`);
        }
      }
      spec = odFloatSpec(kind);
    } else {
      return `od: invalid character '${letter}' in type string \u2018${text}\u2019`;
    }
    if (spec === null) return `od: invalid type string \u2018${text}\u2019`;
    if (text[i] === 'z') { spec = { ...spec, trailer: true }; i++; }
    specs.push(spec);
  }
  return specs;
}

/** GNU's traditional one-letter types. */
const OD_SHORTHAND: Readonly<Record<string, string>> = {
  a: 'a', b: 'o1', c: 'c', d: 'u2', f: 'fF', i: 'dI', l: 'dL', o: 'o2', s: 'd2', x: 'x2',
  B: 'o2', D: 'u4', e: 'fD', F: 'fD', h: 'x2', H: 'x4', I: 'dL', L: 'dL', O: 'o4', X: 'x4',
};

type OdArgs =
  | { error: string }
  | {
    radix: OdRadix; specs: OdSpec[]; skip: number; limit: number | undefined; verbose: boolean;
    width: number | undefined; strings: number | undefined; little: boolean; files: string[];
  };

/** GNU od's options: short (grouped, values attached or separate) and long. */
function parseOdArgs(args: string[]): OdArgs {
  let radix: OdRadix = 'o';
  const specs: OdSpec[] = [];
  let skip = 0;
  let limit: number | undefined;
  let verbose = false;
  let width: number | undefined;
  let strings: number | undefined;
  let little = true;
  const files: string[] = [];
  const count = (flag: string, value: string): number | string => {
    const parsed = parseDumpCount(value);
    return parsed === null || parsed < 0 ? `od: invalid ${flag} argument '${value}'` : parsed;
  };
  const apply = (option: string, value: string | undefined): string | undefined => {
    switch (option) {
      case 'A': case 'address-radix':
        // GNU reads the first character only (`-Aod` is octal).
        if (value === undefined || value === '' || !'odxn'.includes(value[0])) {
          return `od: invalid output address radix '${value?.[0] ?? ''}'; it must be one character from [doxn]`;
        }
        radix = value[0] as OdRadix;
        return undefined;
      case 'j': case 'skip-bytes': case 'N': case 'read-bytes': case 'S': case 'strings': case 'w': case 'width': {
        const flag = option.length === 1 ? `-${option}` : `--${option}`;
        if (value === undefined) {
          if (option === 'S' || option === 'strings') { strings = 3; return undefined; }
          if (option === 'w' || option === 'width') { width = 32; return undefined; }
        }
        const parsed = count(flag, value ?? '');
        if (typeof parsed === 'string') return parsed;
        if (option === 'j' || option === 'skip-bytes') skip = parsed;
        else if (option === 'N' || option === 'read-bytes') limit = parsed;
        else if (option === 'S' || option === 'strings') strings = parsed;
        else width = parsed;
        return undefined;
      }
      case 't': case 'format': {
        const parsed = parseOdTypes(value ?? '');
        if (typeof parsed === 'string') return parsed;
        specs.push(...parsed);
        return undefined;
      }
      case 'endian':
        if (value !== 'big' && value !== 'little') return `od: invalid argument '${value}' for '--endian'`;
        little = value === 'little';
        return undefined;
      case 'v': case 'output-duplicates':
        verbose = true;
        return undefined;
      default:
        return `od: unrecognized option '${option}'`;
    }
  };
  const takesValue = new Set(['A', 'j', 'N', 't']);
  const optionalValue = new Set(['S', 'w']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let value = eq === -1 ? undefined : arg.slice(eq + 1);
      const required = ['address-radix', 'skip-bytes', 'read-bytes', 'format', 'endian'].includes(name);
      if (required && value === undefined) value = args[++i];
      if (required && value === undefined) return { error: `od: option '--${name}' requires an argument` };
      const error = apply(name, value);
      if (error !== undefined) return { error };
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (takesValue.has(flag) || optionalValue.has(flag)) {
        let value: string | undefined = arg.slice(j + 1);
        // -w's value is optional and only ever attached; -S's is required.
        if (value === '') value = flag === 'w' ? undefined : args[++i];
        if (value === undefined && flag !== 'w') return { error: `od: option requires an argument -- '${flag}'` };
        const error = apply(flag, value);
        if (error !== undefined) return { error };
        break;
      }
      if (flag === 'v') { verbose = true; continue; }
      const shorthand = OD_SHORTHAND[flag];
      if (shorthand === undefined) return { error: `od: invalid option -- '${flag}'` };
      const error = apply('t', shorthand);
      if (error !== undefined) return { error };
    }
  }
  if (specs.length === 0) specs.push(...(parseOdTypes('o2') as OdSpec[]));
  return { radix, specs, skip, limit, verbose, width, strings, little, files };
}

const odGcd = (a: number, b: number): number => (b === 0 ? a : odGcd(b, a % b));

function mkOd(): CmdFn {
  return async (ctx) => {
    const parsed = parseOdArgs(ctx.args);
    if ('error' in parsed) {
      (await ctx.stderr.write(`${parsed.error}\n`));
      return 1;
    }
    const { radix, specs, little } = parsed;
    const src = new DumpByteSource(ctx, 'od', parsed.files, parsed.limit === undefined ? undefined : parsed.skip + parsed.limit);
    for (let skipped = 0; skipped < parsed.skip;) {
      const chunk = await src.take(Math.min(65536, parsed.skip - skipped));
      if (chunk === null || chunk.length === 0) {
        if (!src.failedAll) (await ctx.stderr.write('od: cannot skip past end of combined input\n'));
        return 1;
      }
      skipped += chunk.length;
    }
    const base = parsed.skip;

    if (parsed.strings !== undefined) {
      // Runs of at least N printable bytes that end in a NUL; the run's
      // offset, then the run. A run cut off by the end of input is dropped.
      const min = Math.max(1, parsed.strings);
      let run: number[] = [];
      let start = base;
      let offset = base;
      for (;;) {
        const chunk = await src.take(65536);
        if (chunk === null || chunk.length === 0) break;
        for (const byte of chunk) {
          if (byte === 0 && run.length >= min) {
            const address = odAddress(radix, start);
            (await ctx.stdout.write(`${address === '' ? '' : `${address} `}${String.fromCharCode(...run)}\n`));
          }
          if (odPrintable(byte)) {
            if (run.length === 0) start = offset;
            run.push(byte);
          } else {
            run = [];
          }
          offset++;
        }
      }
      return src.failed ? 1 : 0;
    }

    const lcm = specs.reduce((acc, spec) => (acc * spec.size) / odGcd(acc, spec.size), 1);
    let block = lcm < 16 ? lcm * Math.floor(16 / lcm) : lcm;
    if (parsed.width !== undefined) {
      if (parsed.width !== 0 && parsed.width % lcm === 0) block = parsed.width;
      else {
        (await ctx.stderr.write(`od: warning: invalid width ${parsed.width}; using ${lcm} instead\n`));
        block = lcm;
      }
    }
    // Every type's line is padded to the widest one's, spread across its fields.
    const lineWidth = Math.max(...specs.map((spec) => (spec.width + 1) * (block / spec.size)));
    const pads = specs.map((spec) => lineWidth - (spec.width + 1) * (block / spec.size));
    const indent = radix === 'n' ? '' : ' '.repeat(odAddress(radix, 0).length);

    const buffer = new Uint8Array(block + 8);
    const view = new DataView(buffer.buffer);
    let previous: Uint8Array | null = null;
    let starred = false;
    let offset = base;
    for (;;) {
      const row = await src.take(block);
      if (row === null || row.length === 0) break;
      const full = row.length === block;
      if (!parsed.verbose && full && previous !== null && previous.every((byte, i) => byte === row[i])) {
        if (!starred) (await ctx.stdout.write('*\n'));
        starred = true;
        offset += row.length;
        continue;
      }
      starred = false;
      previous = full ? row.slice() : null;
      buffer.fill(0);
      buffer.set(row);
      const lines: string[] = [];
      specs.forEach((spec, index) => {
        const fields = block / spec.size;
        const blank = Math.floor((block - row.length) / spec.size);
        const pad = pads[index];
        let line = index === 0 ? odAddress(radix, offset) : indent;
        let padLeft = pad;
        for (let i = fields; i > blank; i--) {
          const nextPad = Math.floor((pad * (i - 1)) / fields);
          const item = spec.render(view, (fields - i) * spec.size, little);
          line += ' ' + item.padStart(padLeft - nextPad + spec.width);
          padLeft = nextPad;
        }
        if (spec.trailer) {
          line += ' '.repeat(blank * (spec.width + 1) + Math.floor((pad * blank) / fields));
          line += `  >${Array.from(row, (byte) => (odPrintable(byte) ? String.fromCharCode(byte) : '.')).join('')}<`;
        }
        lines.push(line);
      });
      (await ctx.stdout.write(lines.join('\n') + '\n'));
      offset += row.length;
    }
    if (src.failedAll) return 1;
    if (radix !== 'n') (await ctx.stdout.write(`${odAddress(radix, offset)}\n`));
    return src.failed ? 1 : 0;
  };
}

/**
 * Sequential bytes for a dump tool: each operand in order, stdin once,
 * bounded range reads for files and bounded pulls for pipes. Only one
 * window of bytes is held at a time, so unbounded tools stream forever
 * instead of growing silently, and limits stop collection early.
 */
class DumpByteSource {
  private operands: (string | undefined)[];
  private operandIndex = 0;
  private remaining: number;
  private currentPath = '';
  private cursor = 0;
  private haveOpen = false;
  private stdinMode = false;
  private stdinUsed = false;
  private probedFirst = false;
  // Drained-string stdin is encoded once; pulls slice the encoded bytes so
  // multibyte input never advances past bytes it did not return.
  private stdinBytes: Uint8Array | null = null;
  private stdinCursor = 0;
  private stdinOverflow: Uint8Array[] = [];
  failures = 0;
  opened = 0;
  total = 0;

  constructor(
    private ctx: Ctx,
    private label: string,
    files: string[],
    limit: number | undefined,
  ) {
    this.operands = files.length > 0 ? files : [undefined];
    this.remaining = limit ?? Number.POSITIVE_INFINITY;
  }

  get failed(): boolean {
    return this.failures > 0;
  }

  /** Every named operand failed to open — distinct from successful empty. */
  get failedAll(): boolean {
    return this.operands.length > 0 && this.opened === 0 && this.failures > 0;
  }

  private async openNextOperand(): Promise<boolean> {
    while (this.operandIndex < this.operands.length) {
      const file = this.operands[this.operandIndex++];
      try {
        if (file === undefined || file === '-') {
          if (this.stdinUsed) continue; // second '-' reads stdin already at EOF
          this.stdinMode = true;
          this.opened++; // an empty stdin still counts as successfully opened
          return true;
        }
        // Probe the file now so per-operand errors surface exactly once.
        // Named operands read through ctx.vfs — the mount-aware seam the
        // host handed the command — so /dev and other mounts resolve while
        // an embedder's credentialed view keeps its authorization.
        this.currentPath = resolvePath(this.ctx.cwd, file);
        (await this.ctx.vfs.readRange(this.currentPath, 0, 1));
        this.cursor = 0;
        this.haveOpen = true;
        this.opened++;
        return true;
      } catch (error) {
        (await this.ctx.stderr.write(`${this.label}: ${file}: ${strerror(error)}\n`));
        this.failures++;
      }
    }
    return false;
  }

  private closeCurrent(): void {
    this.haveOpen = false;
    this.stdinMode = false;
    this.currentPath = '';
    this.cursor = 0;
  }

  /** One bounded pull; drained strings are encoded once and sliced by byte. */
  private async stdinPull(max: number): Promise<Uint8Array | null> {
    if (typeof this.ctx.stdin === 'string') {
      if (this.stdinBytes === null) this.stdinBytes = enc.encode(this.ctx.stdin);
      if (this.stdinCursor >= this.stdinBytes.length) return null;
      const end = Math.min(this.stdinCursor + max, this.stdinBytes.length);
      const chunk = this.stdinBytes.subarray(this.stdinCursor, end);
      this.stdinCursor = end;
      return chunk;
    }
    const reader = this.ctx.stdin as {
      read?: () => Promise<string | null>;
      readBytes?: (n: number) => Promise<Uint8Array | null>;
    };
    if (typeof reader?.read !== 'function') return null;
    // read/readAll-only embedders lose nothing: overflow bytes from a bounded
    // pull wait in stdinOverflow until the next one. A live stream hands back
    // its first available chunk — waiting to fill `max` would stall a sparse
    // producer that has written one byte and not the rest.
    let chunk: Uint8Array | null;
    if (this.stdinOverflow.length > 0) {
      chunk = this.stdinOverflow.shift() ?? null;
    } else if (reader.readBytes) {
      chunk = await reader.readBytes(Math.min(65536, max));
    } else {
      const text = await reader.read();
      chunk = text === null ? null : enc.encode(text);
    }
    if (chunk === null || chunk.length === 0) return null;
    if (chunk.length <= max) return chunk;
    this.stdinOverflow.unshift(chunk.subarray(max));
    return chunk.subarray(0, max);
  }

  /**
   * Up to `max` bytes, filling across chunks and operands. A row-oriented
   * caller wants the whole row before it formats anything, exactly as GNU od
   * fills its 16-byte buffer, so this waits for the count it asked for.
   */
  async take(max: number): Promise<Uint8Array | null> {
    return (await this.collect(max, false));
  }

  /**
   * Up to `max` bytes, waiting only for the first ones to arrive. A caller
   * that formats whatever has landed uses this: file operands still answer
   * in bulk, while a live stream is never waited on for bytes a sparse
   * producer has not written yet.
   */
  async takeReady(max: number): Promise<Uint8Array | null> {
    return (await this.collect(max, true));
  }

  private async collect(max: number, ready: boolean): Promise<Uint8Array | null> {
    if (!this.probedFirst) {
      // The first named operand must be attempted even under a zero limit,
      // so `-l0 /missing` reports the open error instead of succeeding.
      this.probedFirst = true;
      if (this.operands.length > 0 && !(await this.openNextOperand())) {
        return null;
      }
    }
    if (max <= 0) return new Uint8Array(0);
    const parts: Uint8Array[] = [];
    let got = 0;
    while (got < max) {
      if (this.remaining <= 0) break;
      if (!this.haveOpen && !this.stdinMode) {
        if (!(await this.openNextOperand())) break;
      }
      const want = Math.min(max - got, this.remaining, 65536);
      let chunk: Uint8Array | null;
      if (this.stdinMode) {
        chunk = await this.stdinPull(want);
        if (chunk === null || chunk.length === 0) {
          this.stdinUsed = true;
          this.closeCurrent();
          continue;
        }
        // A live stream hands back what it has: `takeReady` stops here so a
        // sparse producer keeps rendering, while `take` loops for the rest of
        // the row it was asked for.
        parts.push(chunk);
        got += chunk.length;
        this.total += chunk.length;
        this.remaining -= chunk.length;
        if (ready) break;
        continue;
      }
      // File operands keep filling: range reads are bulk and cost nothing
      // extra, and a block may span consecutive operands.
      chunk = (await this.ctx.vfs.readRange(this.currentPath, this.cursor, want));
      if (chunk.length === 0) {
        this.closeCurrent();
        continue;
      }
      this.cursor += chunk.length;
      const take = chunk.length <= want ? chunk : chunk.subarray(0, want);
      parts.push(take);
      got += take.length;
      this.total += take.length;
      this.remaining -= take.length;
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(got);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

// ── hexdump ─────────────────────────────────────────────────────────────

interface HexdumpDirective {
  kind: 'byte' | 'addr';
  conv?: string;
  radix?: 'd' | 'o' | 'x';
  leftAlign: boolean;
  zeroPad: boolean;
  width: number | undefined;
  precision: number | undefined;
}

/** One quoted piece of an `-e` format: escaped text plus parsed directives. */
interface HexdumpPiece {
  segments: (string | HexdumpDirective)[];
  count: number;
  size: number;
  consumes: boolean;
}

const HEXDUMP_WORD_SIZES: Readonly<Record<string, number>> = { '1': 1, '2': 2, '4': 4, C: 1 };
/** Field widths an empty iteration pads to, mirroring util-linux. */
const HEXDUMP_DIGIT_WIDTHS: Readonly<Record<string, { x: number; o: number; d: number }>> = {
  '1': { x: 2, o: 3, d: 3 },
  '2': { x: 4, o: 6, d: 5 },
  '4': { x: 8, o: 11, d: 10 },
};

/** Shared empty unit: a conversion past end-of-input sees no bytes at all. */
const HEXDUMP_EMPTY_UNIT = new Uint8Array(0);
/** Source bytes fetched per pull while streaming `-e` blocks. */
const HEXDUMP_PULL_BYTES = 4096;
/** Digits an address directive can render: `Number.MAX_SAFE_INTEGER` in octal. */
const HEXDUMP_MAX_ADDRESS_DIGITS = 20;
/**
 * Characters one `-e` block may render. A block is held twice while it is
 * classified — the line and its dedup key — so this ceiling bounds two
 * strings of ~2 MiB UTF-16 each, small beside a Durable Object's memory and
 * far above any format that dumps real data.
 */
const HEXDUMP_MAX_BLOCK_CHARS = 1 << 20;

// util-linux rejects escaped delimiters inside -e units rather than
// decoding them, so `\"` is deliberately absent here.
const HEXDUMP_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n', t: '\t', r: '\r', '\\': '\\', '0': '\0',
};

function parseHexdumpDirectives(fmt: string): { segments: (string | HexdumpDirective)[] } | { error: string } {
  const segments: (string | HexdumpDirective)[] = [];
  let text = '';
  const flush = () => { if (text !== '') { segments.push(text); text = ''; } };
  const bad = (what: string) => ({ error: `hexdump: bad format {${what}}` });

  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '\\') {
      const esc = fmt[++i];
      if (esc === undefined || !(esc in HEXDUMP_ESCAPES)) return bad(`\\${esc ?? ''}`);
      text += HEXDUMP_ESCAPES[esc];
      continue;
    }
    if (ch !== '%') { text += ch; continue; }
    flush();
    const directive: HexdumpDirective = { kind: 'byte', leftAlign: false, zeroPad: false, width: undefined, precision: undefined };
    let j = i + 1;
    while (fmt[j] === '-' || fmt[j] === '0') {
      if (fmt[j] === '-') directive.leftAlign = true; else directive.zeroPad = true;
      j++;
    }
    let digits = '';
    while (fmt[j] >= '0' && fmt[j] <= '9') digits += fmt[j++];
    if (digits !== '') {
      directive.width = Number(digits);
      // A width outside the safe-integer range can never render; reject the
      // format here rather than attempting an unbounded allocation later.
      if (!Number.isSafeInteger(directive.width)) return bad(`%${fmt.slice(i + 1, j + 1)}`);
    }
    if (fmt[j] === '.') {
      let prec = '';
      j++;
      while (fmt[j] >= '0' && fmt[j] <= '9') prec += fmt[j++];
      directive.precision = prec === '' ? 0 : Number(prec);
      if (!Number.isSafeInteger(directive.precision)) return bad(`%${fmt.slice(i + 1, j + 1)}`);
    }
    if (fmt[j] === '_' && fmt[j + 1] === 'a' && 'dxo'.includes(fmt[j + 2])) {
      directive.kind = 'addr';
      directive.radix = fmt[j + 2] as 'd' | 'o' | 'x';
      i = j + 2;
    } else if (j < fmt.length && 'xXduoc'.includes(fmt[j])) {
      directive.conv = fmt[j];
      i = j;
    } else {
      return bad(`%${fmt.slice(i + 1, j + 1)}`);
    }
    segments.push(directive);
  }
  flush();
  return { segments };
}

function parseHexdumpPieces(value: string): { pieces: HexdumpPiece[] } | { error: string } {
  const pieces: HexdumpPiece[] = [];
  let pending: { count: number; size: number } | null = null;
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let digits = '';
      while (i < value.length && value[i] >= '0' && value[i] <= '9') digits += value[i++];
      if (value[i] !== '/') return { error: `hexdump: bad format {${value}}` };
      const sizeChar = value[i + 1] ?? '';
      const size = HEXDUMP_WORD_SIZES[sizeChar];
      if (size === undefined) return { error: `hexdump: bad format {${digits}/${sizeChar}}` };
      const count = Number(digits);
      if (!Number.isSafeInteger(count) || count <= 0) {
        return { error: `hexdump: bad format {${digits}/${sizeChar}}` };
      }
      pending = { count, size };
      i += 2;
      continue;
    }
    if (ch !== '"' && ch !== "'") return { error: `hexdump: bad format {${value.slice(i)}}` };
    // util-linux refuses an escaped quote inside a unit instead of decoding
    // it, and names the whole specification when it does.
    let close = -1;
    for (let k = i + 1; k < value.length; k++) {
      const c = value[k];
      if (c === '\\') {
        if (value[k + 1] === ch) { close = -2; break; }
        k++;
        continue;
      }
      if (c === ch) { close = k; break; }
    }
    if (close < 0) return { error: `hexdump: bad format {${value}}` };
    const parsed = parseHexdumpDirectives(value.slice(i + 1, close));
    if ('error' in parsed) return parsed;
    const conversions = parsed.segments.filter(
      (segment) => typeof segment !== 'string' && segment.kind === 'byte',
    ).length;
    // util-linux refuses a byte count feeding more than one conversion.
    if (conversions > 1) {
      return { error: 'hexdump: byte count with multiple conversion characters' };
    }
    // %c defaults to one byte and only accepts one; other conversions
    // default to four.
    const soleConv = conversions === 1
      ? (parsed.segments.find(
          (segment) => typeof segment !== 'string' && segment.kind === 'byte',
        ) as HexdumpDirective).conv
      : undefined;
    if (soleConv === 'c' && pending !== null && pending.size !== 1) {
      return { error: 'hexdump: bad byte count for conversion character c' };
    }
    pieces.push({
      segments: parsed.segments,
      count: pending?.count ?? 1,
      size: pending?.size ?? (soleConv === 'c' ? 1 : 4),
      consumes: conversions > 0,
    });
    pending = null;
    i = close + 1;
  }
  if (pending !== null) return { error: `hexdump: bad format {${value}}` };
  return { pieces };
}

function hexdumpFormatNumber(directive: HexdumpDirective, digits: string): string {
  // fprintf rules: precision pads the magnitude with zeros, a sign always
  // sits in front of that padding, '-' alignment overrides '0', and an
  // explicit precision disables '0' field padding entirely.
  let sign = '';
  let magnitude = digits;
  if (magnitude.startsWith('-')) {
    sign = '-';
    magnitude = magnitude.slice(1);
  }
  if (directive.precision !== undefined) magnitude = magnitude.padStart(directive.precision, '0');
  const width = directive.width ?? 0;
  const value = sign + magnitude;
  if (directive.leftAlign) return value.padEnd(width);
  if (directive.zeroPad && directive.precision === undefined && width > 0) {
    return sign + magnitude.padStart(width - sign.length, '0');
  }
  return value.padStart(width);
}

/** Field width an iteration reserves, so missing ones pad like util-linux. */
function hexdumpFieldWidth(directive: HexdumpDirective, size: number): number {
  if (directive.kind === 'addr') return directive.width ?? 0;
  if (directive.conv === 'c') return directive.width ?? 1;
  const family = directive.conv === 'x' || directive.conv === 'X'
    ? 'x'
    : directive.conv === 'o' ? 'o' : 'd';
  return directive.width ?? HEXDUMP_DIGIT_WIDTHS[String(size)][family];
}

/**
 * Render one `-e` block straight off the source, one unit at a time. A
 * directive past the end of input renders as field-width spaces rather than
 * dropping its slot, and address directives report the offset of the next
 * byte to display. The dedup key repeats all of it except addresses, so
 * repeat suppression ignores where each block sits.
 *
 * util-linux's nospace rule: a unit repeated more than once drops the single
 * trailing whitespace character of its own format text on its LAST
 * repetition, EOF padding included. Exactly that one character goes, which
 * is why `3/1 "%02x  "` keeps one of its two spaces, `2/1 "%02x\t"` keeps
 * the padding that follows the dropped tab, and a unit repeated once keeps
 * its spacing verbatim.
 *
 * Input arrives unit-sized: nothing collects count*size bytes however large
 * the repetition count is, and parseHexdumpArgs has already refused any
 * format whose block could outgrow {@link HEXDUMP_MAX_BLOCK_CHARS}.
 *
 * Returns the rendered line, its address-free key, and the source bytes the
 * block consumed; null once a block consumes nothing, i.e. true end.
 */
async function hexdumpRenderBlock(
  pieces: HexdumpPiece[],
  pullUnit: (size: number) => Promise<Uint8Array>,
  blockStart: number,
): Promise<{ line: string; key: string; consumed: number } | null> {
  let line = '';
  let key = '';
  let pos = 0;
  let consumed = 0;
  let ended = false;
  for (const piece of pieces) {
    const iterations = piece.consumes ? piece.count : 1;
    const tail = piece.segments[piece.segments.length - 1];
    const dropsTailSpace = iterations > 1
      && typeof tail === 'string'
      && /[ \t\n\r\v\f]$/.test(tail);
    for (let iteration = 0; iteration < iterations; iteration++) {
      const lastIteration = iteration === iterations - 1;
      let unit: Uint8Array = HEXDUMP_EMPTY_UNIT;
      if (piece.consumes && !ended) {
        unit = await pullUnit(piece.size);
        if (unit.length < piece.size) ended = true;
      }
      const missing = piece.consumes && unit.length === 0;
      // Literals always render; only byte conversions pad when input ran
      // out, so a trailing literal still reaches the line on short blocks.
      for (let index = 0; index < piece.segments.length; index++) {
        const segment = piece.segments[index];
        if (typeof segment === 'string') {
          const text = dropsTailSpace && lastIteration && index === piece.segments.length - 1
            ? segment.slice(0, -1)
            : segment;
          line += text;
          key += text;
          continue;
        }
        if (segment.kind === 'addr') {
          const shown = blockStart + pos;
          const digits = segment.radix === 'd'
            ? String(shown)
            : shown.toString(segment.radix === 'o' ? 8 : 16);
          line += hexdumpFormatNumber(segment, digits);
          continue;
        }
        if (missing) {
          const pad = ' '.repeat(hexdumpFieldWidth(segment, piece.size));
          line += pad;
          key += pad;
          continue;
        }
        let value = 0;
        for (let b = piece.size - 1; b >= 0; b--) value = value * 256 + (unit[b] ?? 0);
        pos += piece.size;
        if (segment.conv === 'c') {
          const text = hexdumpFormatNumber(segment, String.fromCharCode(value & 0xff));
          line += text;
          key += text;
          continue;
        }
        let digits: string;
        if (segment.conv === 'd') {
          const signBit = 256 ** piece.size / 2;
          digits = String(value >= signBit ? value - signBit * 2 : value);
        } else if (segment.conv === 'u') {
          digits = String(value);
        } else if (segment.conv === 'o') {
          digits = value.toString(8);
        } else {
          digits = value.toString(16);
          if (segment.conv === 'X') digits = digits.toUpperCase();
        }
        const text = hexdumpFormatNumber(segment, digits);
        line += text;
        key += text;
      }
      consumed += unit.length;
    }
  }
  if (consumed === 0) return null;
  return { line, key, consumed };
}

/** Body columns for the fixed modes; the caller prefixes the address. */
function hexdumpFixedBody(mode: 'default' | 'x' | 'd' | 'o' | 'C', row: Uint8Array): { body: string; bar: string | null } {
  if (mode === 'C') {
    const group1 = Array.from(row.subarray(0, 8), (b) => b.toString(16).padStart(2, '0'));
    const group2 = Array.from(row.subarray(8), (b) => b.toString(16).padStart(2, '0'));
    const columns = group1.join(' ') + (group2.length > 0 ? '  ' + group2.join(' ') : '');
    const bar = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    return { body: columns.padEnd(50), bar };
  }
  if (mode === 'default') {
    const words: string[] = [];
    for (let i = 0; i < row.length; i += 2) {
      words.push(leWord(row.subarray(i)).toString(16).padStart(4, '0'));
    }
    return { body: words.join(' ').padEnd(39), bar: null };
  }
  const slots: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    const chunk = row.subarray(i);
    if (chunk.length === 0) { slots.push(' '.repeat(8)); continue; }
    const rendered = mode === 'x'
      ? leWord(chunk).toString(16).padStart(4, '0')
      : mode === 'd'
        ? String(leWord(chunk)).padStart(5, '0')
        : leWord(chunk).toString(8).padStart(6, '0');
    slots.push(rendered.padStart(i === 0 ? 7 : 8));
  }
  return { body: slots.join(''), bar: null };
}

type HexdumpArgs =
  | { error: string }
  | {
      mode: 'default' | 'x' | 'd' | 'o' | 'C';
      pieces: HexdumpPiece[] | null;
      length: number | undefined;
      verbose: boolean;
      files: string[];
    };

/** Format flags override each other (last wins); `-e` replaces them all. */
function parseHexdumpArgs(args: string[]): HexdumpArgs {
  let mode: 'default' | 'x' | 'd' | 'o' | 'C' = 'default';
  let pieces: HexdumpPiece[] | null = null;
  let length: number | undefined;
  let verbose = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    const flag = arg[1];
    const inlineValue = arg.slice(2);
    if (flag === 'C' || flag === 'x' || flag === 'd' || flag === 'o') {
      if (inlineValue !== '') return { error: `hexdump: invalid option -- '${flag}'` };
      mode = flag;
      continue;
    }
    if (flag === 'v' && inlineValue === '') { verbose = true; continue; }
    if (flag !== 'e' && flag !== 'n') {
      return { error: `hexdump: invalid option -- '${flag}'` };
    }
    const value = inlineValue || args[++i];
    if (value === undefined || value === '') {
      return { error: `hexdump: option requires an argument -- '${flag}'` };
    }
    if (flag === 'n') {
      const parsed = parseDumpCount(value);
      if (parsed === null || parsed < 0) {
        return { error: `hexdump: invalid length '${value}'` };
      }
      length = parsed;
      continue;
    }
    if (pieces !== null) return { error: 'hexdump: only one -e format is supported' };
    const parsed = parseHexdumpPieces(value);
    if ('error' in parsed) return parsed;
    if (!parsed.pieces.some((piece) => piece.consumes)) {
      return { error: `hexdump: bad format {${value}}` };
    }
    // The block is held twice while it is classified, so a format whose
    // rendering cannot fit is refused here — before a byte is ever read.
    let blockChars = 0;
    for (const piece of parsed.pieces) {
      let perIteration = 0;
      for (const segment of piece.segments) {
        if (typeof segment === 'string') { perIteration += segment.length; continue; }
        if (segment.kind === 'addr') {
          perIteration += Math.max(segment.width ?? 0, HEXDUMP_MAX_ADDRESS_DIGITS);
          continue;
        }
        // A narrow field cannot shrink a value: `%1u` over four bytes still
        // renders ten characters. Size each conversion by the widest of its
        // field width, its precision plus a sign, and the natural maximum
        // for its byte size.
        const digits = HEXDUMP_DIGIT_WIDTHS[String(piece.size)];
        const natural = segment.conv === 'c'
          ? 1
          : segment.conv === 'd'
            ? digits.d + 1
            : segment.conv === 'u'
              ? digits.d
              : segment.conv === 'o'
                ? digits.o
                : digits.x;
        perIteration += Math.max(segment.width ?? 0, natural, (segment.precision ?? 0) + 1);
      }
      blockChars += (piece.consumes ? piece.count : 1) * perIteration;
    }
    if (blockChars > HEXDUMP_MAX_BLOCK_CHARS) {
      return {
        error: `hexdump: format renders ${blockChars} characters per block, over the ${HEXDUMP_MAX_BLOCK_CHARS} limit`,
      };
    }
    pieces = parsed.pieces;
  }
  return { mode, pieces, length, verbose, files };
}

function mkHexdump(): CmdFn {
  return async (ctx) => {
    const parsed = parseHexdumpArgs(ctx.args);
    if ('error' in parsed) {
      (await ctx.stderr.write(`${parsed.error}\n`));
      return 1;
    }
    const src = new DumpByteSource(ctx, 'hexdump', parsed.files, parsed.length);
    const dedup = new RowDedup();
    if (parsed.pieces !== null) {
      const lastPiece = parsed.pieces[parsed.pieces.length - 1];
      const lastSegment = lastPiece.segments[lastPiece.segments.length - 1];
      // Repeat suppression needs line boundaries; free-form formats emit
      // the whole stream, which is what -v spells on util-linux.
      const lineStructured = typeof lastSegment === 'string' && lastSegment.endsWith('\n');
      // Units arrive from a small stash fed well ahead of demand, so
      // per-unit pulls amortize into large source reads without ever
      // holding count*size bytes for a block.
      let pending = HEXDUMP_EMPTY_UNIT;
      const pullUnit = async (size: number): Promise<Uint8Array> => {
        while (pending.length < size) {
          // Ready reads: a file answers the whole block in one range read,
          // and a live producer answers with whatever it has already written.
          const chunk = await src.takeReady(Math.max(size - pending.length, HEXDUMP_PULL_BYTES));
          if (chunk === null || chunk.length === 0) break;
          const merged = new Uint8Array(pending.length + chunk.length);
          merged.set(pending);
          merged.set(chunk, pending.length);
          pending = merged;
        }
        const unit = pending.subarray(0, size);
        pending = pending.subarray(unit.length);
        return unit;
      };
      let offset = 0;
      while (true) {
        const block = await hexdumpRenderBlock(parsed.pieces, pullUnit, offset);
        if (block === null) break;
        offset += block.consumed;
        if (!lineStructured) { (await ctx.stdout.write(block.line)); continue; }
        switch (dedup.classify(block.key, parsed.verbose)) {
          case 'print': (await ctx.stdout.write(block.line)); break;
          case 'star': (await ctx.stdout.write('*\n')); break;
        }
      }
      if (src.failedAll) (await ctx.stderr.write('hexdump: all input file arguments failed\n'));
      return src.failed ? 1 : 0;
    }

    const wide = parsed.mode === 'C';
    while (true) {
      const row = await src.take(16);
      if (row === null || row.length === 0) break;
      const { body, bar } = hexdumpFixedBody(parsed.mode, row);
      const address = (src.total - row.length).toString(16).padStart(wide ? 8 : 7, '0');
      switch (dedup.classify(body, parsed.verbose)) {
        case 'print':
          (await ctx.stdout.write(wide ? `${address}  ${body}|${bar}|\n` : `${address} ${body}\n`));
          break;
        case 'star':
          (await ctx.stdout.write('*\n'));
          break;
      }
    }
    if (src.failedAll) (await ctx.stderr.write('hexdump: all input file arguments failed\n'));
    if (src.total > 0) {
      (await ctx.stdout.write(`${src.total.toString(16).padStart(wide ? 8 : 7, '0')}\n`));
    }
    return src.failed ? 1 : 0;
  };
}

// ── xxd ─────────────────────────────────────────────────────────────────

/**
 * `xxd [FILE [-] [OUTFILE]]` — pipelines are xxd's primary use, so stdin is
 * read when no input operand is given or `-` names it. A second positional
 * operand receives the dump as a file, like real xxd. `-l N` limits the dump
 * (decimal, 0x hex, leading-zero octal, with count suffixes); `-p` emits
 * continuous hex in bounded 30-byte rows. The default row layout predates
 * this fix and is preserved verbatim.
 */
function mkXxd(): CmdFn {
  return async (ctx) => {
    let plain = false;
    let limit: number | undefined;
    const operands: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-p') { plain = true; continue; }
      if (arg === '-' || !arg.startsWith('-')) {
        if (operands.length >= 2) {
          (await ctx.stderr.write(`xxd: extra operand '${arg}'\n`));
          return 1;
        }
        operands.push(arg);
        continue;
      }
      if (arg === '-l' || arg.startsWith('-l')) {
        const value = arg === '-l' ? ctx.args[++i] : arg.slice(2);
        const parsed = value === undefined ? null : parseDumpCount(value);
        if (parsed === null || parsed < 0) {
          (await ctx.stderr.write(`xxd: invalid length value '${value ?? ''}'\n`));
          return 1;
        }
        limit = parsed;
        continue;
      }
      (await ctx.stderr.write(`xxd: invalid option -- '${arg.replace(/^-+/, '')}'\n`));
      return 1;
    }

    // Prime the source FIRST: pull the initial window (surfacing any open
    // error) before the output file exists to truncate.
    const rowSize = plain ? 30 : 16;
    const src = new DumpByteSource(ctx, 'xxd', operands.slice(0, 1), limit);
    const firstWindow = await src.take(rowSize);
    if (src.failedAll || (src.failed && src.opened === 0)) return 1;

    // A second operand names the output file; `-` there means stdout. It
    // routes through ctx.vfs like every other named path, so dumps may land
    // on devices and mounts as they do on Unix.
    const output = operands[1];
    const outAbs = output !== undefined && output !== '-' ? resolvePath(ctx.cwd, output) : null;

    let offset = 0;
    let fileOffset = 0;
    let pending: string[] = [];
    let pendingBytes = 0;
    let writeFailed = false;
    const flush = async () => {
      if (pending.length === 0 || writeFailed || outAbs === null) return;
      try {
        (await ctx.vfs.writeRange(outAbs, fileOffset, encode(pending.join(''))));
      } catch (error) {
        (await ctx.stderr.write(`xxd: ${output}: ${strerror(error)}\n`));
        writeFailed = true;
        return;
      }
      fileOffset += pendingBytes;
      pending = [];
      pendingBytes = 0;
    };

    const renderWindow = (rowOffset: number, window: Uint8Array): string => {
      if (plain) {
        let line = '';
        for (const byte of window) line += byte.toString(16).padStart(2, '0');
        return `${line}\n`;
      }
      const pairs = Array.from(window, (b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = Array.from(window, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      return `${rowOffset.toString(16).padStart(8, '0')}: ${pairs.padEnd(48)}  ${ascii}\n`;
    };

    if (outAbs !== null) {
      // Input proved readable above, so truncating here cannot destroy data
      // on a failed dump.
      try {
        (await ctx.vfs.writeFile(outAbs, ''));
      } catch (error) {
        (await ctx.stderr.write(`xxd: ${output}: ${strerror(error)}\n`));
        return 1;
      }
    }

    let window = firstWindow;
    while (window !== null && window.length > 0 && !writeFailed) {
      const text = renderWindow(offset, window);
      offset += window.length;
      if (outAbs !== null) {
        pending.push(text);
        pendingBytes += text.length;
        if (pendingBytes >= 65536) (await flush());
      } else {
        (await ctx.stdout.write(text));
      }
      window = await src.take(rowSize);
    }
    if (outAbs !== null) (await flush());
    return src.failed || writeFailed ? 1 : 0;
  }
}

/**
 * A command's adapter onto the shell. stdin is left to the command: a pipe
 * reader stays one, for the command to read when it does (stdinText, or the
 * stream itself), so one that never reads its stdin never waits on its end,
 * as a Unix command does not. It used to be read to its end before every
 * command ran, which held `printf x > f` until a child process's parent ended
 * its stdin. The terminal's own stream is the exception: the shell hands it
 * to every command and closes it only after the command returns, so its
 * already-typed text is taken in place, without awaiting its end.
 */
function wrap(fn: CmdFn): (ctx: Ctx) => Promise<number> {
  return async (ctx: Ctx) => {
    try {
      const stdin = ctx.stdin;
      if (stdin && typeof stdin !== 'string' && typeof stdin.feed === 'function') {
        const drainable = stdin as { drainBuffered?: () => string };
        ctx.stdin = typeof drainable.drainBuffered === 'function' ? drainable.drainBuffered() : '';
      }
      return await fn(ctx);
    } catch (e) {
      if (isBrokenPipe(e)) throw e;
      (await ctx.stderr.write(`${errorText(e)}\n`));
      return 1;
    }
  };
}

export function registerUnixCommands(
  registry: UnixCommandRegistry,
  sqliteVfs: SqliteVFS,
): void {
  registry.register('which', wrap(withInvocationVfs((vfs) => mkWhich(vfs, registry))));
  registry.register('whereis', wrap(withInvocationVfs((vfs) => mkWhereis(vfs, registry))));
  registry.register('command', wrap(withInvocationVfs((vfs) => mkCommand(vfs, registry))));
  registry.register('type', wrap(withInvocationVfs((vfs) => mkType(vfs, registry))));
  registry.register('export', wrap(mkExport()));
  registry.register('unset', wrap(mkUnset()));
  registry.register('clear', wrap(mkClear()));
  registry.register('setfacl', wrap(mkSetfacl(sqliteVfs)));
  registry.register('getfacl', wrap(mkGetfacl(sqliteVfs)));
  registry.register('date', wrap(mkDate()));
  registry.register('uptime', wrap(mkUptime()));
  registry.register('tree', wrap(withInvocationVfs(mkTree)));
  registry.register('grep', textCommand(grepCommand));
  // SHELL-R6-B2: head reads the pipe reader itself, so it terminates after
  // N lines, triggering the abort cascade for upstream producers like `yes`.
  registry.register('head', textCommand(headCommand));
  registry.register('tail', textCommand(tailCommand));
  registry.register('wc', textCommand(wcCommand));
  registry.register('sort', textCommand(sortCommand));
  registry.register('uniq', textCommand(uniqCommand));
  registry.register('sed', textCommand(sedCommand));
  registry.register('awk', wrap(withInvocationVfs(mkAwk)));
  registry.register('xargs', wrap(withInvocationVfs((vfs) => mkXargs(vfs, registry))));
  registry.register('tee', textCommand(teeCommand));
  registry.register('du', wrap(withInvocationVfs(mkDu)));
  // Registry-level echo + cat for xargs cross-command dispatch.
  // Shell.builtins still wins for direct `echo X` invocations; this
  // entry is only reached when a command (xargs etc.) looks them up
  // via the registry path.
  registry.register('echo', wrap(mkEcho()));
  registry.register('pwd', wrap(withInvocationVfs(mkPwd)));
  registry.register('cat', textCommand(catCommand));
  registry.register('tac', textCommand(tacCommand));
  registry.register('ls', wrap(withInvocationVfs(mkLs)));
  registry.register('rm', wrap(withInvocationVfs(mkRm)));
  registry.register('touch', wrap(withInvocationVfs(mkTouch)));
  registry.register('stat', wrap(withInvocationVfs((v) => mkStat(v, sqliteVfs))));
  registry.register('base64', wrap(withInvocationVfs(mkBase64)));
  registry.register('id', wrap(mkId(sqliteVfs)));
  registry.register('realpath', wrap(withInvocationVfs(mkRealpath)));
  registry.register('printf', wrap(mkPrintf()));
  registry.register('true', wrap(mkTrue()));
  registry.register('false', wrap(mkFalse()));
  registry.register('readlink', wrap(withInvocationVfs(mkReadlink)));
  registry.register('md5sum', textCommand(checksum.md5sum));
  registry.register('sha1sum', textCommand(checksum.sha1sum));
  registry.register('sha224sum', textCommand(checksum.sha224sum));
  registry.register('sha256sum', textCommand(checksum.sha256sum));
  registry.register('sha384sum', textCommand(checksum.sha384sum));
  registry.register('sha512sum', textCommand(checksum.sha512sum));
  registry.register('b2sum', textCommand(checksum.b2sum));
  registry.register('cksum', textCommand(checksum.cksum));
  registry.register('sum', textCommand(checksum.sum));
  registry.register('file', wrap(withInvocationVfs(mkFile)));
  // od/hexdump/xxd read operands and sinks through ctx.vfs — the
  // mount-aware seam the host hands every command — so they need no
  // invocation-scoped raw view of their own.
  registry.register('xxd', wrap(mkXxd()));
  registry.register('od', wrap(mkOd()));
  registry.register('hexdump', wrap(mkHexdump()));


  // ln -s makes a symbolic link; the filesystem has no hard links.
  registry.register('ln', wrap(async ctx => {
    const symbolic = ctx.args.some(arg => /^-[^-]*s/.test(arg));
    const force = ctx.args.some(arg => /^-[^-]*f/.test(arg));
    const operands = ctx.args.filter(arg => !arg.startsWith('-'));
    if (operands.length !== 2) { await ctx.stderr.write('ln: expected target and link path\n'); return 1; }
    if (!symbolic) { await ctx.stderr.write('ln: hard links are not supported\n'); return 1; }
    const path = resolvePath(ctx.cwd, operands[1]);
    try {
      if (force) await ctx.vfs.remove(path, { force: true });
      await ctx.vfs.symlink(operands[0], path);
    } catch (error) {
      if (!isVfsError(error)) throw error;
      await ctx.stderr.write(`ln: failed to create symbolic link '${operands[1]}': ${strerror(error)}\n`);
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
