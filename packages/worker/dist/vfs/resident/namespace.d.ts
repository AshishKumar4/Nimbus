/**
 * The namespace: every name the credential can see, exact at the store's
 * cursor: filled from a complete listing, then moved forward by each ACQUIRE
 * delta, whose entries carry the path's stat at the answer's revision (null
 * when it is gone). A change of presence or stat is always a logged mutation
 * of that path, except what vanishes beneath a removed or replaced directory,
 * which the delta application drops by subtree. So a synchronous stat, exists
 * or readdir is answered exactly, and an absent name is known to be absent.
 *
 * This table holds the AUTHORITY's view only. The process's own pending
 * structural effects are an overlay kept by the shims, retired once a barrier
 * begun after they settled has applied.
 *
 * A node process lists every name before its program runs, because a
 * synchronous stat cannot wait for a listing. A process whose calls CAN wait
 * (a WASI guest, parked under JSPI) does not have to pay for names it never
 * looks at, and the bill is real: with a vscode clone in the session (24,683
 * names) the whole enumeration took `node -e 'console.log(1)'` from 0.40 s to
 * 2.0 s (throwaway, 2026-10-05). So such a process starts with no names and a
 * cursor, and lists a directory the first time a lookup needs one of its
 * entries (LAZY). A directory whose entries are all rows is LISTED; below one
 * that is not, a missing row means "not known", never "absent".
 *
 * Rows are what a listing or a delta put there, dated by their own revision,
 * exactly as for an enumerated namespace: deltas from the store's cursor
 * (taken before any listing) name everything that moved since, so a row is
 * never older than the cursor it is judged against.
 */
