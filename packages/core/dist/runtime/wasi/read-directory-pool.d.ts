import type { ProcessFsClient } from '../../_shared/process-fs-client.js';
import type { RuntimeFileHandle, RuntimeFsPath, VfsAcquireResult } from '../os-contracts.js';
import type { ReadDirectoryBatchRequest, ReadDirectoryBatchResult } from '../read-directory-batch.js';
import type { ResidentEntry } from './resident-filesystem.js';
export interface DirectoryPoolStore {
    ready(): boolean;
    cursor(): {
        epoch: string;
        rev: number;
    } | null;
    admit(answer: VfsAcquireResult): Promise<boolean>;
    entry(key: string): ResidentEntry | null | undefined;
}
interface Options {
    readonly call: (request: ReadDirectoryBatchRequest) => Promise<ReadDirectoryBatchResult>;
    readonly store: DirectoryPoolStore;
    readonly client: ProcessFsClient;
    /** Publish the caller's pending writes before recording the original lease ask. */
    readonly before: () => Promise<void>;
}
export interface ReadDirectoryPool {
    open(path: RuntimeFsPath, key: string, prefetch: () => Promise<readonly RuntimeFsPath[]>): Promise<RuntimeFileHandle | null>;
    owns(id: number): boolean;
    closed(id: number): boolean;
    local(id: number): {
        key: string;
        entry: ResidentEntry;
    } | null;
    close(id: number): void | Promise<void>;
    /** Only call where a real supervisor/store I/O reply arrived; timers never establish trust. */
    io(): void;
    invalidate(): void;
    /** A park timed out: late, not-yet-delivered descriptions are abandoned, never installed into the guest fd table. */
    cancelPending(): void;
    pending(): boolean;
    flush(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function readDirectoryPool({ call, store, client, before }: Options): ReadDirectoryPool;
export {};
//# sourceMappingURL=read-directory-pool.d.ts.map