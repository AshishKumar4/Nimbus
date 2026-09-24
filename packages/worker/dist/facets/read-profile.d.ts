/** The R2 surface this needs. */
export interface ReadProfileBucket {
    get(key: string): Promise<{
        text(): Promise<string>;
    } | null>;
    put(key: string, value: string): Promise<unknown>;
    list(options: {
        prefix: string;
        cursor?: string;
    }): Promise<{
        objects: {
            key: string;
        }[];
        truncated: boolean;
        cursor?: string;
    }>;
}
/** Paths one package's profile holds. */
export declare const READ_PROFILE_MAX_PATHS = 512;
/** Bytes of one profile path. */
export declare const READ_PROFILE_MAX_PATH_LENGTH = 512;
/** A package-relative path a profile may hold, or false. */
export declare function validProfilePath(rel: unknown): rel is string;
export declare class ReadProfile {
    private readonly bucket;
    private readonly now;
    private index;
    constructor(bucket: ReadProfileBucket, now?: () => number);
    private static key;
    /**
     * File `paths` (namespace keys) that a process missed, each under the
     * package it sits in. `integrityOf(root)` is the lockfile's integrity for a
     * package directory, or null; a path outside any package, or in a package
     * with none, is not shared.
     */
    record(paths: Iterable<string>, integrityOf: (root: string) => string | null): Promise<number>;
    /** The recorded paths (namespace keys) for the packages at `roots`. */
    lookup(roots: Iterable<string>, integrityOf: (root: string) => string | null): Promise<string[]>;
    private read;
    private listIndex;
}
//# sourceMappingURL=read-profile.d.ts.map