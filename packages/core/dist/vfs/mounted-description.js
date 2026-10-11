/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. Its operations go through
 * `files`, the namespace as the caller sees it: its synchronous face
 * (CompositeVFS.sync), which refuses an asynchronous mount at the first
 * lookup, before anything has changed; or the namespace itself.
 */
import { processView } from '../runtime/descriptors.js';
import { runtimeStatOf } from './composite.js';
import { andThen, isPromise, readRangeOrWhole } from './vfs.js';
import { isVfsError } from './vfs-error.js';
/** What one description holds unwritten before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export const BUFFERED_WRITE_BYTES = 8 * 1024 * 1024;
/**
 * open(2) of `name`, one rule for every caller, Linux's where Linux and
 * POSIX differ: O_CREAT|O_EXCL is EEXIST on the name itself, a link
 * included; O_NOFOLLOW of a link is ELOOP; an absent name without O_CREAT is
 * ENOENT, and with O_DIRECTORY EINVAL; O_DIRECTORY of anything else is
 * ENOTDIR; a directory refuses O_TRUNC and O_APPEND (EISDIR); and only
 * then is the file made, or truncated. Answers the file's stat. Who may
 * open a file for what is the mount's own policy, as for every operation on
 * it: a backend that takes a caller's credential (VFS.as) enforces modes; a
 * backend of one identity has none. `describes`: whether the open keeps a description, whose
 * write rights a directory may carry (a WASI guest asks a capability set);
 * an open that keeps none (a wave's) is an open to write, which a directory
 * refuses. `settled` runs right before the answer, or the change.
 */
export function openOnMount(open, describes, settled) {
    const { files, name, flags, refuse } = open;
    return andThen(files.stat(name, { follow: false }), (named) => {
        if (named !== null && flags.create && flags.exclusive)
            throw refuse('EEXIST', 'open');
        if (named?.type === 'symlink' && !flags.followSymlinks)
            throw refuse('ELOOP', 'open');
        return andThen(named?.type === 'symlink' ? files.stat(name) : named, (there) => {
            if (there === null) {
                if (!flags.create)
                    throw refuse('ENOENT', 'open');
                if (flags.directory)
                    throw refuse('EINVAL', 'open');
            }
            else {
                if (flags.directory && there.type !== 'directory')
                    throw refuse('ENOTDIR', 'open');
                if (there.type === 'directory' && (flags.truncate || flags.append || (flags.write && !describes)))
                    throw refuse('EISDIR', 'open');
            }
            return andThen(settled?.(), () => {
                if (there !== null && !flags.truncate)
                    return there;
                const changed = there === null
                    ? files.writeFile(name, new Uint8Array(0), open.mode === undefined ? undefined : { mode: open.mode })
                    : need(files.truncate, refuse, 'open').call(files, name, 0);
                return andThen(changed, () => andThen(files.stat(name), (after) => {
                    if (after === null)
                        throw refuse('ENOENT', 'open');
                    return after;
                }));
            });
        });
    });
}
/** open(2) of a mounted file, and the description its descriptors share. */
export function openMounted(options) {
    return andThen(openOnMount(options, true), (stat) => andThen(options.realpath(options.name), (file) => mountedDescription({ ...options, name: file }, stat)));
}
/**
 * The description of `name` on a mount. A write goes in place (writeRange);
 * on a mount that cannot (none, or ENOTSUP), the description holds its
 * writes, at most `bufferedWriteBytes` (EFBIG past it, nothing held), and a
 * flush (fsync, the last close, the process's release) reads the file,
 * applies them in order and writes it back; this process reads the file
 * with them applied. Writes made by awaiting, or under O_SYNC, are flushed
 * as each is made, so a write's answer is what the mount did.
 */
