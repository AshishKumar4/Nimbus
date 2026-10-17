/**
 * What a process decided by name in the subtrees it holds (VFS-9 B stage 3):
 * the entries it decided (null: removed), and the names it made and removed
 * in each directory, laid over the view's. They stand while it holds the
 * subtree; once it is given back, everything decided there sent, they retire
 * at the next barrier that lands (released, retire), the view having the
 * session's version of them then.
 */
function parentKey(key) {
    const at = key.lastIndexOf('/');
    return at < 0 ? '' : key.slice(0, at);
}
function nameOf(key) {
    return key.slice(key.lastIndexOf('/') + 1);
}
function within(key, root) {
    return key === root || key.startsWith(`${root}/`);
}
export function ownNames(options) {
    const decided = new Map();
    const added = new Map();
    const removed = new Map();
    const own = new Map();
    /** Of those, the ones all answered outside a held subtree: what a landed barrier may retire. */
    const settling = new Set();
    let barriers = 0;
    /** The directories made here: until the view has one, its names are the ones made in it. */
    const made = new Set();
    /** Whether directory `key` was made here, and the view knows nothing of it: its names are the ones made in it. */
    const madeHere = (key) => made.has(key) && decided.get(key)?.type === 'directory' && !options.entry(key);
    /** `key`'s record goes: the view's row answers for it from now on. */
    const forget = (key) => {
        const entry = decided.get(key);
        own.delete(key);
        settling.delete(key);
        decided.delete(key);
        made.delete(key);
        added.get(parentKey(key))?.delete(nameOf(key));
        removed.get(parentKey(key))?.delete(nameOf(key));
        if (added.get(key)?.size === 0)
            added.delete(key);
        options.forgot(key, entry);
    };
    return {
        entry: (key) => {
            const mine = decided.get(key);
            if (mine !== undefined || made.size === 0)
                return mine;
            const dir = parentKey(key);
            return key !== '' && madeHere(dir) && !added.get(dir)?.has(nameOf(key)) ? null : undefined;
        },
        decided,
        undecide: (key) => { decided.delete(key); },
        note: (dir, name, type) => {
            if (type === null) {
                added.get(dir)?.delete(name);
                let gone = removed.get(dir);
                if (gone === undefined)
                    removed.set(dir, gone = new Set());
                gone.add(name);
            }
            else {
                removed.get(dir)?.delete(name);
                let made = added.get(dir);
                if (made === undefined)
                    added.set(dir, made = new Map());
                made.set(name, type);
            }
        },
        madeDirectory: (key) => {
            made.add(key);
            added.set(key, added.get(key) ?? new Map());
        },
        removedDirectory: (key) => {
            made.delete(key);
            added.delete(key);
            removed.delete(key);
        },
        children: (key, base) => {
            const made = added.get(key);
            const gone = removed.get(key);
            if (made === undefined && gone === undefined)
                return base;
            // One the view has not listed is listed first (undefined asks for that).
            if (base === undefined && !madeHere(key))
                return undefined;
            const out = new Map();
            for (const child of base ?? [])
                if (!gone?.has(child.name))
                    out.set(child.name, child.type);
            for (const [name, type] of made ?? [])
                out.set(name, type);
            return [...out].map(([name, type]) => ({ name, type }));
        },
        move: (from, to) => {
            const moved = (key) => to + key.slice(from.length);
            for (const [key, value] of [...decided])
                if (key !== from && within(key, from)) {
                    decided.delete(key);
                    decided.set(moved(key), value);
                }
            for (const key of [...made])
                if (within(key, from)) {
                    made.delete(key);
                    made.add(moved(key));
                }
            for (const map of [added, removed]) {
                for (const [key, value] of [...map])
                    if (within(key, from)) {
                        map.delete(key);
                        map.set(moved(key), value);
                    }
            }
            for (const [key, value] of [...own]) {
                if (key === from || !within(key, from))
                    continue;
                own.delete(key);
                own.set(moved(key), value);
                if (settling.delete(key))
                    settling.add(moved(key));
            }
        },
        released: (root) => {
            for (const key of decided.keys()) {
                if (!within(key, root))
                    continue;
                const record = own.get(key);
                if (record === undefined)
                    own.set(key, { pending: 0, settled: barriers });
                if (record === undefined || record.pending === 0)
                    settling.add(key);
            }
        },
        barrierBegun: () => ++barriers,
        retire: (begun) => {
            for (const key of [...settling]) {
                const record = own.get(key);
                if (record === undefined || options.held(key))
                    settling.delete(key);
                else if (record.pending === 0 && record.settled < begun)
                    forget(key);
            }
        },
    };
}
