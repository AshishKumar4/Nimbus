/** lifo's Node `fs`: the shared one (node-compat/fs.ts) over its synchronous filesystem. */
import { createNodeFs } from '../../../node-compat/fs.js';
/**
 * `stdin` reads fd 0 to its end, blocking until it ends, as a synchronous
 * read of it does in Node; what it returned is all fd 0 holds, so a second
 * read finds it at its end.
 */
export function createFs(vfs, cwd, stdin, reachStreams) {
    return createNodeFs({ sync: vfs }, { cwd, stdin, reachStreams });
}
