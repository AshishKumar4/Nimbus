/**
 * git/worktree/status.ts — `git status`'s short and porcelain v1 forms
 * (wt-status.c), from the tree walk, the index and the worktree walk.
 *
 * HEAD's tree against the index gives the first column (diff-index --cached,
 * renames found among its adds and deletes), the worktree walk the second
 * (diff-files) and the untracked list. Only changed paths are held, sorted
 * once at the end as git's string lists sort them.
 */
import { detectRenames, quotePath } from '../unified-diff.js';
import { encodeNode } from './cachetree.js';
import { comparePaths, compareBytes, decodePath, S_IFMT } from './dircache.js';
import { PairList } from './pairs.js';
import { S_IFDIR, readTree } from './tree.js';
import { scanWorktree } from './walk.js';
const encoder = new TextEncoder();
/** Whether `path` is one of `specs` or below one; no specs is everything. */
export function inSpecs(specs, path) {
    return specs.length === 0 || specs.some((spec) => spec === '' || path === spec || path.startsWith(`${spec}/`));
}
/** Whether directory `dir` holds one of `specs`, so a walk enters it on the way. */
export function holdsSpec(specs, dir) {
    return specs.some((spec) => spec.startsWith(`${dir}/`));
}
/**
 * diff-index --cached: the leaves of `tree` against the index's entries, in
 * path order, one directory at a time. `visit` gets each path where either
 * has something: the leaf (or null) and the index entries [lo, hi) at that
 * path (lo === hi for none; more than one, or a stage, for an unmerged
 * path). Unchanged paths are visited too; the caller compares.
 *
 * A directory the index's cache tree records as valid, with the id of the
 * tree's subtree there and as many entries as the index holds below it, is
 * the same on both sides: it is skipped, its tree never read. With `build`,
 * the walk answers the cache tree the index has against `tree` (a node for
 * every directory where the two agree, valid), for the caller to record.
 */