function mountedDescription(options, stat) {
    const { files, name, refuse, scope } = options;
    const immediate = options.sync || options.awaits;
    let inPlace = true;
    let pending = [];
    let held = 0;
    const whole = () => andThen(files.stat(name), (there) => (there === null ? new Uint8Array(0) : files.readFile(name)));
    // `file` with `writes` applied in order (an append at the end as it then
    // is): what a flush writes, and what this process reads.
    const apply = (writes, base) => {
        // A copy: a backend may hand out its own buffer, which must not change before the flush.
        let file = base.slice();
        for (const write of writes) {
            const at = write.offset ?? file.byteLength;
            if (at + write.bytes.byteLength > file.byteLength) {
                const grown = new Uint8Array(at + write.bytes.byteLength);
                grown.set(file);
                file = grown;
            }
            file.set(write.bytes, at);
        }
        return file;
    };
    // A flush that fails loses what it held (lastClose says so): taken before it reads.
    const flush = () => {
        if (pending.length === 0)
            return;
        const writes = pending;
        pending = [];
        held = 0;
        return andThen(whole(), (file) => files.writeFile(name, apply(writes, file)));
    };
    const hold = (offset, bytes) => {
        if (held + bytes.byteLength > options.bufferedWriteBytes)
            throw refuse('EFBIG', 'write');
        pending.push({ offset, bytes: bytes.slice() });
        held += bytes.byteLength;
        return immediate ? andThen(flush(), () => bytes.byteLength) : bytes.byteLength;
    };
    // This process's view of the file while it holds writes to it, by any of its descriptions (processView).
    const viewed = () => (immediate ? undefined : processView(scope, () => {
        const file = whole();
        return isPromise(file) ? null : file;
    }, name));
    // In place when the mount can (writeRange); from its first refusal (none, or ENOTSUP), `otherwise`. Answers the end written.
    const inPlaceOr = (offset, bytes, otherwise) => {
        if (!inPlace || files.writeRange === undefined) {
            inPlace = false;
            return otherwise();
        }
        const cannot = (error) => {
            if (!isVfsError(error, 'ENOTSUP'))
                throw error;
            inPlace = false;
            return otherwise();
        };
        let written;
        try {
            written = files.writeRange(name, offset, bytes);
        }
        catch (error) {
            return cannot(error);
        }
        return isPromise(written) ? written.then(() => offset + bytes.byteLength, cannot) : offset + bytes.byteLength;
    };
    const statNow = () => andThen(files.stat(name), (there) => {
        if (there === null)
            throw refuse('ENOENT', 'fstat');
        const now = runtimeStatOf(there);
        const view = viewed();
        return view ? { ...now, size: view.byteLength } : now;
    });
    const op = (fn, syscall) => (...args) => need(fn, refuse, syscall).call(files, name, ...args);
    return {
        ino: stat.ino ?? 0,
        mounted: true,
        ...(options.awaits ? { awaits: true } : {}),
        path: () => name,
        stat: statNow,
        read: (offset, length) => {
            const view = viewed();
            return view ? view.slice(offset, offset + length) : readRangeOrWhole(files, name, offset, length);
        },
        write: (offset, bytes) => andThen(inPlaceOr(offset, bytes, () => hold(offset, bytes)), () => bytes.byteLength),
        // At the end as it is then; a held one goes at the end as it stands at the flush.
        append: (bytes) => {
            const held = () => andThen(hold(null, bytes), () => andThen(statNow(), (now) => now.size));
            return inPlace ? andThen(files.stat(name), (there) => inPlaceOr(there?.size ?? 0, bytes, held)) : held();
        },
        truncate: op(files.truncate, 'ftruncate'),
        readdir: () => andThen(files.readdir(name), (entries) => entries.map((entry) => ({ name: entry.name, type: entry.type }))),
        chmod: op(files.chmod, 'fchmod'),
        chown: op(files.chown, 'fchown'),
        utimes: op(files.utimes, 'futimes'),
        flush,
        close: flush,
        pendingBytes: () => held,
        applyPending: (base) => apply(pending, base),
    };
}
/** A mount's optional operation, or ENOTSUP when it has none. */
function need(fn, refuse, syscall) {
    if (typeof fn !== 'function')
        throw refuse('ENOTSUP', syscall);
    return fn;
}
