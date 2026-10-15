import { ttyOf } from './tty-streams.js';

/**
 * Node.js `tty` module shim for Lifo, as lifo's public module: the module
 * tty-streams.ts makes, over no program's descriptors (what a WriteStream is
 * given goes nowhere, a ReadStream is at its end, isatty is false). A
 * program's module map makes its own, joined to its descriptors.
 */
const nowhere = { write: () => {} };
const tty = ttyOf({ stdout: nowhere, stderr: nowhere, env: {} }).module;

export const { ReadStream, WriteStream, isatty } = tty;
export default tty;