export async function walkTreeAndIndex(store, tree, dc, specs, visit, { cacheTree = null, build = false } = {}) {
    const join = (dir, name) => (dir ? `${dir}/${name}` : name);
    const entered = (dir) => inSpecs(specs, dir) || holdsSpec(specs, dir);
    /**
     * One directory: `treeOid` (null for none) against the index's [lo, hi)
     * below it, `node` its cache-tree node (-1 for none). With `build`, the
     * directory's cache-tree node as written, when it has one.
     */
    const walk = async (dir, treeOid, lo, hi, node) => {
        if (cacheTree !== null && node >= 0 && treeOid !== null && cacheTree.count(node) === hi - lo && cacheTree.oid(node) === treeOid) {
            return { same: true, built: build ? cacheTree.nodeBytes(node) : null };
        }
        const entries = treeOid === null ? [] : await readTree(store, treeOid);
        const subtrees = cacheTree !== null && node >= 0 ? cacheTree.subtrees(node) : null;
        const built = build ? [] : null;
        let same = treeOid !== null;
        const skip = dir ? encoder.encode(dir).length + 1 : 0;
        let t = 0;
        let i = lo;
        while (t < entries.length || i < hi) {
            // The index's next child here: a file (its stages) or a directory (the run below it).
            let indexKey = null;
            let childEnd = i;
            let childDir = false;
            if (i < hi) {
                const rest = dc.pathBytes(i).subarray(skip);
                const slash = rest.indexOf(0x2f);
                const name = decodePath(slash < 0 ? rest : rest.subarray(0, slash));
                childDir = slash >= 0;
                if (childDir) {
                    childEnd = dc.rangeUnder(join(dir, name), i, hi)[1];
                }
                else {
                    childEnd = i + 1;
                    while (childEnd < hi && dc.stage(childEnd) !== 0 && compareBytes(dc.pathBytes(childEnd), dc.pathBytes(i)) === 0)
                        childEnd++;
                }
                indexKey = childDir ? `${name}/` : name;
            }
            const entry = t < entries.length ? entries[t] : null;
            const treeKey = entry === null ? null : (entry.mode & S_IFMT) === S_IFDIR ? `${entry.name}/` : entry.name;
            const order = treeKey === null ? 1 : indexKey === null ? -1 : comparePaths(treeKey, indexKey);
            const name = order <= 0 ? entry.name : indexKey.replace(/\/$/, '');
            const path = join(dir, name);
            const subtree = order <= 0 && (entry.mode & S_IFMT) === S_IFDIR;
            const indexLo = i;
            const indexHi = order >= 0 ? childEnd : i;
            if (order <= 0)
                t++;
            if (order >= 0)
                i = childEnd;
            if (subtree || (order > 0 && childDir)) {
                if (!entered(path)) {
                    same = false;
                    continue;
                }
                const child = subtree && order === 0 ? subtrees?.get(name) ?? -1 : -1;
                const sub = await walk(path, subtree ? entry.oid : null, indexLo, indexHi, child);
                same &&= sub.same && order === 0;
                if (built && sub.built)
                    built.push(sub.built);
                continue;
            }
            const leaf = order <= 0 ? { path, mode: entry.mode, oid: entry.oid } : null;
            same &&= order === 0 && indexHi - indexLo === 1 && dc.stage(indexLo) === 0
                && dc.mode(indexLo) === leaf.mode && dc.oid(indexLo) === leaf.oid;
            if (inSpecs(specs, path))
                await visit(path, leaf, indexLo, indexHi);
        }
        if (!built || (!(same && treeOid !== null) && built.length === 0))
            return { same, built: null };
        const valid = same && treeOid !== null;
        return { same, built: encodeNode(dir.slice(dir.lastIndexOf('/') + 1), valid ? hi - lo : -1, valid ? treeOid : null, built) };
    };
    return (await walk('', tree, 0, dc.count, cacheTree === null ? -1 : cacheTree.root)).built?.bytes ?? null;
}
const UNMERGED = ['', 'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
// The index column's code per index entry: a letter, or (8 + mask) for an unmerged path.
const CODE_LETTERS = ['', 'M', 'T', 'A', 'R'];
const UNMERGED_CODE = 8;
/**
 * wt_status_collect: every changed path, then the untracked ones, each in
 * git's order. Held as a byte a index entry for the index column, the
 * worktree walk's DirtySet for the other, and the staged deletions (paths
 * the index no longer has) in columns; additions and deletions become
 * objects only to be matched as renames. A line is made as it is printed.
 */
export async function collectStatus(store, tree, dc, head, options) {
    const codes = new Uint8Array(dc.count);
    const renamedFrom = new Map();
    // diff-index --cached HEAD: additions and deletions in columns, for rename detection.
    const addsAndDeletes = new PairList();
    // An index with no cache tree (one a clone or cf-git wrote) gets the one the whole tree's walk
    // answers against HEAD: kept, the next status skips what agrees. One it has is git's to keep.
    const whole = options.specs.length === 0 && dc.cacheTree() === null;
    const built = await walkTreeAndIndex(store, head, dc, options.specs, (path, leaf, lo, hi) => {
        if (hi - lo > 1 || (hi > lo && dc.stage(lo) !== 0)) {
            let mask = 0;
            for (let i = lo; i < hi; i++)
                if (dc.stage(i))
                    mask |= 1 << (dc.stage(i) - 1);
            codes[lo] = UNMERGED_CODE + mask;
            return;
        }
        const entry = hi > lo && !dc.intentToAdd(lo) ? lo : -1;
        if (leaf && entry >= 0 && leaf.oid === dc.oid(entry) && leaf.mode === dc.mode(entry))
            return;
        if (leaf && entry >= 0) {
            codes[entry] = (leaf.mode & S_IFMT) !== (dc.mode(entry) & S_IFMT) ? 2 : 1;
            return;
        }
        if (leaf || entry >= 0)
            addsAndDeletes.add(path, leaf, entry >= 0 ? { oid: dc.oid(entry), mode: dc.mode(entry), worktree: false } : null);
    }, { cacheTree: dc.cacheTree(), build: whole });
    if (built)
        dc.setCacheTree(built);
    const order = addsAndDeletes.order();
    let hasAdd = false;
    let hasDelete = false;
    for (const k of order) {
        if (addsAndDeletes.pair(k).two)
            hasAdd = true;
        else
            hasDelete = true;
    }
    let pairs = [];
    if (options.renames && hasAdd && hasDelete) {
        const queue = [...order].map((k) => addsAndDeletes.pair(k));
        // Rename detection reads the blobs on both sides: a partial clone fetches them in one request.
        await store.prefetch(addsAndDeletes.storeOids());
        pairs = (await detectRenames(queue, async (side) => (await store.read(side.oid)).data)).queue;
    }
    else {
        pairs = [...order].map((k) => addsAndDeletes.pair(k));
    }
    // Additions and renames are index entries; deletions are not, and are kept in path order.
    const deleted = [];
    for (const pair of pairs) {
        if (pair.two) {
            const at = dc.find(pair.two.path);
            codes[at] = pair.one ? 4 : 3;
            if (pair.one)
                renamedFrom.set(at, pair.one.path);
        }
        else {
            deleted.push(pair.one.path);
        }
    }
    pairs = [];
    // diff-files, and the untracked files.
    const scan = await scanWorktree(tree, dc, { specs: options.specs, untracked: options.untracked, excludes: options.excludes });
    let count = deleted.length;
    for (let i = 0; i < dc.count; i++)
        if (codes[i] !== 0 || scan.dirty.has(i))
            count++;
    const changes = function* () {
        let d = 0;
        for (let i = 0; i < dc.count; i++) {
            const code = codes[i];
            const dirty = scan.dirty.get(i);
            if (code === 0 && !dirty)
                continue;
            const path = dc.path(i);
            while (d < deleted.length && comparePaths(deleted[d], path) < 0)
                yield { path: deleted[d++], index: 'D', worktree: ' ' };
            if (code >= UNMERGED_CODE) {
                yield { path, index: ' ', worktree: ' ', unmerged: UNMERGED[code - UNMERGED_CODE] };
                continue;
            }
            const from = renamedFrom.get(i);
            yield { path, index: code ? CODE_LETTERS[code] : ' ', worktree: dirty ? dirty.change : ' ', ...(from === undefined ? {} : { from }) };
        }
        while (d < deleted.length)
            yield { path: deleted[d++], index: 'D', worktree: ' ' };
    };
    return {
        count,
        changes,
        untracked: scan.untracked.sort(comparePaths),
        // diff-files reports first, then read_directory.
        errors: [...scan.errors.tracked, ...scan.errors.untracked],
    };
}
/**
 * path.c relative_path: `path` as seen from `prefix` (which ends in '/'),
 * climbing with '../'; './' for the prefix itself.
 */
export function relativePath(path, prefix) {
    if (!path)
        return './';
    if (!prefix)
        return path;
    let i = 0;
    let j = 0;
    let prefixOff = 0;
    let inOff = 0;
    while (i < prefix.length && j < path.length && prefix[i] === path[j]) {
        if (prefix[i] === '/') {
            while (prefix[i] === '/')
                i++;
            while (path[j] === '/')
                j++;
            prefixOff = i;
            inOff = j;
        }
        else {
            i++;
            j++;
        }
    }
    if (i >= prefix.length && prefixOff < prefix.length) {
        if (j >= path.length)
            inOff = path.length;
        else if (path[j] === '/') {
            while (path[j] === '/')
                j++;
            inOff = j;
        }
        else {
            i = prefixOff;
        }
    }
    else if (j >= path.length && inOff < path.length && prefix[i] === '/') {
        while (prefix[i] === '/')
            i++;
        inOff = path.length;
    }
    const rest = path.slice(inOff);
    if (i >= prefix.length)
        return rest || './';
    let out = '';
    while (i < prefix.length) {
        if (prefix[i] === '/') {
            out += '../';
            while (prefix[i] === '/')
                i++;
            continue;
        }
        i++;
    }
    if (prefix[prefix.length - 1] !== '/')
        out += '../';
    return out + rest;
}
/** quote_path with QUOTE_PATH_QUOTE_SP: C-quoted when a byte needs it, and quoted whole when it holds a space. */
function statusQuote(path) {
    const quoted = quotePath(path);
    return quoted[0] !== '"' && path.includes(' ') ? `"${quoted}"` : quoted;
}
/**
 * wt_shortstatus_print as binary strings, one line at a time. `prefix` (the
 * cwd below the top, ending in '/', or '') makes paths relative, as short
 * status does and porcelain does not; `z` ends entries with NUL and prints
 * paths as they are.
 */
export function* shortStatusLines(status, { prefix, z }) {
    const bin = (path) => String.fromCharCode(...encoder.encode(path));
    const show = (path) => (z ? bin(path) : statusQuote(relativePath(path, prefix)));
    const end = z ? '\0' : '\n';
    for (const entry of status.changes) {
        if (entry.unmerged) {
            yield `${entry.unmerged} ${show(entry.path)}${end}`;
        }
        else if (z) {
            yield `${entry.index}${entry.worktree} ${show(entry.path)}\0${entry.from === undefined ? '' : `${show(entry.from)}\0`}`;
        }
        else {
            yield `${entry.index}${entry.worktree} ${entry.from === undefined ? '' : `${show(entry.from)} -> `}${show(entry.path)}\n`;
        }
    }
    for (const path of status.untracked)
        yield `?? ${show(path)}${end}`;
}
