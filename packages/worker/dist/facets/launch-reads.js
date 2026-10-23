const nameOf = (path) => path.replace(/^\/+/, '').replace(/\/+$/, '');
/** `bridge`, passed through, noting what each call asks about (see the header). */
export function recordLaunchReads(bridge) {
    const paths = new Set();
    const listed = new Set();
    let whole = false;
    const read = (path) => {
        if (typeof path === 'string')
            paths.add(nameOf(path));
        else
            whole = true;
    };
    const list = (path) => {
        if (typeof path === 'string') {
            paths.add(nameOf(path));
            listed.add(nameOf(path));
        }
        else {
            whole = true;
        }
    };
    /** A call whose answer this module cannot attribute to a name: the build depends on everything. */
    const everything = () => { whole = true; };
    const view = {
        ...(bridge.gateLaunch !== undefined ? { gateLaunch: (...args) => bridge.gateLaunch(...args) } : {}),
        stat: (...args) => { read(args[0]); return bridge.stat(...args); },
        readFile: (...args) => { read(args[0]); return bridge.readFile(...args); },
        writeFile: (...args) => { everything(); return bridge.writeFile(...args); },
        writeFileFrom: (...args) => { everything(); return bridge.writeFileFrom(...args); },
        readRange: (...args) => { read(args[0]); return bridge.readRange(...args); },
        writeRange: (...args) => { everything(); return bridge.writeRange(...args); },
        truncate: (...args) => { everything(); return bridge.truncate(...args); },
        utimes: (...args) => { everything(); return bridge.utimes(...args); },
        chmod: (...args) => { everything(); return bridge.chmod(...args); },
        access: (...args) => { read(args[0]); return bridge.access(...args); },
        chown: (...args) => { everything(); return bridge.chown(...args); },
        // A descriptor reads, or lists, what it was opened on.
        open: (...args) => { list(args[0]); return bridge.open(...args); },
        reopen: (...args) => { everything(); return bridge.reopen(...args); },
        read: (...args) => bridge.read(...args),
        write: (...args) => { everything(); return bridge.write(...args); },
        close: (...args) => bridge.close(...args),
        readdir: (...args) => { list(args[0]); return bridge.readdir(...args); },
        mkdir: (...args) => { everything(); return bridge.mkdir(...args); },
        unlink: (...args) => { everything(); return bridge.unlink(...args); },
        rmdir: (...args) => { everything(); return bridge.rmdir(...args); },
        rename: (...args) => { everything(); return bridge.rename(...args); },
        readlink: (...args) => { read(args[0]); return bridge.readlink(...args); },
        linkLeadsTo: (...args) => { read(args[0]); read(args[1]); return bridge.linkLeadsTo(...args); },
        symlink: (...args) => { everything(); return bridge.symlink(...args); },
        fsync: (...args) => bridge.fsync(...args),
        revision: (...args) => { if (args[0] === undefined)
            everything();
        else
            read(args[0]); return bridge.revision(...args); },
        ...(bridge.contentKey !== undefined ? { contentKey: (...args) => { read(args[0]); return bridge.contentKey(...args); } } : {}),
        acquire: (...args) => bridge.acquire(...args),
        list: (...args) => { everything(); return bridge.list(...args); },
        ...(bridge.subscribe !== undefined ? { subscribe: (...args) => { read(args[0]); return bridge.subscribe(...args); } } : {}),
        // Resolving a path reads each name on the way to it, which the ancestor rule covers.
        realpath: (...args) => { read(args[0]); return bridge.realpath(...args); },
        remove: (...args) => { everything(); return bridge.remove(...args); },
        copyFile: (...args) => { everything(); return bridge.copyFile(...args); },
        copyTree: (...args) => { everything(); return bridge.copyTree(...args); },
        fstat: (...args) => bridge.fstat(...args),
        dup: (...args) => bridge.dup(...args),
        seek: (...args) => bridge.seek(...args),
        setStatus: (...args) => bridge.setStatus(...args),
        readdirHandle: (...args) => bridge.readdirHandle(...args),
        ftruncate: (...args) => { everything(); return bridge.ftruncate(...args); },
        fchmod: (...args) => { everything(); return bridge.fchmod(...args); },
        fchown: (...args) => { everything(); return bridge.fchown(...args); },
        futimes: (...args) => { everything(); return bridge.futimes(...args); },
        writeBatch: (...args) => { everything(); return bridge.writeBatch(...args); },
        writeStream: (...args) => { everything(); return bridge.writeStream(...args); },
        acquireExclusiveMutation: (...args) => { everything(); return bridge.acquireExclusiveMutation(...args); },
        releaseExclusiveMutation: (...args) => bridge.releaseExclusiveMutation(...args),
        awaitRecall: (...args) => bridge.awaitRecall(...args),
        recalled: (...args) => bridge.recalled(...args),
        published: (...args) => bridge.published(...args),
    };
    return { view, reads: () => ({ paths: new Set(paths), listed: new Set(listed), whole }) };
}
/**
 * Whether the build asked about a name under one of `mountPoints` (a mount
 * other than the session's own store). A mounted backend's files change
 * where the session's barrier may not see them, so such a build serves only
 * while nothing at all has changed, as every build did before this module.
 */
export function readsUnderMounts(reads, mountPoints) {
    const points = mountPoints.map(nameOf).filter((point) => point !== '');
    if (points.length === 0)
        return false;
    return [...reads.paths, ...reads.listed].some((name) => points.some((point) => name === point || name.startsWith(point + '/')));
}
/** Each directory above `name`, nearest first. */
function ancestorsOf(name) {
    const out = [];
    for (let at = name.lastIndexOf('/'); at > 0; at = name.lastIndexOf('/', at - 1))
        out.push(name.slice(0, at));
    // The root is above every name.
    out.push('');
    return out;
}
/** Whether any of `changes` (a barrier's report since the build's cursor) can change what a build that asked `reads` answers. */
export function readsAffectedBy(reads, changes) {
    if (reads.whole)
        return changes.length > 0;
    if (changes.length === 0)
        return false;
    // Every directory above a name the build asked about: a change there moves what is under it.
    const above = new Set();
    for (const name of [...reads.paths, ...reads.listed])
        for (const ancestor of ancestorsOf(name))
            above.add(ancestor);
    for (const change of changes) {
        const name = nameOf(change.path);
        if (reads.paths.has(name) || reads.listed.has(name) || above.has(name))
            return true;
        // A name made or removed in a directory the build listed.
        const parent = name.lastIndexOf('/') === -1 ? '' : name.slice(0, name.lastIndexOf('/'));
        if (reads.listed.has(parent))
            return true;
    }
    return false;
}
