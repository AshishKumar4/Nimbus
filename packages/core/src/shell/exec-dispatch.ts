/**
 * exec-dispatch — POSIX execve semantics for path-shaped shell invocations
 * (`./x`, `/abs/x`, `../x`). Pure decision logic; the resolve-hook in
 * session/init.ts turns decisions into commands (wasm-runner, shebang
 * interpreter, sh fallback, or an error writer).
 *
 * Decision ladder (mirrors execve + the shell's ENOEXEC fallback):
 *   1. no exec bit → EACCES ("permission denied"), with one grandfather
 *      exception: wasm-magic files whose stored mode was never explicitly
 *      set stay executable (see below).
 *   2. `\0asm` magic → run via wasm-runner (the platform's native format).
 *   3. `#!` line → run via the named interpreter.
 *   4. binary-looking content (NUL byte in the head) → ENOEXEC surfaced as
 *      an honest "exec format not supported" error (ELF and friends).
 *   5. anything else → run as a shell script (POSIX ENOEXEC sh fallback).
 *
 * Grandfather rule (WASI-PLAN Stage 1): before Stage 1, chmod was a no-op,
 * so no stored mode was ever explicitly chosen by a user — wasm binaries
 * auto-ran on magic alone. Explicitly-set modes are stamped with POSIX
 * S_IF* filetype bits (SqliteVFS.chmod); bare permission values mean "mode
 * metadata was never set", and wasm-magic files with such modes stay
 * executable until touched. No migration.
 */

import { resolveContext, type CommandRegistry, type ResolveContext } from '../substrate/lifo/commands/registry.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import { X_OK, type ProcessView } from '../runtime/process-files.js';
import { normalizeVfsPath, resolveVfsPath } from '../vfs/path.js';
import { isVfsError } from '../vfs/vfs-error.js';

export interface ShebangLine {
  /** Interpreter as written (e.g. "/usr/bin/env" resolved → "node"). */
  interpreter: string;
  /** Optional interpreter arguments from the shebang line. */
  args: string[];
}

export type ExecDispatchDecision =
  | { kind: 'wasm' }
  | { kind: 'shebang'; shebang: ShebangLine }
  | { kind: 'shell-script' }
  | { kind: 'denied' }
  | { kind: 'exec-format-error' };

/** Bytes of head to inspect: covers magic + the longest useful `#!` line. */
export const EXEC_HEAD_BYTES = 512;

export function isWasmMagic(head: Uint8Array): boolean {
  return head.length >= 4
    && head[0] === 0x00 && head[1] === 0x61
    && head[2] === 0x73 && head[3] === 0x6d;
}

export function isExecutableMode(mode: number, wasmMagic: boolean): boolean {
  if ((mode & 0o111) !== 0) return true;
  return wasmMagic && (mode & 0o170000) === 0;
}

/**
 * Parse a `#!interp [args...]` first line. `#!/usr/bin/env X [args]`
 * resolves to interpreter X (env's `-S`/`--split-string` is transparent —
 * both forms word-split here anyway).
 */
export function parseShebang(head: Uint8Array): ShebangLine | null {
  if (head.length < 3 || head[0] !== 0x23 || head[1] !== 0x21) return null;
  const nl = head.indexOf(0x0a);
  const lineBytes = head.subarray(2, nl === -1 ? head.length : nl);
  const line = new TextDecoder().decode(lineBytes).replace(/\r$/, '');
  const words = line.trim().split(/[ \t]+/).filter(Boolean);
  if (words.length === 0) return null;
  let interpreter = words[0];
  let args = words.slice(1);
  if (basename(interpreter) === 'env') {
    while (args[0] === '-S' || args[0] === '--split-string') args = args.slice(1);
    if (args.length === 0) return null;
    interpreter = args[0];
    args = args.slice(1);
  }
  return { interpreter, args };
}

export function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function decideExecDispatch(mode: number, head: Uint8Array): ExecDispatchDecision {
  const wasm = isWasmMagic(head);
  if (!isExecutableMode(mode, wasm)) return { kind: 'denied' };
  if (wasm) return { kind: 'wasm' };
  const shebang = parseShebang(head);
  if (shebang) return { kind: 'shebang', shebang };
  if (head.includes(0)) return { kind: 'exec-format-error' };
  return { kind: 'shell-script' };
}

/** What the resolver inspects a path with: a view of the namespace that awaits an asynchronous mount. */
export type ExecInspectionFs = Pick<ProcessView, 'stat' | 'readRange' | 'realpath'>;

