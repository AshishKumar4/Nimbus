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
    /** How long dispose waits for the channel's last exchange (DIRECTORY_END_WAIT_MS). */
    readonly endWaitMs?: number;
}
export interface ReadDirectoryPool {
    open(path: RuntimeFsPath, key: string, prefetch: () => Promise<readonly RuntimeFsPath[]>): Promise<RuntimeFileHandle | null>;
    owns(id: number): boolean;
    closed(id: number): boolean;
    local(id: number): {
        key: string;
        entry: ResidentEntry;
    } | null;
    /** `wait`: a close that may wait for the session retires what is queued when the queue is full; one that cannot queues it. */
    close(id: number, wait?: boolean): void | Promise<void>;
    /** Only call where a real supervisor/store I/O reply arrived; timers never establish trust. */
    io(): void;
    /**
     * The store may be behind (the process's own change, input): nothing is
     * claimed until a batch's answer is admitted, and then each prediction only
     * if the store still shows the directory it opened. None is retired for it.
     */
    invalidate(): void;
    /** A park timed out: late, not-yet-delivered descriptions are abandoned, never installed into the guest fd table. */
    cancelPending(): void;
    /**
     * The run ended: every description the pool accounts for is retired. A
     * shell's commands share its pid, and so its descriptor scope: a run
     * cannot leave them to the scope's release.
     */
    dispose(): Promise<void>;
}
export declare function readDirectoryPool({ call, store, client, before, endWaitMs }: Options): ReadDirectoryPool;
export {};
//# sourceMappingURL=read-directory-pool.d.ts.map