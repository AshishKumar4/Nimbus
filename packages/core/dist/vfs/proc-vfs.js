/**
 * /proc: files generated when read, for the principal reading them.
 *
 * Synchronous and read-only. A file is a generator from the reading
 * principal's credential to text; `register` adds or replaces one, and
 * `name` may be nested (`net/info`), which makes its directories.
 *
 * Its tree changes only by `register`, so its feed is an immutable one
 * (immutable-changes.ts): a reader that listed it is current until a file
 * is registered. A file is constant for the tree (the trust store, the
 * CPUs, the version), its stat its content's size; or volatile (`register`
 * with `volatile`: the heap, the clock, the network), its stat size 0, as
 * Linux procfs says, and its content made at each read by whoever reads it.
 * Every stat's mtime is the tree's: when it was made, or last registered to.
 */
import { CA_CERTIFICATES_PEM } from './ca-certificates.generated.js';
import { immutableChanges } from './immutable-changes.js';
import { PROC_FILES } from './proc-files.js';
import { syscallError } from './vfs-error.js';
import { posixAccess } from './posix-access.js';
const enc = new TextEncoder();
/** A directory's and a file's mode and owner: what their stats say and their access asks. */
const DIRECTORY = { mode: 0o40555, uid: 0, gid: 0, type: 'directory' };
const FILE = { mode: 0o100444, uid: 0, gid: 0, type: 'file' };
const DIR = { size: 0, mtimeMs: 0, ...DIRECTORY };
function key(path) {
    return path.split('/').filter((s) => s !== '' && s !== '.').join('/');
}
export class ProcVFS {
    tree;
    cred;
    sync;
    changes;
    constructor(tree = { files: new Map(), volatile: new Set(), version: 0, mtimeMs: Date.now() }, cred = null) {
        this.tree = tree;
        this.cred = cred;
        this.sync = this;
        this.changes = immutableChanges(this, () => tree.version);
    }
    get files() { return this.tree.files; }
    /** Add or replace `/proc/<name>`; `volatile`: its content is made at each read (size 0). */
    register(name, generator, volatile = false) {
        const k = key(name);
        this.files.set(k, generator);
        if (volatile)
            this.tree.volatile.add(k);
        else
            this.tree.volatile.delete(k);
        this.tree.version++;
        this.tree.mtimeMs = Date.now();
    }
    /** The same files, generated for `cred`. */
    as(cred) {
        return new ProcVFS(this.tree, cred);
    }
    isDir(k) {
        if (k === '')
            return true;
        for (const name of this.files.keys())
            if (name.startsWith(`${k}/`))
                return true;
        return false;
    }
    /** The file's content: text made for this read, or bytes shared with every read, which are not the caller's to change. */
    generate(path) {
        const k = key(path);
        const generator = this.files.get(k);
        if (generator === undefined)
            throw syscallError(this.isDir(k) ? 'EISDIR' : 'ENOENT', 'open', path);
        return generator(this.cred);
    }
    stat(path) {
        const k = key(path);
        if (this.isDir(k))
            return { ...DIR, mtimeMs: this.tree.mtimeMs };
        if (!this.files.has(k))
            return null;
        if (this.tree.volatile.has(k))
            return { size: 0, mtimeMs: this.tree.mtimeMs, ...FILE };
        const content = this.generate(path);
        return { size: typeof content === 'string' ? enc.encode(content).length : content.length, mtimeMs: this.tree.mtimeMs, ...FILE };
    }
    readFile(path) {
        const content = this.generate(path);
        // Shared bytes are copied, so no reader changes them for the next.
        return typeof content === 'string' ? enc.encode(content) : content.slice();
    }
    /** Its files are root's, 0444, its directories 0555: a credential asks them by their mode (the embedder's view is not judged). */
    access(path, mode) {
        const k = key(path);
        const entry = this.isDir(k) ? DIRECTORY : this.files.has(k) ? FILE : null;
        if (entry === null)
            throw syscallError('ENOENT', 'open', path);
        if (this.cred !== null && !posixAccess(entry, mode, this.cred))
            throw syscallError('EACCES', 'open', path);
    }
    readRange(path, offset, length) {
        const content = this.generate(path);
        return (typeof content === 'string' ? enc.encode(content) : content).slice(offset, offset + length);
    }
    readdir(path) {
        const k = key(path);
        if (!this.isDir(k))
            throw syscallError(this.files.has(k) ? 'ENOTDIR' : 'ENOENT', 'scandir', path);
        const prefix = k === '' ? '' : `${k}/`;
        const out = new Map();
        for (const name of this.files.keys()) {
            if (!name.startsWith(prefix))
                continue;
            const rest = name.slice(prefix.length);
            const slash = rest.indexOf('/');
            const child = slash < 0 ? rest : rest.slice(0, slash);
            if (!out.has(child))
                out.set(child, { name: child, type: slash < 0 ? 'file' : 'directory' });
        }
        return [...out.values()];
    }
    readOnly(syscall, path) {
        throw syscallError('EROFS', syscall, path, { detail: '/proc is read-only' });
    }
    writeFile(path) { this.readOnly('open', path); }
    mkdir(path) { this.readOnly('mkdir', path); }
    unlink(path) { this.readOnly('unlink', path); }
    rmdir(path) { this.readOnly('rmdir', path); }
    describe() {
        return { source: 'proc', type: 'proc', options: ['ro'] };
    }
}
/**
 * The trust store: the TLS roots this build serves (Mozilla's, pinned by
 * scripts/update-ca-certificates.mjs). Generated here rather than kept in a
 * session, so every session trusts what the deployed Nimbus trusts, and a
 * root Mozilla distrusts leaves every session with the next deploy (a copy
 * staged in a session would keep it). CPython's and Ruby's OpenSSL read it
 * through SSL_CERT_FILE (interpreter-env.ts): their default paths are their
 * build machine's.
 */
export const CA_CERTIFICATES_FILE = '/proc/nimbus/ca-certificates.crt';
/** Its bytes, encoded once per isolate: CPython reads the file for every TLS connection it makes. */
const CA_CERTIFICATES = enc.encode(CA_CERTIFICATES_PEM);
/**
 * The /proc every workspace has: cpuinfo, meminfo, uptime, version,
 * net/info and the trust store. ProcessFiles adds `mounts`, and a host adds
 * its own with `register`.
 */
export function standardProc() {
    const proc = new ProcVFS();
    for (const [name, { generate, volatile }] of Object.entries(PROC_FILES))
        proc.register(name, generate, volatile);
    proc.register(CA_CERTIFICATES_FILE.slice('/proc/'.length), () => CA_CERTIFICATES);
    return proc;
}
