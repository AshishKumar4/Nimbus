/**
 * git-remote-http and git-remote-https: the remote helper real git
 * (git.wasm) starts for an http(s) remote, speaking gitremote-helpers(7) on
 * its stdin and stdout a line at a time.
 *
 * The network and the pack are the GitPackStream engine's (git/engine.ts):
 * `list` is the remote's refs; `fetch` has the engine write the pack the
 * wanted objects need, with its .idx and .rev, and .git/shallow for a
 * shallow fetch, into the repository; `push` has it send the ref updates
 * and a pack of what the remote lacks. The helper writes no ref and moves no
 * object itself: git updates the refs after (remote-tracking refs, tags,
 * FETCH_HEAD), and decides before what may be pushed (a non-fast-forward,
 * --force-with-lease against what `list for-push` said). What git leaves to
 * a push helper, the helper refuses as send-pack does for git-remote-curl: a
 * ref whose remote value this repository lacks ("fetch first").
 *
 * Capabilities: fetch, push, option, check-connectivity, object-format.
 * Not stateless-connect or connect: with those git would run the protocol
 * itself, and git.wasm cannot demultiplex a sideband (start_async forks).
 */
/** Credentials for the remote, as the builtin git takes them (GIT_USERNAME, GIT_PASSWORD or GIT_TOKEN). */
export interface RemoteAuth {
    username: string;
    password: string;
}
/** A ref the remote advertises: its value, or the ref a symbolic one (HEAD) names. */
export interface RemoteRef {
    name: string;
    oid: string | null;
    symref?: string;
}
export interface ListRefsRequest {
    url: string;
    auth?: RemoteAuth;
    /** For a push: the receive-pack side's refs. */
    forPush: boolean;
    /** Only refs under these, when the protocol can narrow it (v2 ls-refs ref-prefix). */
    refPrefixes?: string[];
}
export interface ListRefsResult {
    refs: RemoteRef[];
    objectFormat: 'sha1' | 'sha256';
}
export interface FetchPackRequest {
    url: string;
    auth?: RemoteAuth;
    /** The repository's git directory, as an engine path: where the pack and .git/shallow are written. */
    gitDir: string;
    wants: string[];
    depth?: number;
    /** Seconds since the epoch. */
    deepenSince?: number;
    deepenNot?: string[];
    deepenRelative?: boolean;
    filter?: string;
    /** Annotated tags that point into what is fetched come with it. */
    includeTag: boolean;
    /** git allows .git/shallow to grow (fetch --update-shallow, clone). */
    updateShallow: boolean;
}
export interface FetchPackResult {
    /** The pack written (pack-<hash>), or null when nothing was needed. */
    packName: string | null;
    objects: number;
    bytes: number;
    /** .git/shallow was written. */
    shallow: boolean;
    /** The pack is a promisor pack (a filtered fetch). */
    promisor: boolean;
    /** Every object the wants reach is in the pack or was already here: git may skip its own check. */
    selfContained: boolean;
}
export interface PushCommand {
    ref: string;
    /** The value the remote must still have (all zeros: none), checked by the remote as it updates. */
    old: string;
    /** All zeros deletes the ref. */
    new: string;
}
export interface PushPackRequest {
    url: string;
    auth?: RemoteAuth;
    commands: PushCommand[];
    /** What the remote lacks of the new values; null when every command is a deletion. */
    pack: ReadableStream<Uint8Array> | null;
    atomic: boolean;
    pushOptions: string[];
}
export interface PushPackResult {
    refs: Array<{
        ref: string;
        ok: boolean;
        reason?: string;
    }>;
}
/** The GitPackStream engine, bound to the session (git/engine.ts). */
export interface RemoteEngine {
    listRefs(request: ListRefsRequest): Promise<ListRefsResult>;
    fetchPack(request: FetchPackRequest): Promise<FetchPackResult>;
    pushPack(request: PushPackRequest): Promise<PushPackResult>;
}
/** What the helper asks of the repository it serves, through git itself. */
export interface LocalGit {
    /** Of `oids`, those the repository has (git cat-file --batch-check). */
    has(gitDir: string, oids: string[]): Promise<Set<string>>;
    /**
     * A pack of what `include` reaches and `exclude` does not, as git
     * pack-objects --revs --thin --stdout makes it; an excluded id the
     * repository does not have is passed over.
     */
    packObjects(request: {
        gitDir: string;
        include: string[];
        exclude: string[];
    }): ReadableStream<Uint8Array>;
}
/** What the helper needs of its process: its stdin as lines, its stdout and stderr, its environment and directory. */
export interface HelperIo {
    args: string[];
    env: Record<string, string>;
    cwd: string;
    /** The next line without its LF, or null at the end of the input. */
    readLine(): Promise<string | null>;
    stdout(text: string): Promise<void> | void;
    stderr(text: string): Promise<void> | void;
    /** A file's bytes, or null when it is not there. */
    readFile(path: string): Promise<Uint8Array | null>;
}
/** A C-style quoted value (quote_c_style) as the string it quotes; any other as it is. */
export declare function unquoteC(value: string): string | null;
/**
 * Run the helper to the end of git's commands: 0 at the blank line that
 * ends them, 128 on an error git cannot continue past (git reports the
 * helper's exit).
 */
export declare function runRemoteHelper(io: HelperIo, engine: RemoteEngine, local: LocalGit): Promise<number>;
//# sourceMappingURL=remote-helper.d.ts.map