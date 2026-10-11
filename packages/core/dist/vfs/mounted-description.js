/**
 * A file on a mount, opened: open(2) as the namespace decides it for every
 * caller (a process's synchronous and asynchronous faces, a wave's open),
 * and the description its descriptors share. The open is decided through
 * `files`, the namespace as the caller sees it: its synchronous face
 * (CompositeVFS.sync), which refuses an asynchronous mount at the first
 * lookup, before anything has changed; or the namespace itself. The
 * description holds the file where that lookup landed (CompositeVFS.pin).
 */
import { processView } from '../runtime/descriptors.js';
import { runtimeStatOf } from './composite.js';
import { andThen, isPromise, readRangeOrWhole } from './vfs.js';
import { isVfsError } from './vfs-error.js';
/** What one description holds unwritten before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export const BUFFERED_WRITE_BYTES = 8 * 1024 * 1024;
/**
 * Where an open looks its name up (CompositeVFS.pin): through a link at it,
 * unless it declines to (O_NOFOLLOW) or answers for the name itself
 * (O_CREAT|O_EXCL).
 */
export function openFollows(flags) {
    return flags.followSymlinks && !(flags.create && flags.exclusive);
}
/**
 * open(2) of `file` (pinned where its name was looked up, openFollows), one
 * rule for every caller, Linux's where Linux and POSIX differ: O_CREAT|O_EXCL
 * is EEXIST on the name itself, a link included; O_NOFOLLOW of a link is
 * ELOOP; an absent name without O_CREAT is ENOENT, and with O_DIRECTORY
 * EINVAL; O_DIRECTORY of anything else is ENOTDIR; a directory refuses
 * O_TRUNC and O_APPEND (EISDIR); and only then is the file made, or
 * truncated, there. Answers the file's stat. Who may open a file for what is
 * its mount's own policy, as for every operation on it (VFS.access, asked of
 * a file that is there before anything changes): a backend that takes a
 * caller's credential enforces modes; a backend of one identity has none.
 * `describes`: whether the open keeps a description, whose write rights a
 * directory may carry (a WASI guest asks a capability set); an open that
 * keeps none (a wave's) is an open to write, which a directory refuses.
 * `settled` runs right before the answer, or the change.
 */
export function openOnMount(file, open, describes, settled) {
    const { files, path } = file;
    const { flags, refuse } = open;
    const statAfter = () => andThen(files.stat(path), (after) => {
        if (after === null)
            throw refuse('ENOENT', 'open');
        return after;
    });
    return andThen(files.stat(path, { follow: false }), (named) => {
        if (named !== null && flags.create && flags.exclusive)
            throw refuse('EEXIST', 'open');
        if (named?.type === 'symlink' && !flags.followSymlinks)
            throw refuse('ELOOP', 'open');
        // A link a backend resolves itself (MountOptions.resolvesPaths) is followed by that backend.
        return andThen(named?.type === 'symlink' ? files.stat(path) : named, (there) => {
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
            const access = there === null ? undefined : files.access?.(path, openAccess(flags, there, describes));
            return andThen(access, () => andThen(settled?.(), () => {
                if (there !== null && !flags.truncate)
                    return there;
                if (there !== null) {
                    // A description needs only the file's inode, which truncating keeps; a wave answers the stat after.
                    const truncated = need(files.truncate, refuse, 'open').call(files, path, 0);
                    return describes ? andThen(truncated, () => there) : andThen(truncated, statAfter);
                }
                return andThen(files.writeFile(path, new Uint8Array(0), open.mode === undefined ? undefined : { mode: open.mode }), statAfter);
            }));
        });
    });
}
/**
 * The access an open asks of a file that is there (VFS.access's mode). A
 * description's write rights on a directory are a capability, not an
 * access; a wave's open is to write.
 */
