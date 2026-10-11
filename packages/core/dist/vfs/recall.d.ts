/**
 * Recalling a delegation (SqliteVFS: an exclusive-mutation lease whose
 * holder decides its subtree's operations itself and sends them later):
 * the refusal an access meets, and the one way a caller that can wait
 * passes it. Every layer reports the refusal as EAGAIN for its own call;
 * the recall rides along as the error or its cause.
 */
/**
 * An access meets a delegation another holder has (ExclusiveMutationOptions
 * .delegation): what the holder decided may not be stored yet. A caller that
 * can wait awaits `recall()` and tries again (withRecall); one that cannot is
 * refused (EAGAIN), the recall started, so its retry finds the subtree current.
 */
export declare class RecallRequired extends Error {
    readonly root: string;
    readonly kind: 'share' | 'revoke';
    readonly path: string;
    readonly recall: () => Promise<void>;
    /**
     * A recall a caller that can wait may run ahead of (readers': SqliteVFS
     * read leases): what `run` changes is committed now, and published once
     * the recall is over (`published`); until then it holds what it changed.
     */
    readonly pipeline?: Pipelining | undefined;
    readonly code = "EAGAIN";
    readonly recalling = true;
    constructor(root: string, kind: 'share' | 'revoke', path: string, recall: () => Promise<void>, 
    /**
     * A recall a caller that can wait may run ahead of (readers': SqliteVFS
     * read leases): what `run` changes is committed now, and published once
     * the recall is over (`published`); until then it holds what it changed.
     */
    pipeline?: Pipelining | undefined);
}
/** `run`, its changes committed now and published once the recalls it ran ahead of are over. */
export type Pipelining = <T>(run: () => T) => {
    value: T;
    published: Promise<void>;
};
/**
 * `run` again for as long as what it meets is a delegation to recall (at most
 * `attempts` times): the one way a caller that can wait passes a delegation.
 * A recall it may run ahead of is sent first, one turn before `run` commits
 * (so the recall leaves ahead of the commit's own storage), and what `run`
 * changed is published once it is over: awaited here, or added to `held`
 * for a caller that makes several calls and awaits them all at its end.
 */
export declare function withRecall<T>(run: () => T | Promise<T>, attempts?: number, held?: Set<Promise<void>>): Promise<T>;
/**
 * The recall `error` reports, itself or as the cause a layer kept when it
 * reported the refusal as its own call's (toVfsError, a namespace's
 * syscall error): every layer reports EAGAIN, and the recall rides along.
 */
export declare function recallOf(error: unknown): RecallRequired | null;
//# sourceMappingURL=recall.d.ts.map