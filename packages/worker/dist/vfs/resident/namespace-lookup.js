/**
 * The namespace's read path: the row at a key, and the walk of a name to
 * where the table holds it. Module loading reads every file through these
 * (node-shims _nsWalk, _entry), after the program may have replaced any
 * built-in, so they call only the launch's captures (core _shared
 * primordials.ts; design-guest-loader-primordials.md §3.5), as Node's loader
 * reads files on its primordials.
 */
import { objectHasOwn, ownField, SafeList, stringCharCodeAt, stringIndexOf, stringLastIndexOf, stringOf, stringSlice, } from '@nimbus-sh/core/_shared/primordials.js';
import { NS_DIR, NS_LINK } from './tables.js';
/** Symlink hops before a resolution is ELOOP, as Linux's MAXSYMLINKS. */
export const NS_MAX_HOPS = 40;
// What an own word says, by its own properties: never one it inherits.
const removed = (word) => objectHasOwn(word, 'absent');
const linked = (word) => objectHasOwn(word, 'target');
const moved = (word) => objectHasOwn(word, 'from');
/** The directory part of key `k`: '' at the top. */
export function nsParent(k) {
    const i = stringLastIndexOf(k, '/');
    return i < 0 ? '' : stringSlice(k, 0, i);
}
/** The last name of key `k`. */
export function nsName(k) {
    return stringSlice(k, stringLastIndexOf(k, '/') + 1);
}
/** Key `k` as its directory and its last name. */
export function nsSplit(k) {
    return [nsParent(k), nsName(k)];
}
/** A path as the namespace keys it: no leading '/'. */
export function nsKey(path) {
    const text = stringOf(path);
    let at = 0;
    while (at < text.length && stringCharCodeAt(text, at) === 0x2f)
        at++;
    return at === 0 ? text : stringSlice(text, at);
}
/** The row at exactly `k` (no symlink resolution), or undefined. */
export function nsRowAt(t, k) {
    if (k === '') {
        return { kind: NS_DIR, size: 0, mode: 0o40755, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, ino: 1, rev: 0, target: null, dev: 0, nlink: 1 };
    }
    return t.nsGet(nsParent(k), nsName(k));
}
/** The names of `path`, split at '/', empty ones and '.' kept: a walk's steps. */
function segments(path) {
    const out = new SafeList();
    if (path === '')
        return out;
    let from = 0;
    for (;;) {
        const slash = stringIndexOf(path, '/', from);
        if (slash < 0) {
            out[out.length] = stringSlice(path, from);
            return out;
        }
        out[out.length] = stringSlice(path, from, slash);
        from = slash + 1;
    }
}
/** `names` from `start` to `end`, joined by '/'. */
function joined(names, start, end) {
    let text = '';
    for (let i = start; i < end; i++)
        text = i === start ? names[i] ?? '' : `${text}/${names[i] ?? ''}`;
    return text;
}
/**
 * A link's `target` resolved lexically against the directory of the name it
 * was reached by (`linkPath`): its names after that directory's, an absolute
 * target's from the top, `.` and empty names dropped, each `..` taking back
 * the name before it and staying at the top (platform lexical-path's
 * rootClampedSegments).
 */
export function joinTarget(linkPath, target) {
    const text = stringOf(target);
    const out = new SafeList();
    const add = (names) => {
        for (let i = 0; i < names.length; i++) {
            const name = names[i] ?? '';
            if (name === '..') {
                if (out.length > 0)
                    out.length--;
            }
            else if (name !== '' && name !== '.')
                out[out.length] = name;
        }
    };
    if (stringCharCodeAt(text, 0) !== 0x2f) {
        // The link's directory, its names as they are.
        const base = segments(nsParent(linkPath));
        for (let i = 0; i < base.length; i++)
            if (base[i] !== '')
                out[out.length] = base[i] ?? '';
    }
    add(segments(text));
    return joined(out, 0, out.length);
}
/**
 * The walk of `k` (lookup): the process's own effects (`own`) applied at
 * each name it reaches, ahead of the table: a name it removed ends the walk,
 * its links and renames redirect it, and beneath a directory it made only
 * its own names are there. The leaf is followed only when `followLeaf`. A
 * link's target is joined to the name it was reached by. `visit`: told each
 * name the walk looks up, in order; false stops the walk there, EACCES.
 */
export function walkNamespace(t, links, k, followLeaf, own, visit) {
    if (own === undefined && links.size === 0 && visit === undefined)
        return { path: k, table: k, row: nsRowAt(t, k) };
    let path = k;
    walk: for (let hops = 0; hops <= NS_MAX_HOPS; hops++) {
        const segs = segments(path);
        let table = '';
        let prefix = '';
        for (let i = 1; i <= segs.length; i++) {
            const name = segs[i - 1] ?? '';
            prefix = i === 1 ? name : `${prefix}/${name}`;
            if (visit !== undefined && !visit(prefix))
                return 'EACCES';
            const leaf = i === segs.length;
            const step = table === null ? null : table ? `${table}/${name}` : name;
            const word = own === undefined ? undefined : own(prefix);
            let target;
            if (word !== undefined && removed(word)) {
                return { path, table: null, row: undefined, own: word };
            }
            else if (word !== undefined && linked(word)) {
                if (leaf && !followLeaf)
                    return { path, table: null, row: undefined, own: word };
                target = word.target;
            }
            else if (word !== undefined && moved(word)) {
                const named = ownField(word, 'link');
                const link = typeof named === 'string' ? named : undefined;
                if (link !== undefined && leaf && !followLeaf) {
                    const at = nsRowAt(t, link) !== undefined ? link : prefix;
                    return { path, table: at, row: nsRowAt(t, at), own: word };
                }
                if (word.from === undefined)
                    return { path, table: null, row: undefined, own: { absent: true } };
                if (link !== undefined)
                    target = `/${word.from}`;
                else {
                    table = word.from;
                    if (leaf)
                        return { path, table, row: nsRowAt(t, table), own: word };
                    continue;
                }
            }
            else if (word !== undefined) {
                // Its own entry is where the table will hold it.
                table = ownField(word, 'hide') === true ? null : prefix;
                if (leaf)
                    return { path, table: prefix, row: nsRowAt(t, prefix), own: word };
                continue;
            }
            else {
                if (step === null)
                    return { path, table: null, row: undefined };
                table = step;
                if (!links.has(step) || (leaf && !followLeaf))
                    continue;
                const row = nsRowAt(t, step);
                if (!row || row.kind !== NS_LINK)
                    continue;
                target = row.target;
            }
            const rest = joined(segs, i, segs.length);
            const reached = joinTarget(prefix, target);
            path = rest ? (reached ? `${reached}/${rest}` : rest) : reached;
            continue walk;
        }
        return { path, table, row: table === null ? undefined : nsRowAt(t, table) };
    }
    return 'ELOOP';
}
