import { VFSError, ErrorCode, S_IFCHR, S_IFDIR } from '../types.js';
/**
 * DevProvider — the character devices mounted at `/dev`.
 *
 * Device nodes are not files with contents; they are byte sources and sinks.
 * That distinction is carried by two things and nothing else:
 *
 *   - `stat().mode` sets `S_IFCHR`, so `ls -l` renders `crw-rw-rw-` and tools
 *     can tell a device from a regular file. Size is 0, as on real Unix.
 *   - `readRange()` generates the requested bytes on demand, so a device has
 *     no content ceiling — the caller's bound is the only bound.
 *
 * `readFile()` is a whole-file read with no bound. On a device that produces
 * bytes forever that request cannot be answered, so it fails loudly instead
 * of silently handing back an arbitrary prefix. Bounded readers (`head -c N`,
 * `dd count=N`, shell redirections) go through `readRange` and work.
 */
const DEV_MODE = S_IFCHR | 0o666;
const DIR_MODE = S_IFDIR | 0o755;
/**
 * Largest buffer a single `readRange` will materialise. Returning fewer bytes
 * than asked for is ordinary read(2) behaviour, so callers already loop; this
 * just keeps one call from allocating an unbounded buffer.
 */
const MAX_DEVICE_READ = 1024 * 1024;
/** `crypto.getRandomValues` rejects requests larger than this. */
const RANDOM_FILL_CHUNK = 65536;
const discard = () => { };
function fillRandom(out) {
    for (let i = 0; i < out.length; i += RANDOM_FILL_CHUNK) {
        crypto.getRandomValues(out.subarray(i, Math.min(out.length, i + RANDOM_FILL_CHUNK)));
    }
}
// Uint8Array is born zeroed, so /dev/zero and /dev/full need no fill body —
// they only need to declare that they produce bytes forever.
const zeros = () => { };
const DEVICES = new Map([
    ['null', { unbounded: false, write: discard }],
    ['zero', { unbounded: true, fill: zeros, write: discard }],
    ['full', {
            unbounded: true,
            fill: zeros,
            write: () => { throw new VFSError(ErrorCode.EINVAL, 'ENOSPC: no space left on device'); },
        }],
    ['random', { unbounded: true, fill: fillRandom, write: discard }],
    ['urandom', { unbounded: true, fill: fillRandom, write: discard }],
    // The standard-stream nodes exist so `test -e` and `ls` see them. The shell
    // resolves `/dev/stdin`, `/dev/stdout` and `/dev/stderr` to the invoking
    // process's own descriptors before a redirection ever reaches this provider.
    ['stdin', { unbounded: false, write: discard }],
    ['stdout', { unbounded: false, write: discard }],
    ['stderr', { unbounded: false, write: discard }],
    ['tty', { unbounded: false, write: discard }],
]);
export class DevProvider {
    norm(subpath) {
        return subpath.replace(/^\/+/, '').replace(/\/+$/, '');
    }
    node(subpath) {
        const name = this.norm(subpath);
        const node = DEVICES.get(name);
        if (!node)
            throw new VFSError(ErrorCode.ENOENT, `'/dev/${name}': no such device`);
        return node;
    }
    readFile(subpath) {
        if (this.norm(subpath) === '') {
            throw new VFSError(ErrorCode.EISDIR, `'/dev': is a directory`);
        }
        const node = this.node(subpath);
        if (node.unbounded) {
            throw new VFSError(ErrorCode.EINVAL, `'/dev/${this.norm(subpath)}': character device produces bytes without end — read a bounded slice (head -c N, dd count=N)`);
        }
        return new Uint8Array(0);
    }
    readFileString(subpath) {
        return new TextDecoder().decode(this.readFile(subpath));
    }
    readRange(subpath, _offset, length) {
        const node = this.node(subpath);
        if (!node.fill)
            return new Uint8Array(0);
        const out = new Uint8Array(Math.min(length, MAX_DEVICE_READ));
        node.fill(out);
        return out;
    }
    writeFile(subpath, content) {
        const node = this.node(subpath);
        node.write(typeof content === 'string' ? new TextEncoder().encode(content) : content);
    }
    writeRange(subpath, _offset, bytes) {
        this.node(subpath).write(bytes);
    }
    truncate(subpath, _size) {
        // Devices have no length to set; the node must still exist.
        this.node(subpath);
    }
    exists(subpath) {
        const name = this.norm(subpath);
        return name === '' || DEVICES.has(name);
    }
    stat(subpath) {
        const name = this.norm(subpath);
        if (name === '') {
            return { type: 'directory', size: DEVICES.size, ctime: 0, mtime: 0, mode: DIR_MODE };
        }
        this.node(subpath);
        return { type: 'file', size: 0, ctime: 0, mtime: 0, mode: DEV_MODE };
    }
    readdir(subpath) {
        const name = this.norm(subpath);
        if (name !== '') {
            this.node(subpath);
            throw new VFSError(ErrorCode.ENOTDIR, `'/dev/${name}': not a directory`);
        }
        return [...DEVICES.keys()].map((device) => ({ name: device, type: 'file' }));
    }
    unlink(subpath) {
        this.node(subpath);
        throw new VFSError(ErrorCode.EINVAL, `'/dev/${this.norm(subpath)}': operation not permitted`);
    }
    mkdir(subpath) {
        throw new VFSError(ErrorCode.EINVAL, `'/dev/${this.norm(subpath)}': read-only filesystem`);
    }
    rmdir(subpath) {
        throw new VFSError(ErrorCode.EINVAL, `'/dev/${this.norm(subpath)}': read-only filesystem`);
    }
    rename(oldSubpath) {
        throw new VFSError(ErrorCode.EINVAL, `'/dev/${this.norm(oldSubpath)}': read-only filesystem`);
    }
    copyFile(srcSubpath) {
        throw new VFSError(ErrorCode.EINVAL, `'/dev/${this.norm(srcSubpath)}': read-only filesystem`);
    }
    isDirectory(subpath) {
        return this.norm(subpath) === '';
    }
}
