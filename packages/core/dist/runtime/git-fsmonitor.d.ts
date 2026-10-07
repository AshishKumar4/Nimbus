import type { Awaitable, RuntimeFsBridge, SqlDatabase, VfsCred } from './os-contracts.js';
/** Host-private issued-token metadata, never VFS files or mutation history. */
export interface GitFsmonitorState {
    load(key: string): Awaitable<string | null>;
    save(key: string, value: string): Awaitable<void>;
}
/** Bounded host metadata in its existing SQL port; no change to VFS tables. */
export declare function sqliteGitFsmonitorState(sql: SqlDatabase, namespace: string): GitFsmonitorState;
export declare function makeGitFsmonitor(state?: GitFsmonitorState): {
    query(args: {
        fs: Pick<RuntimeFsBridge, 'acquire' | 'revision'>;
        cwd: string;
        cred: VfsCred;
        token: string;
        mounts?: readonly string[] | null;
    }): Promise<Uint8Array>;
};
//# sourceMappingURL=git-fsmonitor.d.ts.map