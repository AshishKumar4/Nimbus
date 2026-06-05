/**
 * dev-provider.ts — virtual /dev provider.
 *
 * shell compatibility (2026-05-11): pre-fix `cmd > /dev/null` and
 * `cmd 2>/dev/null` returned `ENOENT: '/dev': no such file or
 * directory` because /dev wasn't mounted. Standard Unix idioms
 * (`make 2>/dev/null`, `cmd > /dev/null 2>&1`, scripts piping
 * to /dev/null) all failed.
 *
 * This provider implements the standard device-file subset:
 *
 *   /dev/null    — write: discard; read: EOF (empty)
 *   /dev/zero    — write: discard; read: infinite zeros (capped per read)
 *   /dev/random  — write: discard; read: crypto.getRandomValues()
 *   /dev/urandom — alias of /dev/random
 *   /dev/stdin   — passthrough placeholder (not really useful here)
 *   /dev/stdout  — passthrough placeholder
 *   /dev/stderr  — passthrough placeholder
 *   /dev/full    — write: ENOSPC; read: infinite zeros
 *
 * The provider is mounted at `/dev` (no leading slash for Kernel
 * convention which already does that). All entries are virtual:
 * stat returns synthesized FileType-shaped objects. The MountProvider
 * surface lifo-sh expects (readFile/writeFile/exists/stat/readdir/
 * unlink/mkdir/rmdir/rename/copyFile) is fully implemented — reads
 * from non-existent dev nodes return ENOENT, writes to read-only
 * nodes silently succeed (Unix /dev/null/zero/random semantics).
 */
const enc = new TextEncoder();
function makeNode(opts) {
    const now = Date.now();
    return {
        type: opts.type,
        size: opts.size ?? 0,
        mtime: opts.mtime ?? now,
        mode: opts.mode ?? (opts.type === 'directory' ? 0o755 : 0o666),
        read: opts.read ?? (() => new Uint8Array(0)),
        write: opts.write ?? (() => { }),
    };
}
// Cap any single read of /dev/zero or /dev/random to prevent OOM
// on `dd if=/dev/zero ... count=∞`. Real Unix lets you read forever;
// our model is sync + bounded, so we cap reads. 64 KiB is generous
// for any reasonable test/script.
const DEV_READ_CAP = 64 * 1024;
function makeNodes() {
    const nodes = new Map();
    nodes.set('', makeNode({ type: 'directory' }));
    nodes.set('null', makeNode({
        type: 'file',
        read: () => new Uint8Array(0),
        write: () => { },
    }));
    nodes.set('zero', makeNode({
        type: 'file',
        read: () => new Uint8Array(DEV_READ_CAP),
        write: () => { },
    }));
    nodes.set('random', makeNode({
        type: 'file',
        read: () => {
            const buf = new Uint8Array(DEV_READ_CAP);
            try {
                crypto.getRandomValues(buf);
            }
            catch { /* runtime without crypto — return zeros */ }
            return buf;
        },
        write: () => { },
    }));
    nodes.set('urandom', makeNode({
        type: 'file',
        read: () => {
            const buf = new Uint8Array(DEV_READ_CAP);
            try {
                crypto.getRandomValues(buf);
            }
            catch { /* fallthrough */ }
            return buf;
        },
        write: () => { },
    }));
    nodes.set('full', makeNode({
        type: 'file',
        read: () => new Uint8Array(DEV_READ_CAP),
        write: () => { throw new Error('ENOSPC: no space left on device'); },
    }));
    nodes.set('stdin', makeNode({ type: 'file' }));
    nodes.set('stdout', makeNode({ type: 'file' }));
    nodes.set('stderr', makeNode({ type: 'file' }));
    nodes.set('tty', makeNode({ type: 'file' }));
    return nodes;
}
/**
 * MountProvider impl for /dev. lifo-sh's Kernel routes any path
 * under /dev/* through these methods.
 */
export class DevProvider {
    nodes;
    constructor() {
        this.nodes = makeNodes();
    }
    /** Normalize "/foo" or "foo" to "foo". Kernel passes either shape
     *  depending on call site; defensive normalization. */
    norm(sub) {
        return sub.replace(/^\/+/, '').replace(/\/+$/, '');
    }
    // ── MountProvider surface ──
    readFile(sub) {
        const n = this.norm(sub);
        const node = this.nodes.get(n);
        if (!node)
            throw new Error(`ENOENT: '/dev/${n}': no such file or directory`);
        if (node.type === 'directory')
            throw new Error(`EISDIR: '/dev/${n}': is a directory`);
        return node.read();
    }
    readFileString(sub) {
        return new TextDecoder('utf-8').decode(this.readFile(sub));
    }
    writeFile(sub, content) {
        const n = this.norm(sub);
        let node = this.nodes.get(n);
        if (!node) {
            // Creating new files under /dev is not supported (real Unix
            // allows it as root; we don't). Silently discard the data —
            // matches /dev/null semantics for anything written here.
            return;
        }
        if (node.type === 'directory')
            throw new Error(`EISDIR: '/dev/${n}': is a directory`);
        const bytes = typeof content === 'string' ? enc.encode(content) : content;
        node.write(bytes);
    }
    exists(sub) {
        return this.nodes.has(this.norm(sub));
    }
    stat(sub) {
        const n = this.norm(sub);
        const node = this.nodes.get(n);
        if (!node)
            throw new Error(`ENOENT: '/dev/${n}': no such file or directory`);
        return {
            type: node.type,
            size: node.size,
            mtime: node.mtime,
            ctime: node.mtime,
            mode: node.mode,
        };
    }
    readdir(sub) {
        const n = this.norm(sub);
        if (n !== '') {
            const node = this.nodes.get(n);
            if (!node)
                throw new Error(`ENOENT: '/dev/${n}': no such file or directory`);
            if (node.type !== 'directory')
                throw new Error(`ENOTDIR: '/dev/${n}': not a directory`);
            return [];
        }
        const results = [];
        for (const [name, node] of this.nodes) {
            if (name === '')
                continue;
            results.push({ name, type: node.type });
        }
        return results;
    }
    unlink(sub) {
        // Real /dev nodes can't be removed by user code. Silently no-op
        // (errors here break `rm -rf X && touch X` idioms).
    }
    mkdir(_sub, _opts) {
        // No-op; /dev is read-only.
    }
    rmdir(_sub) { }
    rename(_o, _n) {
        throw new Error('EROFS: read-only filesystem');
    }
    copyFile(_s, _d) {
        throw new Error('EROFS: read-only filesystem');
    }
    appendFile(_sub, _content) {
        // Append to /dev/null = discard
    }
    // Optional methods that some MountProvider consumers expect.
    isDirectory(sub) {
        const node = this.nodes.get(this.norm(sub));
        return !!node && node.type === 'directory';
    }
}
