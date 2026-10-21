/**
 * node-arguments.ts — Node's argument validators (lib/internal/validators.js
 * and lib/internal/fs/utils.js, v22.23.4) that both Node fronts take: the
 * shell's node imports them, and scripts/bundle-facet-workers.mjs compiles
 * them into the guest's shims (NODE_ARGUMENTS_PREAMBLE), beside node-error.ts,
 * whose errors they throw.
 */

import { invalidArgType, invalidArgValue, outOfRange } from './node-error.js';

/** Linux's open(2) bits, as fs.constants has them. */
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_ACCMODE = 3;
export const O_CREAT = 64;
export const O_EXCL = 128;
export const O_TRUNC = 512;
export const O_APPEND = 1024;
export const O_DIRECTORY = 65536;
export const O_NOFOLLOW = 131072;
export const O_SYNC = 1052672;

/** Node's flag strings (stringToFlags), as bits. */
const FLAG_STRINGS: Readonly<Record<string, number>> = {
  r: O_RDONLY, rs: O_RDONLY | O_SYNC, sr: O_RDONLY | O_SYNC,
  'r+': O_RDWR, 'rs+': O_RDWR | O_SYNC, 'sr+': O_RDWR | O_SYNC,
  w: O_TRUNC | O_CREAT | O_WRONLY, wx: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL, xw: O_TRUNC | O_CREAT | O_WRONLY | O_EXCL,
  'w+': O_TRUNC | O_CREAT | O_RDWR, 'wx+': O_TRUNC | O_CREAT | O_RDWR | O_EXCL, 'xw+': O_TRUNC | O_CREAT | O_RDWR | O_EXCL,
  a: O_APPEND | O_CREAT | O_WRONLY, ax: O_APPEND | O_CREAT | O_WRONLY | O_EXCL, xa: O_APPEND | O_CREAT | O_WRONLY | O_EXCL,
  as: O_APPEND | O_CREAT | O_WRONLY | O_SYNC, sa: O_APPEND | O_CREAT | O_WRONLY | O_SYNC,
  'a+': O_APPEND | O_CREAT | O_RDWR, 'ax+': O_APPEND | O_CREAT | O_RDWR | O_EXCL, 'xa+': O_APPEND | O_CREAT | O_RDWR | O_EXCL,
  'as+': O_APPEND | O_CREAT | O_RDWR | O_SYNC, 'sa+': O_APPEND | O_CREAT | O_RDWR | O_SYNC,
};

/** validateInt32: an integer from `min` to `max`, by default an int32. */
export function validateInt32(value: unknown, name: string, min = -2147483648, max = 2147483647): number {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
  return value;
}

/** validateUint32: an integer from 0 (from 1 when `positive`) to 2 ** 32 - 1. */
export function validateUint32(value: unknown, name: string, positive = false): number {
  if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
  const min = positive ? 1 : 0;
  if (value < min || value > 4294967295) throw outOfRange(name, `>= ${min} && <= 4294967295`, value);
  return value;
}

/**
 * A uid or gid as Node's chown reads it (an integer from -1 to 2 ** 32 - 1):
 * -1, and 2 ** 32 - 1, which Node's binding converts to the same uid_t, keep
 * the file's (null).
 */
export function nodeOwnerId(value: unknown, name: string): number | null {
  const id = validateInt32(value, name, -1, 4294967295);
  return id === -1 || id === 4294967295 ? null : id;
}

/** stringToFlags: an open's flags, a flag string from Node's table or an int32 of bits; none is 'r'. */
export function stringToFlags(flags: unknown, name = 'flags'): number {
  if (typeof flags === 'number') return validateInt32(flags, name);
  if (flags === undefined || flags === null) return O_RDONLY;
  if (typeof flags === 'string' && Object.hasOwn(FLAG_STRINGS, flags)) return FLAG_STRINGS[flags];
  throw invalidArgValue('flags', flags);
}

/** parseFileMode: a mode, an octal string of digits alone or a uint32; none is `def`. */
export function parseFileMode(value: unknown, name: string, def?: number): number {
  let mode = value ?? def;
  if (typeof mode === 'string') {
    if (!/^[0-7]+$/.test(mode)) throw invalidArgValue(name, mode, 'must be a 32-bit unsigned integer or an octal string');
    mode = Number.parseInt(mode, 8);
  }
  return validateUint32(mode, name);
}