/**
 * What is at a path-shaped name: nothing runnable, a directory, or a file
 * with its mode and head. The file is run by the name it was invoked by,
 * unless that name is itself a link, which is run by its target.
 */
type Inspected = null | 'directory' | { target: string; mode: number; head: Uint8Array };

async function inspect(fs: ExecInspectionFs, path: string): Promise<Inspected> {
  try {
    const stat = await fs.stat(path);
    if (stat === null) return null;
    if (stat.type === 'directory') return 'directory';
    const target = (await fs.stat(path, { follow: false }))?.type === 'symlink' ? await fs.realpath(path) : path;
    return { target, mode: stat.mode, head: await fs.readRange(target, 0, EXEC_HEAD_BYTES) };
  } catch (error) {
    // A missing name, a component that is not a directory, or a link loop: "command not found".
    if (isVfsError(error, 'ENOENT') || isVfsError(error, 'ENOTDIR') || isVfsError(error, 'ELOOP')) return null;
    throw error;
  }
}

/**
 * What execvp's search of PATH finds for a bare name: the first executable
 * regular file, or, when every file it finds is not executable, the first
 * of those (which execvp fails with EACCES).
 */
export type PathSearchResult =
  | { readonly kind: 'program'; readonly path: string }
  | { readonly kind: 'not-executable'; readonly path: string }
  | null;

/**
 * The directories `from.path` names, in order, as execvp reads them: an
 * empty entry is the current directory, and a relative one is taken from it.
 */
function pathDirectories(from: ResolveContext): string[] {
  const directories: string[] = [];
  for (const entry of from.path.split(':')) {
    const directory = '/' + resolveVfsPath(entry, normalizeVfsPath(from.cwd));
    if (!directories.includes(directory)) directories.push(directory);
  }
  return directories;
}

/** Whether a failed call is the caller's lack of permission, which a search of PATH passes over. */
function isDenied(error: unknown): boolean {
  return isVfsError(error, 'EACCES') || isVfsError(error, 'EPERM');
}

/**
 * execvp's search for `name`, a name with no slash, along the caller's PATH,
 * as the caller: each directory in turn, a directory entry of that name
 * passed over, and a file the caller may not execute (or reach) remembered
 * and passed over. A file is executable when the caller's access(X_OK)
 * allows it, the check a path-shaped invocation makes before it runs.
 */
export async function searchPath(name: string, from: ResolveContext): Promise<PathSearchResult> {
  let notExecutable: string | null = null;
  for (const directory of pathDirectories(from)) {
    const candidate = directory === '/' ? `/${name}` : `${directory}/${name}`;
    try {
      const stat = await from.view.stat(candidate);
      if (stat === null || stat.type === 'directory') continue;
      await from.view.access(candidate, X_OK);
      return { kind: 'program', path: candidate };
    } catch (error) {
      if (isDenied(error)) notExecutable ??= candidate;
      else if (!isVfsError(error, 'ENOENT') && !isVfsError(error, 'ENOTDIR') && !isVfsError(error, 'ELOOP')) throw error;
    }
  }
  return notExecutable === null ? null : { kind: 'not-executable', path: notExecutable };
}

/** The file each command a PATH search resolved runs: what `type` and `command -v` report for it. */
const programPaths = new WeakMap<object, string>();

/** The file `command` runs, when a search of PATH found it; undefined for a registered command. */
export function programPathOf(command: object): string | undefined {
  return programPaths.get(command);
}

/**
 * A command whose resolution failed on what the namespace could not answer,
 * or would not show the caller: it fails as execve's error does.
 */
function failing(name: string, error: unknown): Command {
  const message = isDenied(error) ? 'Permission denied' : error instanceof Error ? error.message : String(error);
  return async (ctx): Promise<number> => {
    (await ctx.stderr.write(`${name}: ${message}\n`));
    return 126;
  };
}

/**
 * Resolve path-shaped names, and bare names along PATH, to what the file is.
 * Everything is looked at through the caller's view; `fs` is the view of a
 * caller that resolves without a context of its own.
 */
