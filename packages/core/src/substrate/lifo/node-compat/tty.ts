import { createTty } from './tty-streams.js';

/**
 * Node.js `tty` module shim for Lifo, as lifo's public module: the streams
 * tty-streams.ts makes, which a program's module map makes when it requires
 * tty (this module loads the engine's stream module as it loads).
 */
const tty = createTty();

export const { ReadStream, WriteStream, isatty } = tty;
export default tty;
