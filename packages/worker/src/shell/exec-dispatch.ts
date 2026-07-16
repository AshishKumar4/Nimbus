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
