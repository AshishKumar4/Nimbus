import { DIRENT_TYPES, direntTypeOfStat } from '../../vfs/dirent-type.js';
/** Another descriptor on a resident open, as dup(2) makes one: the same offset, the same hold. */
export function shareResident(open) {
    open.opens++;
    return open;
}
/**
 * One descriptor on a resident open closed. The last gives back its hold:
 * the session descriptor it was read through, closed without waiting on it,
 * as nothing of the guest's depends on it; else its pin, and its share of
 * the file it keeps.
 */
export function closeResident(open, fs) {
    if (--open.opens > 0)
        return;
    if ('handle' in open.hold) {
        closeUnawaited(fs, open.hold.handle);
        return;
    }
    open.hold.pin?.release();
    const kept = open.kept;
    if (kept !== undefined && --kept.copies === 0)
        after(kept.held, (held) => { if (held !== null)
            closeUnawaited(held.fs, held.handle); });
}
/**
 * Synthetic paths that name a socket rather than a file, and the one place
 * their spelling lives — the codec recognises them to hand them back, the host
 * recognises them to open them, and a second literal would let the two drift.
 *
 * No filesystem holds any of them, so a path_open naming one belongs to the
 * host's own socket bodies.
 */
/** Dial: mirrors bash's /dev/tcp/<host>/<port> redirection convention. */
export const WASI_TCP_PATH_PREFIX = '/dev/tcp/';
/**
 * Listen, as a descriptor. Reading it is accept(2): the read suspends until a
 * connection is queued and yields that connection's id, so a server's accept
 * loop is an ordinary blocking read with no cooperative pump behind it.
 */
export const WASI_LISTEN_PATH_PREFIX = '/dev/nimbus/listen/';
/**
 * The accept half of the dial: binds a connection the kernel has already
 * accepted to a descriptor. It goes through path_open like the dial half
 * because guests layered over wasi-vfs (ruby.wasm) resolve descriptors through
 * their own fd table, so one handed to them out of band is unusable.
 */
export const WASI_ACCEPTED_PATH_PREFIX = '/dev/nimbus/socket/';
const S_IFMT = 0o170000, S_IFREG = 0o100000;
const socketPathPrefixes = [WASI_TCP_PATH_PREFIX, WASI_LISTEN_PATH_PREFIX, WASI_ACCEPTED_PATH_PREFIX];
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
/** Every code a VFS backend throws (vfs-error.ts), as its preview1 errno. */
const VFS_ERRNO = {
    E2BIG: 1, EACCES: 2, EAGAIN: 6, EBADF: 8, EBUSY: 10, EEXIST: 20, EFBIG: 22, EINVAL: 28, EIO: 29, EISDIR: 31,
    ELOOP: 32, ENAMETOOLONG: 37, ENOENT: 44, ENOSPC: 51, ENOTDIR: 54, ENOTEMPTY: 55, ENOTSUP: 58,
    ENXIO: 60, EPERM: 63, EROFS: 69, ESTALE: 72, EXDEV: 75,
};
const errno = {
    ...VFS_ERRNO,
    // The codec's own refusals, and the session's for a process it no longer holds.
    EFAULT: 21, EINTR: 27, EMFILE: 33, ENFILE: 41, ENOMEM: 48, ENOSYS: 52,
    EPIPE: 64, ESPIPE: 70, ESRCH: 71, ENOTCAPABLE: 76,
};
/**
 * A refused filesystem call as the guest's errno. The session's refusal of a
 * process it no longer holds (process-table.ts noSuchProcess: it restarted,
 * or ended the process, while the program ran) answers ESRCH and is also
 * handed to `gone`, so the run can end naming it ({@link processGoneMessage}).
 */
export function refusalErrno(error, gone) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        gone?.(error.message);
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
        return errno[error.code] ?? errno.EIO;
    if (error instanceof RangeError)
        return errno.EFAULT;
    return errno.EIO;
}
/** How a run whose session no longer holds its process ends. */
export function processGoneMessage(refusal) {
    return `the session no longer holds this process (${refusal}): it restarted, or ended the process, while the program ran, so every filesystem call since answered ESRCH`;
}
export function after(value, next) {
    return value instanceof Promise ? value.then(next) : next(value);
}
function fail(code) { throw Object.assign(new Error(code), { code }); }
/** Whether `fs` holds file bytes itself, and pins them for a descriptor (wasi/resident-filesystem.ts). */
function pinsContent(fs) {
    return typeof Reflect.get(fs, 'pinContent') === 'function';
}
/**
 * Before a change takes the names `paths` away on `fs` (an unlink's, a
 * rename's from and to), keeps the files that resident copies in `tables`
 * are of there (KeptFile); for a directory among them (a rename's), every
 * copied file, as its names may be beneath it. Settles once each hold is
 * answered, so the change cannot reach the session before it; at once, and
 * asking the session nothing, when no copy lacks one.
 */
