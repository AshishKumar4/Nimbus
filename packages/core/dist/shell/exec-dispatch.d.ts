/**
 * exec-dispatch — POSIX execve semantics for path-shaped shell invocations
 * (`./x`, `/abs/x`, `dir/x`). Pure decision logic; the resolve-hook in
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
import { type CommandRegistry, type ResolveContext } from '../substrate/lifo/commands/registry.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import { type ProcessView } from '../runtime/process-files.js';
import { type VfsErrorCode } from '../vfs/vfs-error.js';
export interface ShebangLine {
    /** Interpreter as written (e.g. "/usr/bin/env" resolved → "node"). */
    interpreter: string;
    /** Optional interpreter arguments from the shebang line. */
    args: string[];
}
export type ExecDispatchDecision = {
    kind: 'wasm';
} | {
    kind: 'shebang';
    shebang: ShebangLine;
} | {
    kind: 'shell-script';
} | {
    kind: 'denied';
} | {
    kind: 'exec-format-error';
};
/** Bytes of head to inspect: covers magic + the longest useful `#!` line. */
export declare const EXEC_HEAD_BYTES = 512;
export declare function isWasmMagic(head: Uint8Array): boolean;
export declare function isExecutableMode(mode: number, wasmMagic: boolean): boolean;
/**
 * Parse a `#!interp [args...]` first line. `#!/usr/bin/env X [args]`
 * resolves to interpreter X (env's `-S`/`--split-string` is transparent —
 * both forms word-split here anyway).
 */
export declare function parseShebang(head: Uint8Array): ShebangLine | null;
export declare function basename(path: string): string;
export declare function decideExecDispatch(mode: number, head: Uint8Array): ExecDispatchDecision;
/** What the resolver inspects a path with: a view of the namespace that awaits an asynchronous mount. */
export type ExecInspectionFs = Pick<ProcessView, 'stat' | 'readRange' | 'realpath'>;
/**
 * What execvp's search of PATH finds for a bare name: the first executable
 * regular file, or, when every file it finds is not executable, the first
 * of those (which execvp fails with EACCES).
 */
export type PathSearchResult = {
    readonly kind: 'program';
    readonly path: string;
} | {
    readonly kind: 'not-executable';
    readonly path: string;
} | null;
/**
 * execvp's search for `name`, a name with no slash, along the caller's PATH,
 * as the caller: each directory in turn, a directory entry of that name
 * passed over, and a file the caller may not execute (or reach) remembered
 * and passed over. A file is executable when the caller's access(X_OK)
 * allows it, the check a path-shaped invocation makes before it runs, or
 * when `runs` says the shell runs it by its path (a runtime's launcher,
 * runtime-store.ts, which the registry knows by its path).
 */
export declare function searchPath(name: string, from: ResolveContext, runs?: (path: string) => boolean): Promise<PathSearchResult>;
/**
 * What a command a resolver gave stands for, as `type`, `command -v` and
 * `which` report it: the file a search of PATH found (executable or not, as
 * bash reports either); a resolution that failed on what the namespace
 * could not answer, or the stub a known runtime that is not installed
 * resolves to (runtimeInstallHint), which they report as not found.
 */
export type Resolution = {
    readonly kind: 'program';
    readonly path: string;
} | {
    readonly kind: 'directory';
} | {
    readonly kind: 'failed';
} | {
    readonly kind: 'install-hint';
};
/** How `command` was resolved, when a resolver gave it; undefined for a registered command. */
export declare function resolutionOf(command: object): Resolution | undefined;
/**
 * `command` as the stub a known runtime that is not installed resolves to:
 * run, it says how to install the runtime; to `type`, `which` and a child's
 * launcher it is no command.
 */
export declare function runtimeInstallHint(command: Command): Command;
/** Whether `command` is a runtime's install hint (runtimeInstallHint). */
export declare function isRuntimeInstallHint(command: object): boolean;
/**
 * The command a child launcher (child_process.spawn, a program's cpSpawn)
 * runs for `name`, as a search from `from` finds it, for every launcher:
 * null for none, and for a runtime's install hint, which is no program
 * (the launcher answers ENOENT, as Node's spawn of a missing command does).
 * A program a search of PATH found must be one the caller may execute
 * (`view`'s access: EACCES otherwise).
 */
export declare function resolveChildCommand(registry: CommandRegistry, name: string, from: ResolveContext, view: ProcessView): Promise<Command | null>;
/**
 * What execve(2) refuses `command`, what `name` resolved to from `cwd`, as
 * `view` sees it: EACCES for a directory, the error its X_OK check meets for
 * a path name's file or the one a PATH search found; null when it may run
 * (a registered command by its name always may).
 */
export declare function execRefusal(name: string, cwd: string, command: object, view: Pick<ProcessView, 'access'>): Promise<VfsErrorCode | null>;
/**
 * Resolve path-shaped names, and bare names along PATH, to what the file is.
 * Everything is looked at through the caller's view; `fs` is the view of a
 * caller that resolves without a context of its own.
 */
export declare function installPathExecResolver(registry: CommandRegistry, fs: ProcessView, getCwd: () => string): void;
//# sourceMappingURL=exec-dispatch.d.ts.map