export declare const DEFAULT_CONTEXT = 3;
/** One side of a file pair: git's diff_filespec. */
export interface DiffSpec {
    /** Repo-relative path, or the path as given to --no-index ('/dev/null' for an absent side). */
    path: string;
    /** False on the absent side of an add or a delete. */
    valid: boolean;
    oid: string;
    mode: number;
    data: Uint8Array;
}
export interface DiffPair {
    one: DiffSpec;
    two: DiffSpec;
}
export declare function absentSpec(path: string): DiffSpec;
/** diff_resolve_rename_copy's status letter. */
export declare function pairStatus(pair: DiffPair): 'A' | 'D' | 'T' | 'M';
export declare function binaryFromBytes(bytes: Uint8Array): string;
export declare function bytesFromBinary(text: string): Uint8Array;
/** A path's UTF-8 bytes as a binary string. */
export declare function binaryPath(path: string): string;
/** A path as git prints it on a '\n'-ended line: C-quoted if any byte needs it. */
export declare function quotePath(path: string): string;
/** One entry of a path list: quoted and '\n'-ended, or raw and NUL-ended under -z. */
export declare function pathLine(path: string, z: boolean): string;
/** buffer_is_binary: a NUL in the first 8000 bytes. */
export declare function isBinary(data: Uint8Array): boolean;
/** One file's `diff --git` section, exactly as `git diff` prints it without color. */
export declare function formatPatch(pair: DiffPair, context?: number): string;
export declare function formatNameOnly(pair: DiffPair, z: boolean): string;
export declare function formatNameStatus(pair: DiffPair, z: boolean): string;
export interface StatFile {
    /** Display name: quoted path, or `from => to` when the two sides are named differently. */
    name: string;
    added: number;
    deleted: number;
    binary: boolean;
}
export declare function statFile(pair: DiffPair): StatFile;
/** The --stat block for `columns` terminal columns (git's term_columns: $COLUMNS, else 80). */
export declare function formatStat(files: readonly StatFile[], columns: number): string;
//# sourceMappingURL=unified-diff.d.ts.map