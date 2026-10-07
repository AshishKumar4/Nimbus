// Hand-made wasm modules for the wasm-runner probes, and the two terminal
// steps every one of them takes: stage a module, run an export.
//
// Fixture authoring constraint: every byte MUST be < 0x80 (ASCII). The
// probes land a module via `node fs.writeFileSync(buffer)`, which inside the
// node-runtime shim goes through TextDecoder.decode(bytes) → string → UTF-8
// re-encode; a byte ≥ 0x80 becomes the replacement character (EF BF BD) and
// corrupts the wasm. (A 232-byte multimath.wasm once carried one 0xa2 in a
// code-section LEB128 length and would not load.) Keep every section under
// 128 bytes so each LEB128 length is one byte < 0x80; opcodes and indices
// are in the ASCII range too.

import { stripAnsi } from '../_driver.mjs';

/**
 * 70-byte AssemblyScript-compiled add(i32,i32) → i32, with a name section.
 * Verified: WebAssembly.instantiate(buf).exports.add(3, 4) === 7.
 */
export const ADD_WASM_B64 =
  'AGFzbQEAAAABBwFgAn9/AX8DAgEABQMBAAAHEAIDYWRkAAAGbWVtb3J5AgAKCQEHACAAIAFqCwANBG5hbWUBBgEAA2FkZA==';

/**
 * 60-byte subtract(i32,i32) → i32 (`i32.sub` where add has `i32.add`), no
 * name section. assemblyscript@0.28.17; verified subtract(10, 5) === 5.
 */
export const SUBTRACT_WASM_B64 =
  'AGFzbQEAAAABBwFgAn9/AX8DAgEABQMBAAAHFQIIc3VidHJhY3QAAAZtZW1vcnkCAAoJAQcAIAAgAWsL';

/**
 * 105-byte module exposing add/sub/mul/max/memory:
 *   add(a,b): local.get 0; local.get 1; i32.add
 *   sub(a,b): local.get 0; local.get 1; i32.sub
 *   mul(a,b): local.get 0; local.get 1; i32.mul
 *   max(a,b): a; b; a; b; i32.gt_s; select   (pick first if a>b)
 */
export const MULTI_WASM_B64 =
  'AGFzbQEAAAABBwFgAn9/AX8DBQQAAAAABQMBAAAHIgUDYWRkAAADc3ViAAEDbXVsAAIDbWF4AAMGbWVtb3J5AgAKJgQHACAAIAFqCwcAIAAgAWsLBwAgACABbAsMACAAIAEgACABShsL';

/** Write a base64 module to `name` in the terminal's cwd. */
export function writeWasm(t, name, b64) {
  return t.run(`node -e "require('fs').writeFileSync('${name}', Buffer.from('${b64}','base64'))"`, 30_000);
}

/** Run `cmd` and match a single-integer line `expected` in the last six lines. */
export async function runFor(t, cmd, expected) {
  const r = await t.run(cmd, 60_000);
  const tail = stripAnsi(r.output).split(/\r?\n/).slice(-6).join('\n');
  return { cmd, matched: new RegExp(`^\\s*${expected}\\s*$`, 'm').test(tail), tail };
}
