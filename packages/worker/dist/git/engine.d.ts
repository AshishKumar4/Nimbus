import type { WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
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
    /** Only refs under these, when the protocol can narrow it (v2 ls-refs ref-prefix): protocol v0 cannot, and lists all. */
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
/** The GitPackStream engine, bound to the session (remote-helper.ts takes it). */
export interface RemoteEngine {
    listRefs(request: ListRefsRequest): Promise<ListRefsResult>;
    fetchPack(request: FetchPackRequest): Promise<FetchPackResult>;
    pushPack(request: PushPackRequest): Promise<PushPackResult>;
}
/** The process an engine works for, and the session it runs in. */
export interface EngineBinding {
    /** The DO's state and env, as execGitNetwork takes them. */
    ctx: DurableObjectState;
    env: unknown;
    /** The calling process: the facet acts as it (its credential, its filesystem). */
    pid: number;
    network: WorkspaceNetwork;
    /** One operation's limit (the facet's default when absent). */
    timeoutMs?: number;
    /** Verification knob: a fetch's decoding budget per invocation (processor.ts WORK_BUDGET_UNITS by default). */
    budgetUnits?: number;
}
/** A failed operation, as the helper reports it to git. */
export declare class RemoteEngineError extends Error {
    constructor(message: string);
}
export declare function createRemoteEngine(binding: EngineBinding): RemoteEngine;
//# sourceMappingURL=engine.d.ts.map