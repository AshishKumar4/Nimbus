import { VfsError } from './vfs-error.js';
const S_IFCHR = 0o020000;
const DEV_MODE = S_IFCHR | 0o666;
/** Largest buffer one read produces; fewer bytes than asked is ordinary read(2). */
const MAX_DEVICE_READ = 1024 * 1024;
/** crypto.getRandomValues refuses more than this at once. */
const RANDOM_FILL_CHUNK = 65536;
const discard = () => { };
const zeros = () => { }; // a Uint8Array is born zeroed
function fillRandom(out) {
    for (let i = 0; i < out.length; i += RANDOM_FILL_CHUNK) {
        crypto.getRandomValues(out.subarray(i, Math.min(out.length, i + RANDOM_FILL_CHUNK)));
    }
}
const DEVICES = new Map([
    ['null', { unbounded: false, write: discard }],
    ['zero', { unbounded: true, fill: zeros, write: discard }],
    ['full', { unbounded: true, fill: zeros, write: (path) => { throw new VfsError('ENOSPC', 'no space left on device', path); } }],
    ['random', { unbounded: true, fill: fillRandom, write: discard }],
    ['urandom', { unbounded: true, fill: fillRandom, write: discard }],
    ['stdin', { unbounded: false, write: discard }],
    ['stdout', { unbounded: false, write: discard }],
    ['stderr', { unbounded: false, write: discard }],
    ['tty', { unbounded: false, write: discard }],
]);
function name(path) {
    return path.split('/').filter((s) => s !== '' && s !== '.').join('/');
}
export class DevVFS {
    sync = this;
    node(path) {
        const found = DEVICES.get(name(path));
        if (found === undefined)
            throw new VfsError('ENOENT', 'no such device', path);
        return found;
    }
    stat(path) {
        const n = name(path);
        if (n === '')
            return { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40755, uid: 0, gid: 0 };
        return DEVICES.has(n) ? { type: 'file', size: 0, mtimeMs: 0, mode: DEV_MODE, uid: 0, gid: 0 } : null;
    }
    readFile(path) {
        if (name(path) === '')
            throw new VfsError('EISDIR', 'is a directory', path);
        if (this.node(path).unbounded) {
            throw new VfsError('EINVAL', 'this device produces bytes without end; read a bounded slice (head -c N, dd count=N)', path);
        }
        return new Uint8Array(0);
    }
    readRange(path, _offset, length) {
        const node = this.node(path);
        if (node.fill === undefined)
            return new Uint8Array(0);
        const out = new Uint8Array(Math.min(length, MAX_DEVICE_READ));
        node.fill(out);
        return out;
    }
    writeFile(path) {
        this.node(path).write(path);
    }
    writeRange(path) {
        this.node(path).write(path);
    }
    /** A device has no length to set; the node must exist. */
    truncate(path) {
        this.node(path);
    }
    readdir(path) {
        if (name(path) !== '') {
            this.node(path);
            throw new VfsError('ENOTDIR', 'not a directory', path);
        }
        return [...DEVICES.keys()].map((device) => ({ name: device, type: 'file' }));
    }
    mkdir(path) {
        throw new VfsError('EPERM', 'devices are not created here', path);
    }
    unlink(path) {
        this.node(path);
        throw new VfsError('EPERM', 'a device node cannot be removed', path);
    }
    rmdir(path) {
        throw new VfsError(name(path) === '' ? 'EBUSY' : 'ENOTDIR', name(path) === '' ? 'the device directory' : 'not a directory', path);
    }
    describe() {
        return { source: 'devtmpfs', type: 'devtmpfs', options: ['rw'] };
    }
}
