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
import type { CommandRegistry } from '../substrate/lifo/commands/registry.js';
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
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
export declare function installPathExecResolver(registry: CommandRegistry, kernelFs: CredentialedVfs, getCwd: () => string): void;
//# sourceMappingURL=exec-dispatch.d.ts.map