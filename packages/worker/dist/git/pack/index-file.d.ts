/**
 * git/pack/index-file.ts — the git index (Documentation/gitformat-index.txt),
 * version 2, as a fresh checkout writes it: one stage-0 entry per path,
 * sorted by path bytes, each carrying the stat the session reports for the
 * file, so `git status` finds every entry clean without reading a byte.
 */
/** What the session's stat says of a checked-out path (the wave writer's receipt). */
export interface IndexStat {
    ctimeMs: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    uid: number;
    gid: number;
    size: number;
}
/**
 * One entry, padded: 62 fixed bytes, the path, then 1-8 NULs so the entry's
 * length is a multiple of 8. `stat` is null for a gitlink, whose stat git
 * never compares.
 */
export declare function encodeIndexEntry(path: string, mode: number, oid: Uint8Array, stat: IndexStat | null): Uint8Array;
/** An index extension: a 4-byte signature and its data (gitformat-index.txt, "Extensions"). */
export interface IndexExtension {
    signature: string;
    data: Uint8Array;
}
/**
 * The index file for `entries` (encodeIndexEntry's), in any order; a repeated
 * path is refused. `extensions` follow the entries, before the checksum.
 */
export declare function encodeIndex(entries: Uint8Array[], extensions?: readonly IndexExtension[]): Uint8Array;
/** Concatenated entries, as a batch stores its share of the index until the last batch lands. */
export declare function splitIndexEntries(bytes: Uint8Array): Uint8Array[];
//# sourceMappingURL=index-file.d.ts.map