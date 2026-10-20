/**
 * The resident store's tables, and its two backings (store.ts decides; a
 * backing only stores). Five tables: 'file' (one row per held path: kind,
 * size, chunk count, revision, content key), 'chunk' (the bytes), 'meta'
 * (schema, cursor, namespace readiness), 'ns' (the namespace: a stat per
 * visible name, keyed (parent, name)) and 'page' (pages of files too big to
 * hold whole, each at the revision it was read at: pages.ts).
 *
 * - sqlTables: the process facet's own SQLite (ctx.storage.sql), durable
 *   across the facet's incarnations. Every statement the store has ever
 *   issued lives here, unchanged.
 * - heapTables: a one-shot process's store, in its heap, for the life of the
 *   run (runOnce hosts no SQLite). Same rows, same answers, and a byte count
 *   that plays the database's size for the store's budget.
 *
 * Rows come back as plain objects with the column names as keys: file heads
 * { kind, size, chunks }, chunks { txt, bin } (bin as the backing holds it;
 * callers normalise with residentBytes), ns rows with every stat column.
 */
/**
 * Cell kinds. A cell is one of the three things __vfsBundle has always held,
 * and the kind is stored rather than inferred so a text file whose bytes happen
 * to be valid UTF-8 does not change shape between a write and a read.
 */
export declare const RESIDENT_SCHEMA = "4";
export declare const RK_TEXT = 0;
export declare const RK_BINARY = 1;
export declare const RK_DENIED = 2;
/**
 * The revision of a cell holding this facet's own bytes that the authority has
 * not acknowledged yet: a write that has not flushed, or a cell one of its own
 * mutations holds while that mutation is in flight (store.lease).
 *
 * Read-your-writes: strictly newer than anything the authority could report,
 * so it is never evicted by a delta and never mistaken for something the
 * authority vouched for. A distinct sentinel rather than NULL, because NULL
 * would reintroduce the undated row the NOT NULL constraint exists to forbid.
 *
 * It is the ONE revision a delta cannot evict, so it must mean exactly that
 * and nothing else. The acknowledgement dates the row (store.stamp), and
 * bytes the authority served are dated as they are installed (store.fill). A
 * row left here after either would hold its bytes against every later write
 * by anyone, for the life of the store.
 */