export function keepCopiesBefore(fs, paths, tables) {
    // A copy is one open however many descriptors (dup's, a fork's) name it.
    const unkept = new Set();
    for (const table of tables)
        for (const e of table.values())
            if (e.kind === 'resident' && e.kept === undefined && !('handle' in e.hold))
                unkept.add(e);
    if (unkept.size === 0)
        return;
    const steps = paths.map((name) => {
        let st;
        try {
            st = fs.stat(name, { followSymlinks: false });
        }
        catch {
            return;
        }
        const keepAt = (found) => {
            if (found === null)
                return;
            // One hold per file, every copy of it sharing it; a copy closed while the stat was asked is gone.
            const files = new Map();
            for (const e of unkept) {
                if (e.opens === 0 || e.kept !== undefined || !('name' in e.hold))
                    continue;
                const file = found.type === 'directory' || (found.dev === e.stat.dev && found.ino === e.stat.ino);
                if (!file)
                    continue;
                const key = `${e.stat.dev}:${e.stat.ino}`;
                const group = files.get(key);
                if (group !== undefined)
                    group.copies.push(e);
                // Beneath a directory, by the name the copy was read at, followed as it was then; else the name taken away, which is the file itself.
                else if (found.type === 'directory')
                    files.set(key, { name: e.hold.name, follow: e.hold.follow, copies: [e] });
                else
                    files.set(key, { name, follow: false, copies: [e] });
            }
            const holding = [];
            for (const { name: at, follow, copies } of files.values()) {
                const kept = { held: holdFile(fs, at, follow, copies[0].stat), copies: copies.length };
                for (const e of copies)
                    e.kept = kept;
                holding.push(kept.held);
            }
            return holding.some((step) => step instanceof Promise) ? Promise.all(holding).then(() => { }) : undefined;
        };
        return st instanceof Promise ? st.then(keepAt, () => { }) : keepAt(st);
    });
    return steps.some((step) => step instanceof Promise) ? Promise.all(steps).then(() => { }) : undefined;
}
/** An O_PATH open of `name` (`follow`: its last link followed), kept when it is the file `stat` describes. */
function holdFile(fs, name, follow, stat) {
    const kept = (opened) => {
        if (opened.stat.dev === stat.dev && opened.stat.ino === stat.ino)
            return { handle: opened.id, fs };
        closeUnawaited(fs, opened.id);
        return null;
    };
    try {
        const opened = fs.open(name, { path: true, followSymlinks: follow });
        return opened instanceof Promise ? opened.then(kept, () => null) : kept(opened);
    }
    catch {
        return null;
    }
}
/** A session descriptor nothing of the guest's waits to see closed: closed, a refusal of it dropped. */
export function closeUnawaited(fs, handle) {
    try {
        const closing = fs.close(handle);
        if (closing instanceof Promise)
            closing.catch(() => { });
    }
    catch { /* the descriptor is the guest's no longer either way */ }
}
/**
 * Opens `name` as the file `identity` (dev, ino) is, where the process holds
 * no descriptor of it to reopen by (an open of /dev/fd/N on a copy): ENOENT
 * once the name has another file, or none. `follow`: as the name was first
 * looked up. Never creates one, and empties it only once it is known to be
 * that file.
 */
export function openIdentified(fs, name, follow, flags, identity) {
    if (flags.create && flags.exclusive)
        fail('EEXIST');
    return after(fs.open(name, { ...flags, create: false, exclusive: false, truncate: false, followSymlinks: follow }), (handle) => {
        if (handle.stat.dev !== identity.dev || handle.stat.ino !== identity.ino) {
            closeUnawaited(fs, handle.id);
            fail('ENOENT');
        }
        if (!flags.truncate)
            return handle;
        return after(fs.ftruncate(handle.id, 0), () => ({ ...handle, stat: { ...handle.stat, size: 0 } }));
    });
}
/** WASI's filetype for a stat's or a dirent's type; WASI has no FIFO, which wasmtime also calls unknown. */
const FILETYPES = {
    unknown: 0, block: 1, character: 2, directory: 3, file: 4, socket: 6, symlink: 7, fifo: 0,
};
const ft = (type) => FILETYPES[type] ?? 0;
const num = (value) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n))
        fail('EINVAL');
    return n;
};
const STANDARD_STREAMS = { '/dev/stdin': 0, '/dev/stdout': 1, '/dev/stderr': 2 };
/**
 * The descriptor `path` names, as Linux's /dev/fd/N, /proc/self/fd/N and
 * /dev/std{in,out,err} do; null for any other path. No filesystem holds what
 * these name: each is the process's own descriptor. A relative `path` is
 * relative to descriptor `fd` of `fds` (a preopen, or a directory the codec
 * holds), or to `cwd` for AT_FDCWD (-1). Every call that takes a path asks
 * this one question: path_open, path_filestat_get, the extension's path_stat
 * and bash's stat_metadata.
 *
 * Linux's answer to what such a path opens: the file or directory itself
 * is opened again, with the new open's flags (a new description, its own
 * offset, O_TRUNC and O_APPEND honored), even one renamed or unlinked
 * since; a stream or a pipe end is shared. Stat'd, it is that descriptor's
 * stat.
 */
export function descriptorNamed(fds, fd, path, cwd) {
    let absolute = path;
    if (!path.startsWith('/')) {
        const base = fds.get(fd);
        const directory = fd === -1 ? cwd
            : base?.kind === 'preopen' ? base.wasiPath
                : base?.kind === 'authority' && base.type === 'directory' ? '/' + base.handle.path
                    : undefined;
        if (directory === undefined)
            return null;
        absolute = directory + '/' + path;
    }
    // Every path but these is turned away before any normalizing: an `fd` segment
    // is followed by a separator, a standard stream's name starts `std`.
    if (!absolute.includes('fd/') && !absolute.includes('std'))
        return null;
    const normal = '/' + absolute.split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
    const stream = Object.hasOwn(STANDARD_STREAMS, normal) ? STANDARD_STREAMS[normal] : undefined;
    if (stream !== undefined)
        return stream;
    const numbered = /^\/(?:dev\/fd|proc\/self\/fd)\/(\d{1,9})$/.exec(normal);
    return numbered === null ? null : Number(numbered[1]);
}
/**
 * st_mode of a stat: its type's format bits, and its permission bits, or
 * Node's defaults (0755 for a directory, 0644 otherwise) where the backend
 * keeps none, as a node process's fs.stat reports them.
 */
