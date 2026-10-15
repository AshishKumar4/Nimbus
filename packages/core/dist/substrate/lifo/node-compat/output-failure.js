/**
 * output-failure.ts — a failed write to a program's stdout or stderr, as Node
 * reports it. The guest (node-guest.ts) gives the error to the program's
 * stream; the host (node-realm.ts) reports one the program could not hear
 * as Node reports an error that ended a process. One error, one report.
 */
import { errnoDescription, errnoOf, VFS_ERRNO } from '../../../vfs/vfs-error.js';
/**
 * Node's error for a write the output refused: a pipe's as its stream reports
 * it (`write EPIPE`), a file's as fs does (`ENOSPC: no space left on device,
 * write`), each with its fields in Node's order.
 */
export function writeFailure(code, pipe) {
    const errno = errnoOf(code) ?? VFS_ERRNO.EIO;
    if (pipe)
        return Object.assign(new Error(`write ${code}`), { errno, code, syscall: 'write' });
    return Object.assign(new Error(`${code}: ${errnoDescription(code) ?? 'i/o error'}, write`), { errno, syscall: 'write', code });
}
/** What Node prints of an uncaught `reason`: an error's stack, and its own fields after it (`{ errno: -32, code: 'EPIPE', … }`), each as `inspect` shows it. */
export function uncaughtReport(reason, inspect) {
    if (!(reason instanceof Error))
        return String(reason);
    const head = reason.stack ?? reason.message;
    const fields = Object.keys(reason);
    if (fields.length === 0)
        return head;
    return `${head} {\n${fields.map((field) => `  ${field}: ${inspect(Reflect.get(reason, field))}`).join(',\n')}\n}`;
}