function openAccess(flags, there, describes) {
    return (flags.read ? 4 : 0) | (flags.write && (!describes || there.type !== 'directory') ? 2 : 0);
}
/** open(2) of a mounted file, and the description its descriptors share: one pin, for both. */
export function openMounted(options) {
    return andThen(options.pin(options.name, openFollows(options.flags)), (file) => andThen(openOnMount(file, options, true), (stat) => describeMounted(options, file, stat.ino ?? 0)));
}
/** The description of `file`, opened already (openOnMount), its number `ino`: what its descriptors share. */
export function describeMounted(context, file, ino) {
    return new MountedDescription(context, file, ino);
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
class MountedDescription {
    options;
    pinned;
    ino;
    mounted = true;
    /** The file's backend operations, where the open's lookup landed (CompositeVFS.pin). */
    files;
    /** The path they are handed. */
    at;
    immediate;
    inPlace = true;
    pending = [];
    held = 0;
    constructor(options, pinned, ino) {
        this.options = options;
        this.pinned = pinned;
        this.ino = ino;
        if (pinned.awaits)
            this.awaits = true;
        this.files = pinned.files;
        this.at = pinned.path;
        this.immediate = options.sync || pinned.awaits;
    }
    /** The namespace's name for it, when it was opened. */
    path() { return this.pinned.name; }
    /** Which file it is (PinnedFile.key): whose held writes this process's reads of it overlay (processView). */
    key() { return this.pinned.key; }
    stat() {
        return andThen(this.files.stat(this.at), (there) => {
            if (there === null)
                throw this.options.refuse('ENOENT', 'fstat');
            const now = runtimeStatOf(there);
            return andThen(this.viewed(), (view) => (view ? { ...now, size: view.byteLength } : now));
        });
    }
    read(offset, length) {
        const view = this.viewed();
        if (view === undefined)
            return readRangeOrWhole(this.files, this.at, offset, length);
        return andThen(view, (bytes) => (bytes ? bytes.slice(offset, offset + length) : readRangeOrWhole(this.files, this.at, offset, length)));
    }
    write(offset, bytes) {
        const written = this.inPlaceAt(offset, bytes);
        if (written === undefined)
            return this.hold(offset, bytes);
        return isPromise(written) ? written.then((end) => (end === undefined ? this.hold(offset, bytes) : bytes.byteLength)) : bytes.byteLength;
    }
    /** At the end as it is then (answers that end); a held one goes at the end as it stands at the flush. */
    append(bytes) {
        if (!this.inPlace)
            return this.heldAppend(bytes);
        return andThen(this.files.stat(this.at), (there) => {
            const written = this.inPlaceAt(there?.size ?? 0, bytes);
            if (written === undefined)
                return this.heldAppend(bytes);
            return isPromise(written) ? written.then((end) => end ?? this.heldAppend(bytes)) : written;
        });
    }
    truncate(size) { return need(this.files.truncate, this.options.refuse, 'ftruncate').call(this.files, this.at, size); }
    readdir() {
        return andThen(this.files.readdir(this.at), (entries) => entries.map((entry) => ({ name: entry.name, type: entry.type })));
    }
    chmod(mode) { return need(this.files.chmod, this.options.refuse, 'fchmod').call(this.files, this.at, mode); }
    chown(uid, gid) { return need(this.files.chown, this.options.refuse, 'fchown').call(this.files, this.at, uid, gid); }
    utimes(atime, mtime) { return need(this.files.utimes, this.options.refuse, 'futimes').call(this.files, this.at, atime, mtime); }
    /** A flush that fails loses what it held (lastClose says so): taken before it reads. */
    flush() {
        if (this.pending.length === 0)
            return;
        const writes = this.pending;
        this.pending = [];
        this.held = 0;
        return andThen(this.whole(), (file) => this.files.writeFile(this.at, apply(writes, file)));
    }
    close() { return this.flush(); }
    pendingBytes() { return this.held; }
    applyPending(file) { return apply(this.pending, file); }
    whole() {
        return andThen(this.files.stat(this.at), (there) => (there === null ? new Uint8Array(0) : this.files.readFile(this.at)));
    }
    hold(offset, bytes) {
        if (this.held + bytes.byteLength > this.options.bufferedWriteBytes)
            throw this.options.refuse('EFBIG', 'write');
        this.pending.push({ offset, bytes: bytes.slice() });
        this.held += bytes.byteLength;
        return this.immediate ? andThen(this.flush(), () => bytes.byteLength) : bytes.byteLength;
    }
    /**
     * This process's view of the file while it holds writes to it, by any of
     * its descriptions (processView): this one's own O_SYNC governs only its
     * writes.
     */
    viewed() {
        return processView(this.options.scope, this.pinned);
    }
    heldAppend(bytes) {
        return andThen(this.hold(null, bytes), () => andThen(this.stat(), (now) => now.size));
    }
    /**
     * `bytes` written in place at `offset` when the mount can (writeRange):
     * the end written. Undefined from its first refusal (none, or ENOTSUP):
     * the description holds its writes from then on.
     */
    inPlaceAt(offset, bytes) {
        const writeRange = this.files.writeRange;
        if (!this.inPlace || writeRange === undefined) {
            this.inPlace = false;
            return undefined;
        }
        let written;
        try {
            written = writeRange.call(this.files, this.at, offset, bytes);
        }
        catch (error) {
            return this.cannot(error);
        }
        const end = offset + bytes.byteLength;
        return isPromise(written) ? written.then(() => end, (error) => this.cannot(error)) : end;
    }
    cannot(error) {
        if (!isVfsError(error, 'ENOTSUP'))
            throw error;
        this.inPlace = false;
        return undefined;
    }
}
/** `file` with `writes` applied in order (an append at the end as it then is): what a flush writes, and what a process reads. */
function apply(writes, base) {
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
}
/** A mount's optional operation, or ENOTSUP when it has none. */
function need(fn, refuse, syscall) {
    if (typeof fn !== 'function')
        throw refuse('ENOTSUP', syscall);
    return fn;
}
