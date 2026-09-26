/** The R2 surface this needs. */
export interface ReadProfileBucket {
    get(key: string): Promise<{
        text(): Promise<string>;
        etag?: string;
    } | null>;
    /** Null when the `onlyIf` precondition failed and nothing was stored (R2). */
    put(key: string, value: string, options?: {
        onlyIf: {
            etagMatches: string;
        } | {
            etagDoesNotMatch: '*';
        };
    }): Promise<unknown>;
    delete?(key: string): Promise<unknown>;
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
/** Entries one package's profile stores (a storage bound, not what a launch stages). */
export declare const READ_PROFILE_MAX_ENTRIES = 1024;
/** Bytes of one profile path. */
export declare const READ_PROFILE_MAX_PATH_LENGTH = 512;
/** Distinct principals an entry must be observed by before it is shared. */
export declare const READ_PROFILE_SHARE_AFTER = 2;
/** Writes one principal may make to one package's profile per window. */
export declare const READ_PROFILE_WRITES_PER_WINDOW = 8;
/** A package-relative path a profile may hold, or false. */
export declare function validProfilePath(rel: unknown): rel is string;
/**
 * The principal a session writes to profiles as: its Durable Object name's
 * tenant segment (`<tn>:<sub>`, set by the router from the verified token),
 * or null when the session is anonymous or has no such name, and so may only
 * read.
 */
export declare function profilePrincipal(tenantSegment: string | null | undefined): string | null;
/** A principal's tag in a profile: never the principal itself. */
export declare function principalTag(principal: string): Promise<string>;
/** One miss the supervisor can vouch for: a regular file in a package, and its size. */
export interface ProfileEvidence {
    path: string;
    size: number;
}
/**
 * The misses worth recording: those in `reported` (what the program says it
 * missed) that the supervisor itself `served` an async read for, and that
 * `stat` (as the process's credential) shows as a regular file inside a
 * package. Everything else the program claims is dropped.
 */
export declare function verifiedEvidence(reported: Iterable<string>, served: ReadonlySet<string>, stat: (path: string) => Promise<{
    type: string;
    size: number;
} | null>): Promise<ProfileEvidence[]>;
/**
 * The paths a supervisor served async reads for, per process. Bounded per
 * process: evidence is what a process was served after a miss, and a process
 * that reads more than this many distinct files keeps its first ones.
 */
export declare class ServedReads {
    static readonly MAX_PER_PROCESS = 4096;
    private readonly byPid;
    note(pid: number, path: unknown): void;
    /** What `pid` was served, and forget it. */
    take(pid: number): ReadonlySet<string>;
}
/** One profile entry `lookup` offered a launch. */
export interface StagedProfileEntry {
    /** The namespace key (`<package root>/<rel>`). */
    path: string;
    size: number;
    /** Where the entry lives: its profile object and package-relative path. */
    object: string;
    rel: string;
}
export declare class ReadProfile {
    private readonly bucket;
    private readonly now;
    private index;
    constructor(bucket: ReadProfileBucket, now?: () => number);
    private static key;
    /** Group paths under their package's profile key. */
    private static byPackage;
    /**
     * File what one principal's process observed (`verifiedEvidence`). Each
     * entry keeps the distinct principals that observed it; it is shared once
     * there are two. `tag` is null for a session that may not write (anonymous).
     */
    observe(evidence: Iterable<ProfileEvidence>, tag: string | null, integrityOf: (root: string) => string | null): Promise<number>;
    /**
     * One read-modify-write of `key` by `tag`: `mutate` changes the profile
     * read and says whether it did. The write is conditional on the object
     * still being the one read, and is tried again from a fresh read when
     * another writer got there first, so concurrent writers each land. False
     * when nothing changed, the principal is over its cap, or every try lost.
     */
    private update;
    /**
     * Count one write by `tag` to `profile`, or refuse it: a principal writes
     * one package's profile at most READ_PROFILE_WRITES_PER_WINDOW times per
     * window, so no one party can churn an object every tenant reads.
     */
    private admitWrite;
    /**
     * A full profile evicts its weakest unshared entry for a new one; shared
     * entries are never evicted for an observation only one principal made.
     */
    private static makeRoom;
    /**
     * The shared entries for the packages at `roots` (namespace keys), best
     * first (score, then smaller files), whose sizes add up to at most
     * `budgetBytes`.
     */
    lookup(roots: Iterable<string>, integrityOf: (root: string) => string | null, budgetBytes: number): Promise<StagedProfileEntry[]>;
    /**
     * What one launch did with the entries `lookup` gave it. `unread` is what
     * the process reported it never read (its word can only lower a score), or
     * null when it reported no list at all (a launch that died before its
     * report), which says nothing about any entry; `served` is what the
     * supervisor served it async reads for during the launch (a staged file the
     * process used is never faulted in, so an entry staged and not in `served`
     * is the supervisor's evidence it was held); `unresolved` is what the plan
     * found no regular file for; `tag` is the launching session's principal's,
     * or null for a session that may not write (anonymous), whose launch
     * changes nothing.
     *   unresolved                            -> removed
     *   no report                             -> unchanged
     *   reported unread                       -> score - 1
     *   staged, never served, tag not vouched -> score + 1 (at most MAX_SCORE)
     *   otherwise                             -> unchanged
     * A score of zero removes the entry.
     */
    settle(staged: Iterable<StagedProfileEntry>, unread: ReadonlySet<string> | null, served: ReadonlySet<string>, unresolved: ReadonlySet<string>, tag: string | null): Promise<void>;
    /** Store `profile` if `key` is still the object `etag` names (null: still absent). */
    private write;
    private read;
    private readVersioned;
    private listIndex;
}
//# sourceMappingURL=read-profile.d.ts.map