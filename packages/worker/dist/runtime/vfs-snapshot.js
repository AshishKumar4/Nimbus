export function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
export function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
/**
 * Snapshot a VFS subtree into a JSON-serializable WASI-shaped filesystem.
 *
 * The snapshot is intentionally bounded. Runtimes that need incremental or
 * lazy file IO should add a streaming bridge; a single request payload is the
 * right primitive only for normal source trees and small app state.
 */
export function snapshotVfs(vfs, vfsRoot, caps = {}) {
    const maxBytes = caps.maxBytes ?? 32 * 1024 * 1024;
    const maxFiles = caps.maxFiles ?? 5000;
    const skipSubdirs = new Set(caps.skipSubdirs ?? ['.nimbus', 'node_modules', '.cache', '.npm']);
    const root = vfsRoot.replace(/^\/+/, '').replace(/\/+$/, '');
    const roots = Array.from(new Set([
        root,
        ...Array.from(caps.extraRoots ?? []).map((r) => r.replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean),
    ].filter(Boolean)));
    const files = {};
    const dirsSet = new Set();
    let totalBytes = 0;
    let fileCount = 0;
    const stack = [];
    const failures = [];
    const addDirWithParents = (path) => {
        const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
        if (!clean)
            return;
        const parts = clean.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
            dirsSet.add(parts.slice(0, i).join('/'));
        }
    };
    for (const start of roots) {
        addDirWithParents(start);
        if (vfs.exists(start))
            stack.push(start);
    }
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = vfs.readdir(dir);
        }
        catch (error) {
            failures.push(`readdir ${dir}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        for (const entry of entries) {
            const childPath = `${dir}/${entry.name}`;
            if (entry.type === 'directory') {
                if (skipSubdirs.has(entry.name))
                    continue;
                addDirWithParents(childPath);
                stack.push(childPath);
                continue;
            }
            let bytes;
            try {
                bytes = vfs.readFile(childPath);
            }
            catch (error) {
                failures.push(`readFile ${childPath}: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            totalBytes += bytes.length;
            fileCount++;
            if (totalBytes > maxBytes) {
                return { error: `runtime filesystem snapshot exceeded ${(maxBytes / 1024 / 1024).toFixed(0)} MiB cap (current dir: ${dir})` };
            }
            if (fileCount > maxFiles) {
                return { error: `runtime filesystem snapshot exceeded ${maxFiles} file cap` };
            }
            addDirWithParents(dir);
            files[childPath] = bytesToB64(bytes);
        }
    }
    if (failures.length > 0) {
        return { error: `runtime filesystem snapshot incomplete: ${failures.join('; ')}` };
    }
    return { snapshot: { root, roots, preopens: [], files, dirs: Array.from(dirsSet).sort() }, bytes: totalBytes, files: fileCount };
}
/**
 * Apply a runtime-produced filesystem diff back into the supervisor VFS.
 * Operations are independent so one bad path never loses the rest of a run.
 */
export function flushVfsDiff(vfs, diff) {
    let written = 0;
    let deleted = 0;
    let mkdirs = 0;
    let rmdirs = 0;
    let timesTouched = 0;
    let symlinks = 0;
    for (const path of diff.dirsCreated) {
        try {
            vfs.mkdir(path, { recursive: true });
            mkdirs++;
        }
        catch { }
    }
    for (const [path, b64] of Object.entries(diff.filesWritten)) {
        try {
            const lastSlash = path.lastIndexOf('/');
            if (lastSlash > 0) {
                try {
                    vfs.mkdir(path.substring(0, lastSlash), { recursive: true });
                }
                catch { }
            }
            vfs.writeFile(path, b64ToBytes(b64));
            written++;
        }
        catch { }
    }
    for (const path of diff.filesDeleted) {
        try {
            vfs.unlink(path);
            deleted++;
        }
        catch { }
    }
    for (const path of diff.dirsDeleted) {
        try {
            vfs.rmdir(path);
            rmdirs++;
        }
        catch { }
    }
    if (diff.timesChanged)
        timesTouched = Object.keys(diff.timesChanged).length;
    if (diff.symlinksCreated)
        symlinks = Object.keys(diff.symlinksCreated).length;
    if (diff.symlinksDeleted)
        symlinks += diff.symlinksDeleted.length;
    return { written, deleted, mkdirs, rmdirs, timesTouched, symlinks };
}