export function installPathExecResolver(
  registry: CommandRegistry,
  fs: ProcessView,
  getCwd: () => string,
): void {
  const originalResolve = registry.resolve.bind(registry);
  registry.resolve = async (name: string, from?: ResolveContext): Promise<Command | undefined> => {
    const found = await originalResolve(name, from);
    if (found) return found;
    if (!name) return undefined;
    const context = from ?? resolveContext(getCwd(), undefined, fs);

    // A bare name is searched for along the caller's PATH, as execvp
    // searches it; the file found then resolves by its path, through every
    // resolver (an npm bin shim is the npm program it names), and the
    // command it gives runs that file and no other.
    if (!name.includes('/')) {
      let hit: PathSearchResult;
      try {
        hit = await searchPath(name, context);
      } catch (error) {
        return failing(name, error);
      }
      if (hit === null) return undefined;
      const path = hit.path;
      let program: Command;
      if (hit.kind === 'not-executable') {
        program = async (ctx): Promise<number> => {
          (await ctx.stderr.write(`${path}: Permission denied\n`));
          return 126;
        };
      } else {
        const command = await registry.resolve(path, context);
        if (!command) return undefined;
        program = async (ctx) => await command(ctx);
      }
      programPaths.set(program, path);
      return program;
    }
    if (!name.startsWith('./') && !name.startsWith('/') && !name.startsWith('../')) return undefined;

    const resolved = '/' + resolveVfsPath(name, normalizeVfsPath(context.cwd));
    let inspected: Inspected;
    try {
      inspected = await inspect(context.view, resolved);
    } catch (error) {
      // What the namespace cannot answer (an absent mount, a backend's I/O
      // error) fails this command, as execve's error does; the rest of the
      // line still runs.
      return failing(name, error);
    }
    if (inspected === null) return undefined;
    if (inspected === 'directory') {
      return async (ctx): Promise<number> => {
        (await ctx.stderr.write(`${name}: Is a directory\n`));
        return 126;
      };
    }

    const { mode, head } = inspected;
    const accessPath = resolved;
    const absPath = inspected.target;
    const authorize = (command: Command): Command => async (ctx): Promise<number> => {
      try {
        (await ctx.vfs.access(accessPath, X_OK));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('ENOENT:')) {
          (await ctx.stderr.write(`${name}: No such file or directory\n`));
          return 127;
        }
        if (message.startsWith('EACCES:') || message.startsWith('EPERM:')) {
          (await ctx.stderr.write(`${name}: Permission denied\n`));
          return 126;
        }
        (await ctx.stderr.write(`${name}: ${message}\n`));
        return 126;
      }
      return (await command(ctx));
    };

    const decision = decideExecDispatch(mode, head);
    switch (decision.kind) {
      case 'denied':
        return authorize(async (ctx): Promise<number> => {
          (await ctx.stderr.write(`${name}: Permission denied\n`));
          return 126;
        });
      case 'exec-format-error':
        return authorize(async (ctx): Promise<number> => {
          (await ctx.stderr.write(`${name}: cannot execute binary file: exec format not supported on Nimbus (wasm32-wasi only)\n`));
          return 126;
        });
      case 'wasm': {
        const wasmRunnerCmd = await originalResolve('wasm-runner');
        if (!wasmRunnerCmd) return undefined;
        return authorize(async (ctx): Promise<number> => {
          return await wasmRunnerCmd({ ...ctx, args: [absPath, ...ctx.args] });
        });
      }
      case 'shebang':
      case 'shell-script': {
        const interp = decision.kind === 'shebang' ? decision.shebang.interpreter : 'sh';
        const interpArgs = decision.kind === 'shebang' ? decision.shebang.args : [];
        return authorize(async (ctx): Promise<number> => {
          const depth = interpreterDepth(ctx);
          if (depth >= 4) {
            (await ctx.stderr.write(`${name}: too many levels of interpreters\n`));
            return 126;
          }
          // `#!/usr/bin/env node` names node, which env finds on the script's PATH.
          const from = resolveContext(ctx.cwd, ctx.env, ctx.vfs);
          let interpCmd = await registry.resolve(interp, from);
          if (!interpCmd && interp.includes('/')) {
            interpCmd = await registry.resolve(basename(interp), from);
          }
          if (!interpCmd) {
            (await ctx.stderr.write(`${name}: ${interp}: bad interpreter: No such file or directory\n`));
            return 127;
          }
          return await interpCmd({
            ...ctx,
            args: [...interpArgs, absPath, ...ctx.args],
            execInterpreterDepth: depth + 1,
          });
        });
      }
    }
  };
}

function interpreterDepth(ctx: CommandContext): number {
  return ctx.execInterpreterDepth ?? 0;
}