export function statMode(st) {
    const permissions = st.mode !== undefined ? st.mode & 0o7777 : st.type === 'directory' ? 0o755 : 0o644;
    return DIRENT_TYPES[direntTypeOfStat(st)].format | permissions;
}
/** Installs the same filesystem codec in the generic WASI and Bash fd domains. */
export function installAuthorityFilesystem(imports, options) {
    const fds = options.fds;
    // Captured before the codec replaces it: closing a pipe, a socket or a
    // stdio fd is the host's business, and fd_renumber over one has to go
    // through its semantics rather than dropping the entry.
    const hostClose = imports.fd_close;
    const memory = () => new Uint8Array(options.memory().buffer);
    // Guest memory at a guest pointer is viewed by the constructor, never by
    // subarray: in a Worker, a WebAssembly.Memory grows past the 128 MiB an
    // ArrayBuffer may have, and subarray refuses a begin past that ("Invalid
    // array buffer length", V8's CalculateByteLength against the embedder's
    // maximum), where the constructor takes any offset within the buffer.
    const guestBytes = (ptr, length) => new Uint8Array(options.memory().buffer, ptr, length);
    const view = () => new DataView(options.memory().buffer);
    const residentTables = options.residentTables ?? (() => [fds]);
    const u32 = (ptr, value) => view().setUint32(ptr, value, true);
    const u64 = (ptr, value) => view().setBigUint64(ptr, BigInt(value), true);
    const path = (ptr, length) => {
        if (ptr < 0 || length < 0 || ptr + length > memory().length)
            fail('EFAULT');
        const p = decoder.decode(guestBytes(ptr, length));
        if (p.includes('\0'))
            fail('EINVAL');
        return p;
    };
    const fs = () => {
        const authority = options.fs();
        if (!authority)
            fail('ENOSYS');
        if (options.synchronous) {
            if (!authority.synchronous)
                fail('ENOTSUP');
            return authority.synchronous;
        }
        return authority;
    };
    const entry = (fd) => {
        const e = fds.get(fd);
        if (!e || (e.kind !== 'authority' && e.kind !== 'resident'))
            fail('EBADF');
        return e;
    };
    // The ops that need a live descriptor on the authority. A resident copy has
    // none, and a read-only open never asked for the rights they check.
    const handle = (fd) => {
        const e = entry(fd);
        if (e.kind !== 'authority')
            fail('ENOTCAPABLE');
        return e;
    };
    // Content by inode, valid while the stat revision matches the one it was read at.
    const resident = options.resident ?? new Map();
    const residentBytes = options.residentBytes ?? 0;
    /** The bytes of the file `st` describes: `read`'s, unless the copy at its revision is kept. */
    const residentContent = (st, read) => {
        // An unlinked file's stat revision is the namespace's, which its own writes do not move: its copy is read each time.
        // So is a file with no revision (0: a mount's backend that keeps none, /proc's files made when read).
        if (options.retainResident === false || st.nlink === 0 || st.revision === 0)
            return read();
        const key = `${st.dev}:${st.ino}`;
        const cached = resident.get(key);
        if (cached && cached.revision === st.revision)
            return cached.bytes;
        return after(read(), bytes => {
            resident.set(key, { revision: st.revision, bytes });
            return bytes;
        });
    };
    /** Whether a read-only open of the file `st` describes is answered from a copy: a small regular file (a device, /dev/zero's S_IFCHR, streams; a mode with no type bits is a file's). */
    const residentable = (st) => {
        const format = (st.mode ?? 0) & S_IFMT;
        return residentBytes > 0 && st.type === 'file' && st.size <= residentBytes && (format === 0 || format === S_IFREG);
    };
    const preopen = (fd) => {
        const e = fds.get(fd);
        return e?.kind === 'preopen' ? e : null;
    };
    // wasi-libc resolves a path against its longest matching preopen and passes
    // only the remainder, so deciding whether the guest named a socket means
    // rebuilding the absolute path exactly as the host's path_open does. A
    // path this codec cannot decode is its own to reject, with the errno its
    // body would have produced.
    const socketPath = (fd, ptr, length) => {
        let guest;
        try {
            guest = path(ptr, length);
        }
        catch {
            return false;
        }
        const base = fds.get(fd);
        if (!guest.startsWith('/') && base?.kind === 'preopen') {
            guest = base.wasiPath.endsWith('/') ? base.wasiPath + guest : base.wasiPath + '/' + guest;
        }
        return socketPathPrefixes.some(prefix => guest.startsWith(prefix));
    };
    /**
     * The descriptor a path beneath `fd` names (descriptorNamed), when the host
     * takes part (duplicate); ENOENT for one the process does not hold, as
     * Linux answers for /dev/fd/N.
     */
    const named = (fd, name) => {
        if (options.duplicate === undefined)
            return null;
        const descriptor = descriptorNamed(fds, fd, name);
        if (descriptor !== null && !fds.has(descriptor))
            fail('ENOENT');
        return descriptor;
    };
    const at = (fd, p) => {
        if (p.startsWith('/'))
            fail('ENOTCAPABLE');
        const e = fds.get(fd);
        if (e?.kind === 'preopen')
            return { root: e.vfsPath, path: underPreopen(e, p), beneath: true };
        const opened = entry(fd);
        if (opened.kind !== 'authority' || opened.type !== 'directory')
            fail('ENOTDIR');
        return { directory: opened.handle.id, path: p, beneath: true };
    };
    // A compiled program's `/` is the shell's cwd, so wasi-libc hands an
    // absolute guest path back as `home/user/x` against that preopen: the
    // program meant the same file the shell calls /home/user/x, not the
    // subtree home/user/home/user. The re-stated root is stripped at a segment
    // boundary; `home/userfoo` is a different directory and is left alone.
    const underPreopen = (e, p) => {
        const root = e.vfsPath;
        if (root.length === 0)
            return p;
        if (p === root)
            return '';
        return p.startsWith(root) && p.charCodeAt(root.length) === 47 ? p.slice(root.length + 1) : p;
    };
    const right = (fd, bit) => {
        const e = entry(fd);
        if (!(e.rights & (1n << BigInt(bit))))
            fail('ENOTCAPABLE');
        return e;
    };
    const creationMode = (base) => {
        const umask = options.umask?.();
        return umask === undefined ? {} : { mode: base & ~umask, umask };
    };
    const pathRight = (fd, bit) => {
        const e = preopen(fd) ?? entry(fd);
        if (!((e.rights ?? 0x1fffffffn) & (1n << BigInt(bit))))
            fail('ENOTCAPABLE');
        return e;
    };
    const stat = (fs, fd) => {
        const p = preopen(fd);
        if (p)
            return after(fs.stat(p.vfsPath), value => value ?? fail('ENOENT'));
        const e = entry(fd);
        return e.kind === 'resident' ? e.stat : fs.fstat(e.handle.id);
    };
    const writeStat = (ptr, st) => {
        const dv = view();
        const old = options.abi === 'preview0';
        memory().fill(0, ptr, ptr + (old ? 56 : 64));
        u64(ptr, st.dev);
        u64(ptr + 8, st.ino);
        dv.setUint8(ptr + 16, ft(st.type));
        if (old)
            u32(ptr + 20, Number(st.nlink));
        else
            u64(ptr + 24, st.nlink);
        const base = old ? 24 : 32;
        u64(ptr + base, st.size);
        u64(ptr + base + 8, BigInt(Math.trunc(st.atime)) * 1000000n);
        u64(ptr + base + 16, BigInt(Math.trunc(st.mtime)) * 1000000n);
        u64(ptr + base + 24, BigInt(Math.trunc(st.ctime)) * 1000000n);
        return 0;
    };
    /** The extension's stat: preview1's filestat, then mode, uid, gid. */
    const writeNimbusStat = (ptr, st) => {
        if (options.abi === 'preview0')
            fail('ENOSYS');
        writeStat(ptr, st);
        u32(ptr + 64, statMode(st));
        u32(ptr + 68, st.uid ?? 0);
        u32(ptr + 72, st.gid ?? 0);
        u32(ptr + 76, 0);
        return 0;
    };
    const guard = (previous, body, owns) => (...args) => {
        if (!options.fs() || (owns && !owns(args)))
            return previous ? previous(...args) : 52;
        const refused = (error) => refusalErrno(error, options.processGone);
        try {
            const result = body(fs(), ...args);
            if (result instanceof Promise) {
                if (options.synchronous)
                    throw new Error('Filesystem synchronous contract returned a Promise');
                return result.catch(refused);
            }
            return result;
        }
        catch (error) {
            return refused(error);
        }
    };
    const owns = (args) => {
        const e = fds.get(Number(args[0]));
        return e?.kind === 'authority' || e?.kind === 'resident' || e?.kind === 'preopen';
    };
    const iovs = (ptr, count) => {
        if (ptr < 0 || count < 0 || count > Math.floor((memory().length - ptr) / 8))
            fail('EFAULT');
        const result = [];
        let total = 0;
        for (let i = 0; i < count; i++) {
            const p = view().getUint32(ptr + i * 8, true), length = view().getUint32(ptr + i * 8 + 4, true);
            if (p + length > memory().length)
                fail('EFAULT');
            result.push({ ptr: p, length });
            total += length;
        }
        return { result, total };
    };
    const scatter = (data, vectors) => {
        let used = 0;
        for (const v of vectors) {
            const n = Math.min(v.length, data.length - used);
            if (n <= 0)
                break;
            memory().set(data.subarray(used, used + n), v.ptr);
            used += n;
        }
        return used;
    };
    const read = (fs, fd, ptr, count, offset, written) => {
        // A directory has no byte stream: POSIX and the host body this took over
        // from both answer EISDIR, and they answer it before any rights check.
        const target = fds.get(fd);
        if (target?.kind === 'preopen' || (target?.kind === 'authority' && target.type === 'directory'))
            fail('EISDIR');
        const e = right(fd, 1), vectors = iovs(ptr, count);
        if (e.kind === 'resident') {
            // As the authority's descriptor (DescriptorTable.read): the offset is where the read starts, past the end too, and never negative.
            if (offset !== null && offset < 0)
                fail('EINVAL');
            const start = offset ?? e.position;
            const used = scatter(e.bytes.subarray(Math.min(start, e.bytes.length), Math.min(e.bytes.length, start + vectors.total)), vectors.result);
            if (offset === null)
                e.position = start + used;
            u32(written, used);
            return 0;
        }
        return after(fs.read(e.handle.id, offset, vectors.total), data => { u32(written, scatter(data, vectors.result)); return 0; });
    };
    const write = (fs, fd, ptr, count, offset, written) => {
        const e = right(fd, 6), vectors = iovs(ptr, count), data = new Uint8Array(vectors.total);
        let used = 0;
        if (e.kind === 'resident')
            fail('ENOTCAPABLE');
        for (const v of vectors.result) {
            data.set(guestBytes(v.ptr, v.length), used);
            used += v.length;
        }
        return after(fs.write(e.handle.id, offset, data), n => { u32(written, n); return 0; });
    };
    const flagsOf = (o) => ({ read: !!(o.requested & 2n), write: !!(o.requested & 64n), append: !!(o.status & 1),
        create: !!(o.oflags & 1), directory: !!(o.oflags & 2), exclusive: !!(o.oflags & 4), truncate: !!(o.oflags & 8), followSymlinks: o.follow,
        ...creationMode(0o666) });
    const opened = (o, handle) => {
        const id = options.allocateFd();
        fds.set(id, { kind: 'authority', handle, type: handle.stat.type, rights: o.requested, rightsInheriting: o.childRights, fdflags: o.status });
        u32(o.out, id);
        return 0;
    };
    const copy = (o, stat, bytes, hold) => {
        const id = options.allocateFd();
        fds.set(id, { kind: 'resident', stat, bytes, hold, opens: 1, position: 0, rights: o.requested, rightsInheriting: o.childRights, fdflags: o.status });
        u32(o.out, id);
        return 0;
    };
    // An open's copy is read by the name it opened, as any read of that name
    // is (a host that stages content answers that read).
    const byName = (o) => after(o.fs.readFile(o.target), bytes => bytes ?? fail('ENOENT'));
    /** A copy of the file `stat` describes, its bytes `content`'s, holding the session's descriptor `held`, which is closed if that fails. */
    const heldCopy = (o, stat, held, content) => {
        let bytes;
        try {
            bytes = residentContent(stat, content);
        }
        catch (error) {
            closeUnawaited(o.fs, held);
            throw error;
        }
        if (!(bytes instanceof Promise))
            return copy(o, stat, bytes, { handle: held });
        return bytes.then(read => copy(o, stat, read, { handle: held }), (error) => { closeUnawaited(o.fs, held); throw error; });
    };
    // A reopen's copy is read through its new descriptor, as its file may have no name.
    const reopenedAs = (o, handle) => (o.readOnly && residentable(handle.stat)
        ? heldCopy(o, handle.stat, handle.id, () => o.fs.read(handle.id, 0, handle.stat.size))
        : opened(o, handle));
    // The filesystem's pin on the bytes at `st`'s revision, as the copy; `otherwise` where it pins none (they changed, the budget is spent, the mode refuses the read).
    const pinned = (o, name, st, otherwise) => {
        const fs = o.fs;
        return pinsContent(fs) ? after(fs.pinContent(name, st), pin => (pin === null ? otherwise() : copy(o, st, pin.bytes, { name: pin.name, follow: false, pin }))) : otherwise();
    };
    const openAuthority = (o) => after(o.fs.open(o.target, flagsOf(o)), handle => opened(o, handle));
    // A file a descriptor holds is opened again as itself, never by a name a
    // rename or an unlink may have given to another (RuntimeFsBridge.reopen),
    // under the access asked as the file is now.
    const openAgain = (o, reopened) => {
        const fs = o.fs;
        if (reopened.kind === 'authority')
            return after(fs.reopen({ handle: reopened.handle.id }, flagsOf(o)), handle => reopenedAs(o, handle));
        const { hold, stat: was } = reopened;
        if ('handle' in hold)
            return after(fs.reopen({ handle: hold.handle }, flagsOf(o)), handle => reopenedAs(o, handle));
        // A copy that holds no descriptor: its file is opened by the name it was read at, while that name has it.
        const again = () => after(openIdentified(fs, hold.name, hold.follow, flagsOf(o), was), handle => reopenedAs(o, handle));
        // Where the name no longer has it, the file it keeps, held before its process took the name away.
        const byHold = (error) => {
            const held = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? reopened.kept?.held ?? null : null;
            if (held === null)
                throw error;
            return after(held, (taken) => {
                if (taken === null)
                    throw error;
                return after(taken.fs.reopen({ handle: taken.handle }, flagsOf(o)), handle => reopenedAs(o, handle));
            });
        };
        const byName = () => {
            if (!o.readOnly || hold.pin === undefined)
                return again();
            // A pinned one's copy is the filesystem's pin at the file's revision now.
            return after(fs.stat(hold.name, { followSymlinks: hold.follow }), st => {
                if (st === null || st.dev !== was.dev || st.ino !== was.ino)
                    fail('ENOENT');
                return pinned(o, hold.name, st, again);
            });
        };
        try {
            const opened = byName();
            return opened instanceof Promise ? opened.catch(byHold) : opened;
        }
        catch (error) {
            return byHold(error);
        }
    };
    imports.path_open = guard(imports.path_open, (fs, fd, lookup, p, n, flags, rights, inherit, status, out) => {
        if (status & ~5)
            fail('ENOTSUP');
        pathRight(fd, 13);
        const name = path(p, n);
        const descriptor = named(fd, name);
        const reopened = descriptor === null ? undefined : fds.get(descriptor);
        if (descriptor !== null && reopened?.kind !== 'authority' && reopened?.kind !== 'resident' && reopened?.kind !== 'preopen') {
            u32(out, options.duplicate?.(descriptor) ?? fail('ENXIO'));
            return 0;
        }
        if (flags & 1)
            pathRight(fd, 10);
        if (flags & 8)
            pathRight(fd, 19);
        // A preopen named by a descriptor path is its root, by name, as everything beneath it is.
        const target = reopened?.kind === 'preopen' ? reopened.vfsPath : at(fd, name);
        const parent = preopen(fd) ?? entry(fd);
        const requested = BigInt(rights), childRights = BigInt(inherit);
        const allowed = parent.rightsInheriting;
        if (allowed !== undefined && ((requested | childRights) & ~allowed))
            fail('ENOTCAPABLE');
        const follow = !!(lookup & 1);
        // Rights that change the file keep the open on the authority: fd_write,
        // fd_allocate, fd_filestat_set_size. wasi-libc asks for sync and status
        // rights on every open, and a resident copy answers those itself.
        const readOnly = !(requested & ((1n << 6n) | (1n << 8n) | (1n << 22n))) && !(flags & 15) && !(status & 1);
        const o = { fs, target, follow, oflags: flags, requested, childRights, status, readOnly, out };
        if (reopened?.kind === 'authority' || reopened?.kind === 'resident')
            return openAgain(o, reopened);
        if (!readOnly || residentBytes === 0)
            return openAuthority(o);
        return after(fs.stat(target, { followSymlinks: follow }), st => {
            if (st === null)
                fail('ENOENT');
            if (!residentable(st))
                return openAuthority(o);
            // A filesystem that holds file bytes itself (wasi/resident-filesystem.ts)
            // is the copy: it pins them for the descriptor under its own budget, and
            // past that budget the descriptor is the session's.
            if (pinsContent(fs))
                return pinned(o, target, st, () => openAuthority(o));
            // A hit needs no permission check of its own: the copy was read under
            // this credential, and a chmod or chown since would have moved the
            // revision along with any rewrite.
            return after(residentContent(st, () => byName(o)), bytes => copy(o, st, bytes, { name: target, follow }));
        });
    }, args => !socketPath(args[0], args[2], args[3]));
    imports.fd_filestat_get = guard(imports.fd_filestat_get, (fs, fd, out) => { pathRight(fd, 21); return after(stat(fs, fd), st => writeStat(out, st)); }, owns);
    // A path naming a descriptor is that descriptor's stat, whoever answers it.
    const descriptorStat = imports.fd_filestat_get;
    imports.path_filestat_get = guard(imports.path_filestat_get, (fs, fd, flags, p, n, out) => {
        pathRight(fd, 18);
        const name = path(p, n);
        const descriptor = named(fd, name);
        if (descriptor !== null)
            return descriptorStat(descriptor, out);
        return after(fs.stat(at(fd, name), { followSymlinks: !!(flags & 1) }), st => writeStat(out, st ?? fail('ENOENT')));
    });
    imports.fd_read = guard(imports.fd_read, (fs, fd, p, n, out) => read(fs, fd, p, n, null, out), owns);
    imports.fd_pread = guard(imports.fd_pread, (fs, fd, p, n, off, out) => read(fs, fd, p, n, num(off), out), owns);
    imports.fd_write = guard(imports.fd_write, (fs, fd, p, n, out) => write(fs, fd, p, n, null, out), owns);
    imports.fd_pwrite = guard(imports.fd_pwrite, (fs, fd, p, n, off, out) => write(fs, fd, p, n, num(off), out), owns);
    imports.fd_close = guard(imports.fd_close, (fs, fd) => {
        // A preopen is the root every path resolves against. Dropping it leaves
        // the guest nothing to open, so it survives the close, as in the host body.
        if (preopen(fd))
            return 0;
        const e = entry(fd);
        if (e.kind === 'resident') {
            fds.delete(fd);
            closeResident(e, fs);
            return 0;
        }
        return after(fs.close(e.handle.id), () => { fds.delete(fd); return 0; });
    }, owns);
    imports.fd_renumber = guard(imports.fd_renumber, (fs, from, to) => {
        const source = fds.get(from);
        if (!source)
            fail('EBADF');
        if (from === to)
            return 0;
        const target = fds.get(to);
        if (target?.kind === 'preopen')
            fail('ENOTCAPABLE');
        // dup2 closes what it lands on, and only the owner of that fd knows how:
        // a socket's stream and a pipe's writer count are the host's to release.
        if (target?.kind === 'resident')
            closeResident(target, fs);
        const released = !target || target.kind === 'resident' ? undefined
            : target.kind === 'authority' ? fs.close(target.handle.id)
                : hostClose?.(to);
        return after(released, () => {
            fds.delete(from);
            fds.set(to, source);
            return 0;
        });
    }, args => owns(args) || owns([args[1]]));
    imports.fd_seek = guard(imports.fd_seek, (fs, fd, offset, whence, out) => {
        const kind = options.abi === 'preview0' ? (whence === 2 ? 'set' : whence === 0 ? 'current' : whence === 1 ? 'end' : null)
            : whence === 0 ? 'set' : whence === 1 ? 'current' : whence === 2 ? 'end' : null;
        if (kind === null)
            fail('EINVAL');
        const e = right(fd, 2);
        if (e.kind === 'resident') {
            const base = kind === 'set' ? 0 : kind === 'current' ? e.position : e.bytes.length;
            const pos = base + num(offset);
            if (pos < 0)
                fail('EINVAL');
            e.position = pos;
            u64(out, pos);
            return 0;
        }
        return after(fs.seek(e.handle.id, num(offset), kind), pos => { u64(out, pos); return 0; });
    }, owns);
    imports.fd_tell = guard(imports.fd_tell, (fs, fd, out) => {
        const e = right(fd, 5);
        if (e.kind === 'resident') {
            u64(out, e.position);
            return 0;
        }
        return after(fs.seek(e.handle.id, 0, 'current'), pos => { u64(out, pos); return 0; });
    }, owns);
    imports.fd_fdstat_get = guard(imports.fd_fdstat_get, (fs, fd, out) => {
        const e = preopen(fd) ?? entry(fd);
        memory().fill(0, out, out + 24);
        view().setUint8(out, e.kind === 'preopen' ? 3 : e.kind === 'resident' ? 4 : ft(e.type));
        view().setUint16(out + 2, e.kind === 'preopen' ? 0 : e.fdflags, true);
        u64(out + 8, e.rights ?? 0x1fffffffn);
        u64(out + 16, e.rightsInheriting ?? 0x1fffffffn);
        return 0;
    }, owns);
    imports.fd_fdstat_set_flags = guard(imports.fd_fdstat_set_flags, (fs, fd, flags) => {
        if (flags & ~5)
            fail('ENOTSUP');
        const e = right(fd, 3);
        if (e.kind === 'resident') {
            e.fdflags = flags;
            return 0;
        }
        return after(fs.setStatus(e.handle.id, { append: !!(flags & 1) }), () => { e.fdflags = flags; return 0; });
    }, owns);
    imports.fd_fdstat_set_rights = guard(imports.fd_fdstat_set_rights, (fs, fd, rights, inheriting) => {
        const e = entry(fd);
        if ((rights & ~e.rights) || (inheriting & ~e.rightsInheriting))
            fail('ENOTCAPABLE');
        e.rights = rights;
        e.rightsInheriting = inheriting;
        return 0;
    }, owns);
    imports.fd_filestat_set_size = guard(imports.fd_filestat_set_size, (fs, fd, size) => { right(fd, 22); return after(fs.ftruncate(handle(fd).handle.id, num(size)), () => 0); }, owns);
    // fsync(2) through this codec's own copy of a file: the copy has nothing
    // to sync, but writes this process holds for the file elsewhere do (a
    // filesystem that holds them answers syncInode; any other has none).
    const syncResident = (fs, st) => {
        const syncInode = Reflect.get(fs, 'syncInode');
        if (typeof syncInode !== 'function')
            return 0;
        return after(Reflect.apply(syncInode, fs, [st.dev, st.ino]), () => 0);
    };
    imports.fd_sync = guard(imports.fd_sync, (fs, fd) => { const e = right(fd, 4); return e.kind === 'resident' ? syncResident(fs, e.stat) : after(fs.fsync(e.handle.id), () => 0); }, owns);
    imports.fd_datasync = guard(imports.fd_datasync, (fs, fd) => { const e = right(fd, 0); return e.kind === 'resident' ? syncResident(fs, e.stat) : after(fs.fsync(e.handle.id), () => 0); }, owns);
    // posix_fallocate(3): the file holds at least [offset, offset + len).
    imports.fd_allocate = guard(imports.fd_allocate, (fs, fd, offset, len) => {
        right(fd, 8);
        const e = handle(fd), end = num(offset) + num(len);
        return after(fs.fstat(e.handle.id), st => st.size >= end ? 0 : after(fs.ftruncate(e.handle.id, end), () => 0));
    }, owns);
    // Advisory only; there is no cache here to steer.
    imports.fd_advise = guard(imports.fd_advise, (fs, fd) => { right(fd, 7); return 0; }, owns);
    imports.fd_readdir = guard(imports.fd_readdir, (fs, fd, buf, size, cookie, used) => {
        pathRight(fd, 14);
        const e = preopen(fd) ?? entry(fd);
        if (e.kind === 'resident')
            fail('ENOTDIR');
        // The filesystem owns the listing's revision/lease, including on a
        // rewind (cookie 0). An unversioned copy here would outlive its recall.
        const list = e.kind === 'preopen' ? fs.readdir(e.vfsPath) : fs.readdirHandle(e.handle.id);
        return after(list, entries => {
            const all = [{ name: '.', type: 'directory' }, { name: '..', type: 'directory' }, ...entries];
            let written = 0;
            for (let i = num(cookie); i < all.length && written < size; i++) {
                const name = encoder.encode(all[i].name), record = new Uint8Array(24 + name.length), dv = new DataView(record.buffer);
                dv.setBigUint64(0, BigInt(i + 1), true);
                dv.setUint32(16, name.length, true);
                dv.setUint8(20, ft(all[i].type));
                record.set(name, 24);
                const n = Math.min(record.length, size - written);
                memory().set(record.subarray(0, n), buf + written);
                written += n;
            }
            u32(used, written);
            return 0;
        });
    }, owns);
    imports.path_create_directory = guard(imports.path_create_directory, (fs, fd, p, n) => { pathRight(fd, 9); return after(fs.mkdir(at(fd, path(p, n)), { recursive: false, ...creationMode(0o777) }), () => 0); });
    imports.path_remove_directory = guard(imports.path_remove_directory, (fs, fd, p, n) => { pathRight(fd, 25); return after(fs.rmdir(at(fd, path(p, n))), () => 0); });
    // A name these processes take away first keeps the file of their copies there (keepCopiesBefore).
    imports.path_unlink_file = guard(imports.path_unlink_file, (fs, fd, p, n) => {
        pathRight(fd, 26);
        const name = at(fd, path(p, n));
        return after(keepCopiesBefore(fs, [name], residentTables()), () => after(fs.unlink(name), () => 0));
    });
    imports.path_rename = guard(imports.path_rename, (fs, from, p, n, to, q, m) => {
        pathRight(from, 16);
        pathRight(to, 17);
        const source = at(from, path(p, n)), target = at(to, path(q, m));
        return after(keepCopiesBefore(fs, [source, target], residentTables()), () => after(fs.rename(source, target), () => 0));
    });
    imports.path_symlink = guard(imports.path_symlink, (fs, p, n, fd, q, m) => { pathRight(fd, 24); return after(fs.symlink(path(p, n), at(fd, path(q, m))), () => 0); });
    imports.path_readlink = guard(imports.path_readlink, (fs, fd, p, n, buf, cap, used) => {
        pathRight(fd, 15);
        return after(fs.readlink(at(fd, path(p, n))), value => {
            if (value === null)
                fail('EINVAL');
            const data = encoder.encode(value), count = Math.min(cap, data.length);
            memory().set(data.subarray(0, count), buf);
            u32(used, count);
            return 0;
        });
    });
    // The filesystem has no hard links; link(2) degrades to a second file with
    // the same bytes, as it always has here.
    imports.path_link = guard(imports.path_link, (fs, from, flags, p, n, to, q, m) => {
        pathRight(from, 11);
        pathRight(to, 12);
        const source = at(from, path(p, n)), target = at(to, path(q, m));
        return after(fs.stat(source, { followSymlinks: !!(flags & 1) }), st => {
            if (st === null)
                fail('ENOENT');
            if (st.type === 'directory')
                fail('EPERM');
            return after(fs.stat(target, { followSymlinks: false }), existing => {
                if (existing !== null)
                    fail('EEXIST');
                return after(fs.copyFile(source, target), () => 0);
            });
        });
    });
    // Each time as utimes takes it, its intent kept for the judgment: now
    // (null: a writer may), explicit ms (the owner), or kept (undefined).
    const times = (a, m, flags) => {
        if ((flags & 3) === 3 || (flags & 12) === 12 || flags & ~15)
            fail('EINVAL');
        return [flags & 2 ? null : flags & 1 ? Number(a / 1000000n) : undefined,
            flags & 8 ? null : flags & 4 ? Number(m / 1000000n) : undefined];
    };
    imports.fd_filestat_set_times = guard(imports.fd_filestat_set_times, (fs, fd, a, m, flags) => {
        right(fd, 23);
        return after(fs.futimes(handle(fd).handle.id, ...times(a, m, flags)), () => 0);
    }, owns);
    const ext = options.extension;
    if (ext) {
        ext.fd_stat = guard(ext.fd_stat, (fs, fd, out) => { pathRight(fd, 21); return after(stat(fs, fd), st => writeNimbusStat(out, st)); }, owns);
        const descriptorNimbusStat = ext.fd_stat;
        ext.path_stat = guard(ext.path_stat, (fs, fd, flags, p, n, out) => {
            pathRight(fd, 18);
            const name = path(p, n);
            const descriptor = named(fd, name);
            if (descriptor !== null)
                return descriptorNimbusStat(descriptor, out);
            return after(fs.stat(at(fd, name), { followSymlinks: !!(flags & 1) }), st => writeNimbusStat(out, st ?? fail('ENOENT')));
        });
        ext.path_chmod = guard(ext.path_chmod, (fs, fd, flags, p, n, mode) => {
            pathRight(fd, 20);
            if (!(flags & 1))
                fail('ENOTSUP');
            return after(fs.chmod(at(fd, path(p, n)), mode & 0o7777), () => 0);
        });
        ext.path_access = guard(ext.path_access, (fs, fd, flags, p, n, mode) => {
            pathRight(fd, 18);
            // Linux's faccessat has no AT_SYMLINK_NOFOLLOW check of a link's own bits: it follows.
            void flags;
            return after(fs.access(at(fd, path(p, n)), mode & 7), () => 0);
        });
        // A read-only copy (a resident descriptor) has no descriptor on the
        // authority to change it through.
        ext.fd_chmod = guard(ext.fd_chmod, (fs, fd, mode) => {
            right(fd, 21);
            return after(fs.fchmod(handle(fd).handle.id, mode & 0o7777), () => 0);
        }, owns);
    }
    imports.path_filestat_set_times = guard(imports.path_filestat_set_times, (fs, fd, lookup, p, n, a, m, flags) => {
        pathRight(fd, 20);
        const target = at(fd, path(p, n)), followSymlinks = !!(lookup & 1);
        return after(fs.stat(target, { followSymlinks }), st => { if (st === null)
            fail('ENOENT'); return after(fs.utimes(target, ...times(a, m, flags), { followSymlinks }), () => 0); });
    });
}
