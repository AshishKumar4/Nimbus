const nameOf = (path) => path.replace(/^\/+/, '').replace(/\/+$/, '');
/** `bridge`, passed through, noting what each call asks about (see the header). */
export function recordLaunchReads(bridge) {
    const paths = new Set();
    const listed = new Map();
    const absent = new Set();
    let whole = false;
    const read = (path) => {
        if (typeof path === 'string')
            paths.add(nameOf(path));
        else
            whole = true;
    };
    /** `answer` to a question about `path`, noting the path absent when it answers null or fails. */
    const found = (path, answer) => {
        read(path);
        const missing = () => { if (typeof path === 'string')
            absent.add(nameOf(path)); };
        let value;
        try {
            value = answer();
        }
        catch (error) {
            missing();
            throw error;
        }
        if (!(value instanceof Promise)) {
            if (value === null)
                missing();
            return value;
        }
        return value.then((settled) => {
            if (settled === null)
                missing();
            return settled;
        }, (error) => {
            missing();
            throw error;
        });
    };
    /** A listing of `path`, noted with what it answered. */
    const list = (path, answer) => {
        if (typeof path !== 'string') {
            whole = true;
            return answer();
        }
        const name = nameOf(path);
        const note = (entries) => {
            listed.set(name, new Map(entries.map((entry) => [entry.name, entry.type])));
            return entries;
        };
        listed.set(name, null);
        return found(path, () => {
            const entries = answer();
            return entries instanceof Promise ? entries.then(note) : note(entries);
        });
    };
    /** A descriptor opened on `path`: it may read or list it. */
    const opened = (path) => {
        read(path);
        if (typeof path === 'string')
            listed.set(nameOf(path), null);
    };
    /** A call whose answer this module cannot attribute to a name: the build depends on everything. */
    const everything = () => { whole = true; };
    const view = {
        ...(bridge.gateLaunch !== undefined ? { gateLaunch: (...args) => bridge.gateLaunch(...args) } : {}),
        stat: (...args) => found(args[0], () => bridge.stat(...args)),
        readFile: (...args) => found(args[0], () => bridge.readFile(...args)),
        writeFile: (...args) => { everything(); return bridge.writeFile(...args); },
        writeFileFrom: (...args) => { everything(); return bridge.writeFileFrom(...args); },
        readRange: (...args) => found(args[0], () => bridge.readRange(...args)),
        writeRange: (...args) => { everything(); return bridge.writeRange(...args); },
        truncate: (...args) => { everything(); return bridge.truncate(...args); },
        utimes: (...args) => { everything(); return bridge.utimes(...args); },
        chmod: (...args) => { everything(); return bridge.chmod(...args); },
        access: (...args) => found(args[0], () => bridge.access(...args)),
        chown: (...args) => { everything(); return bridge.chown(...args); },
        // A descriptor reads, or lists, what it was opened on.
        open: (...args) => { opened(args[0]); return bridge.open(...args); },
        reopen: (...args) => { everything(); return bridge.reopen(...args); },
        read: (...args) => bridge.read(...args),
        write: (...args) => { everything(); return bridge.write(...args); },
        close: (...args) => bridge.close(...args),
        readdir: (...args) => list(args[0], () => bridge.readdir(...args)),
        mkdir: (...args) => { everything(); return bridge.mkdir(...args); },
        unlink: (...args) => { everything(); return bridge.unlink(...args); },
        rmdir: (...args) => { everything(); return bridge.rmdir(...args); },
        rename: (...args) => { everything(); return bridge.rename(...args); },
        readlink: (...args) => found(args[0], () => bridge.readlink(...args)),
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
        realpath: (...args) => found(args[0], () => bridge.realpath(...args)),
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
    return { view, reads: () => ({ paths: new Set(paths), listed: new Map(listed), absent: new Set(absent), whole }) };
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
    return [...reads.paths, ...reads.listed.keys()].some((name) => points.some((point) => name === point || name.startsWith(point + '/')));
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
/** The directory `name` is in ('' for a name at the root). */
function parentOf(name) {
    const at = name.lastIndexOf('/');
    return at === -1 ? '' : name.slice(0, at);
}
/**
 * Whether any of `changes` (a barrier's report since the build's cursor) can
 * change what a build that asked `reads` answers. `kindNow` answers what is
 * at a name in a directory the build listed, now, which says whether the
 * listing would answer the same.
 */
export async function readsAffectedBy(reads, changes, kindNow) {
    if (reads.whole)
        return changes.length > 0;
    if (changes.length === 0)
        return false;
    // Every directory above a name the build asked about: a structural change there moves what is under it.
    const above = new Set();
    for (const name of [...reads.paths, ...reads.listed.keys()])
        for (const ancestor of ancestorsOf(name))
            above.add(ancestor);
    // The directories the report names as the parent of another of its changes.
    const parents = new Set();
    for (const change of changes)
        parents.add(parentOf(nameOf(change.path)));
    for (const change of changes) {
        const name = nameOf(change.path);
        if (change.structural === true || change.subtree === true) {
            if (reads.paths.has(name) || reads.listed.has(name) || above.has(name))
                return true;
            continue;
        }
        // A path the build asked about, unless it found a directory there and the record is only the parent of another change.
        if (reads.paths.has(name) && (reads.absent.has(name) || !parents.has(name)))
            return true;
        // A name in a directory the build listed: made, removed, or of another kind than the listing said.
        const parent = parentOf(name);
        if (!reads.listed.has(parent))
            continue;
        const listing = reads.listed.get(parent);
        if (listing === null || listing === undefined)
            return true;
        const leaf = name.slice(parent === '' ? 0 : parent.length + 1);
        if ((listing.get(leaf) ?? null) !== await kindNow(name))
            return true;
    }
    return false;
}