export declare const RK_OWN_WRITE = -1;
/** Namespace row kinds. */
export declare const NS_FILE = 0;
export declare const NS_DIR = 1;
export declare const NS_LINK = 2;
export interface FileHead {
    kind: number;
    size: number;
    chunks: number;
}
export interface FileRow {
    path: string;
    rev: number;
    ckey: string | null;
}
export interface FileByKey extends FileHead {
    path: string;
}
export interface ChunkRow {
    txt: string | null;
    bin: Uint8Array | ArrayBuffer | null;
}
export interface NsRow {
    kind: number;
    size: number;
    mode: number;
    uid: number;
    gid: number;
    atime: number;
    mtime: number;
    ctime: number;
    ino: number;
    rev: number;
    target: string | null;
    dev: number;
    nlink: number;
}
export interface NsKey {
    parent: string;
    name: string;
}
export interface NsChild {
    name: string;
    kind: number;
    mode: number;
}
export interface PageRow {
    path: string;
    rev: number;
    part: number;
    size: number;
}
/** The one contract both backings keep. */
export interface ResidentTables {
    /** What the store's budget counts it as holding. */
    bytes(): number;
    databaseSize(): number;
    metaGet(k: string): string | undefined;
    metaSet(k: string, v: string): void;
    fileHead(path: string): FileHead | undefined;
    fileRev(path: string): number | undefined;
    fileRevKey(path: string): {
        rev: number;
        ckey: string | null;
    } | undefined;
    fileOwnSize(path: string): number | undefined;
    filePut(path: string, kind: number, size: number, chunks: number, rev: number, ckey: string | null): void;
    fileSetRev(path: string, rev: number): void;
    fileStampOwn(path: string, rev: number): void;
    fileDelete(path: string): void;
    fileByKey(ckey: string, notPath: string): FileByKey | undefined;
    filePaths(from: string, to: string | null): string[];
    fileAny(from: string, to: string | null): boolean;
    fileRevsIn(from: string, to: string | null): {
        path: string;
        rev: number;
    }[];
    fileAllPaths(): string[];
    fileRows(): FileRow[];
    fileOwnPaths(): string[];
    fileStats(): {
        n: number;
        b: number;
    } | undefined;
    chunkFirst(path: string): ChunkRow | undefined;
    chunkParts(path: string): ChunkRow[];
    chunkAddText(path: string, part: number, txt: string): void;
    chunkAddBin(path: string, part: number, bin: Uint8Array): void;
    chunkSetBin(path: string, part: number, bin: Uint8Array): void;
    chunkCopy(to: string, from: string): void;
    chunkDelete(path: string): void;
    /** Own rows are the one provenance a new incarnation cannot date. */
    dropOwn(): void;
    /** Every dated row, and any chunk no own row claims. */
    dropDated(): void;
    /** Every dated row and its chunks. */
    dropDatedFiles(): void;
    clear(): void;
    nsPut(parent: string, name: string, kind: number, size: number, mode: number, uid: number, gid: number, atime: number, mtime: number, ctime: number, ino: number, rev: number, target: string | null, dev: number, nlink: number): void;
    nsGet(parent: string, name: string): NsRow | undefined;
    nsDelete(parent: string, name: string): void;
    nsDeleteChildren(parent: string): void;
    nsDeleteParents(from: string, to: string | null): void;
    nsClear(): void;
    nsKeys(): NsKey[];
    nsOfKind(kind: number): NsKey[];
    /** Directories whose entries the listing did not name (namespace unlisted): their target is the mount point. */
    nsUnlisted(): (NsKey & {
        target: string;
    })[];
    nsChildren(parent: string): NsChild[];
    nsCount(): number;
    pageGet(path: string, rev: number, part: number): Uint8Array | ArrayBuffer | undefined;
    pageUse(path: string, rev: number, part: number, used: number): void;
    /** Hold a page, answering the bytes of the one it replaced (0 for none). */
    pagePut(path: string, rev: number, part: number, bin: Uint8Array, used: number): number;
    pageDelete(path: string, rev: number, part: number): void;
    /** The least recently used pages, `limit` at most. */
    pageOldest(limit: number): PageRow[];
    pageBytes(): number;
    pageMaxUsed(): number;
}
/**
 * The heap backing's own measures. Its namespace rows count against the
 * one-shot's single budget, which the store judges before it puts one
 * (namespace.ts): what a put would add is asked first, and nothing is
 * written for a put the budget refuses.
 */
export interface HeapTables extends ResidentTables {
    /** What the namespace rows take of bytes(). */
    nsBytes(): number;
    /** What putting a row at (parent, name) with `target` would add to bytes() (negative: free). */
    nsGrowth(parent: string, name: string, target: string | null): number;
}
/** workerd's ctx.storage.sql, as far as the store uses it. */
export interface ResidentSql {
    exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
    readonly databaseSize?: number;
}
/**
 * Told of every change to a file's head row (`path`; every head when it is
 * undefined), whoever makes it: the one point what was decided over a head
 * (a fill writing its chunks, cells.putChunk) learns it no longer stands.
 * Each backing writes head rows through one function (writeHead) that tells
 * it first, so no writer can change a head without it.
 */
export type HeadChanged = (path?: string) => void;
export declare function sqlTables(sql: ResidentSql, headChanged?: HeadChanged): ResidentTables;
/**
 * The one-shot backing: the same tables, in the process's heap, for the life
 * of one run. A one-shot is hosted by runOnce, which gives it no SQLite, and
 * it keeps nothing after it exits. Its answers are the SQLite backing's:
 * scans come back in key order (a b-tree's), reads hand back copies (a
 * program that writes into a Buffer it read must not change the store), and
 * `bytes()` counts what it holds in the units residentCellCost charges (a
 * row, and the payload's bytes), so the store's one budget rule serves both.
 */
export declare function heapTables(headChanged?: HeadChanged): HeapTables;
//# sourceMappingURL=tables.d.ts.map