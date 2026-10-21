/** lifo's Node `fs`: the shared one (node-compat/fs.ts) over its synchronous filesystem. */
import { createNodeFs } from '../../../node-compat/fs.js';
import type { NodeFilesystem } from './filesystem.js';

/**
 * `stdin` reads fd 0 to its end, blocking until it ends, as a synchronous
 * read of it does in Node; what it returned is all fd 0 holds, so a second
 * read finds it at its end.
 */
export function createFs(vfs: NodeFilesystem, cwd: string, stdin?: () => Uint8Array, reachStreams?: () => void) {
  return createNodeFs({ sync: vfs }, { cwd, stdin, reachStreams });
}