import type { Admission } from './admission.js';
import type { Coherence } from './coherence.js';
import { type ModeMeta, type ResidentCred } from './permissions.js';
import type { RuntimeVfsStat, VfsInvalidatedPath, VfsListEntry } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type NsRow, type ResidentTables } from './tables.js';
import { type Lookup, type OwnView } from './namespace-lookup.js';
export { nsKey, nsRowAt, nsSplit, type Lookup, type OwnView, type OwnWord } from './namespace-lookup.js';
/** What a row is made from: a stat the session reported, or one the process's own write stands in with until it does. */
export type NsStat = Pick<RuntimeVfsStat, 'type' | 'size' | 'mode' | 'uid' | 'gid' | 'atime' | 'mtime' | 'ctime' | 'ino'> & Partial<Pick<RuntimeVfsStat, 'dev' | 'nlink' | 'revision'>>;
export type Resolved = {
    path: string;
    row: NsRow;
} | 'ELOOP';
/** A lookup or listing asked of the session, until its answer is installed or dropped (Namespace.learning). */
export interface Learning {
    /** Whether what the answer says of `k` may be installed: nothing admitted since it was asked is at or above `k`, and the table was not replaced. */
    installs(k: string): boolean;
    /** Whether the answer's listing of `dir` may be installed: as `installs`, and nothing admitted beneath it either. */
    lists(dir: string): boolean;
    end(): void;
}
export interface Namespace {
    bind(t: ResidentTables): void;
    setCred(cred: ResidentCred | null | undefined): void;
    readonly cred: ResidentCred | null;
    /** Whether the table describes the store's cursor. */
    ready(): boolean;
    /** The persisted 'ns' flag: the table described the cursor when it was last moved, sealed or not. */
    readonly ok: boolean;
    markReady(t: ResidentTables, ready: boolean, cause?: string): void;
    /** Stop answering for `cause` (a budget refused), and throw it as ENOSPC. */
    refuse(t: ResidentTables, cause: string): never;
    /**
     * The bytes the shims' overlay of the process's own structural effects
     * takes, charged to a one-shot's budget: growth that does not fit stops the
     * namespace, and throws ENOSPC.
     */
    overlayDelta(bytes: number): void;
    /** The row at exactly `k` (no symlink resolution), or undefined; refused while sealed. */
    rowAt(k: string): NsRow | undefined;
    /** Why the namespace is not answering (meaningful only while ready() is false). */
    notReadyCause(): string;
    put(t: ResidentTables, k: string, stat: NsStat, rev: unknown, target?: string | null, unlisted?: string | null): void;
    /** `listener` told of each row put, by its key and its file's number, in the same turn (ResidentNamespace.onAdmitted): one, a later one replacing it. */
    onPut(listener: ((k: string, dev: number, ino: number) => void) | null): void;
    tryPut(t: ResidentTables, k: string, stat: NsStat, rev: unknown, target?: string | null, unlisted?: string | null): boolean;
    deleteTree(t: ResidentTables, k: string, self: boolean): void;
    /** Drop one row and what the table keeps of it in heap. */
    forget(t: ResidentTables, k: string): void;
    /**
     * `own`: the process's own effects, applied at each name the walk reaches
     * (OwnView). `visit`: told each name the walk looks up, in order (its
     * directory is the one searched), before it is looked up; false stops the
     * walk there, EACCES.
     */
    lookup(k: string, followLeaf: boolean, own?: OwnView): Lookup | 'ELOOP';
    lookup(k: string, followLeaf: boolean, own: OwnView | undefined, visit: (name: string) => boolean): Lookup | 'ELOOP' | 'EACCES';
    resolve(k: string, followLeaf: boolean, own?: OwnView): Resolved | null;
    unknown(k: string, followLeaf: boolean, listing: boolean, own?: OwnView): string | null;
    children(k: string): {
        name: string;
        kind: number;
        mode: number;
    }[];
    /** Whether the credential may read the file `stat` describes (see readable). */
    readable(stat: ModeMeta | null | undefined): boolean;
    applyEntry(t: ResidentTables, entry: VfsInvalidatedPath): string | null;
    replace(t: ResidentTables, entries: readonly VfsListEntry[]): void;
    noteOwnFile(k: string, size: number, rev: number): void;
    noteLiveStat(k: string, stat: (NsStat & {
        linkTarget?: string | null;
        target?: string | null;
    }) | null, written: number | undefined): void;
    /** Every name forgotten, and the namespace stops answering (store.clear). */
    clear(): void;
    /** Whether this store lists on demand rather than enumerating. */
    readonly lazy: boolean;
    /** Start listing on demand, with no names (store.beginLazy). */
    beginLazy(): void;
    /** Whether a missing row at `k` means nothing is there (its directory is listed). */
    listedAt(k: string): boolean;
    isListed(dir: string): boolean;
    markListed(dir: string): void;
    /**
     * A lookup or listing about to be asked of the session: a delta admitted
     * before its answer lands is newer than the answer at every path it names,
     * and beneath, so the answer installs nothing there, no row and no absence.
     */
    learning(): Learning;
}
export declare function nsKindCode(type: unknown): number;
/**
 * Whether a stat from the authority describes its name: a type, and the
 * mode, owner and group every permission check reads. One without them is
 * no record. Stored, its missing fields would become zeros, a root-owned
 * mode-0 file the authority never reported. The namespace then stops
 * answering (as for a delta without stats) until a listing that does
 * describe every name restores it.
 */
export declare function nsDescribes(stat: unknown): stat is Pick<RuntimeVfsStat, 'type' | 'mode' | 'uid' | 'gid'>;
/**
 * The exclusive upper bound of a prefix under the BINARY collation SQLite gives
 * a TEXT PRIMARY KEY — the successor of the last code unit it can increment.
 * Null when there is none (an empty prefix, or one ending in U+FFFF), and the
 * caller then scans open-ended, which is correct and merely slower.
 *
 * Every caller passes a directory prefix ending in '/', so the increment is
 * '/' → '0' and UTF-16 and UTF-8 orderings agree exactly. They diverge only
 * around the surrogate range, which no path segment separator lives in.
 */
export declare function prefixEnd(prefix: string): string | null;
export declare function createNamespace(coherence: Coherence, admission: Admission): Namespace;
//# sourceMappingURL=namespace.d.ts.map