/**
 * Read-only directory prefetch is an account of real descriptions, not
 * another descriptor table. All I/O uses the process's existing bridge;
 * its DescriptorScope remains the only owner, including on release/kill.
 */
import { z } from 'zod';
import type { Awaitable, RuntimeFileHandle, RuntimeFsBridge, RuntimeFsPath, VfsAcquireResult } from './os-contracts.js';
export declare const DIRECTORY_READ_RPC: "fsReadDirectories";
declare const Request: z.ZodObject<{
    channel: z.ZodString;
    sequence: z.ZodNumber;
    position: z.ZodNullable<z.ZodPipe<z.ZodObject<{
        table: z.ZodString;
        feeds: z.ZodRecord<z.ZodString, z.ZodObject<{
            epoch: z.ZodString;
            cursor: z.ZodNumber;
            fixed: z.ZodOptional<z.ZodLiteral<true>>;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodTransform<import("./feed-position.js").FeedPosition, {
        table: string;
        feeds: Record<string, {
            epoch: string;
            cursor: number;
            fixed?: true | undefined;
        }>;
    }>>>;
    open: z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        directory: z.ZodNumber;
        path: z.ZodString;
        beneath: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
        root: z.ZodString;
        path: z.ZodString;
        beneath: z.ZodLiteral<true>;
    }, z.core.$strip>]>>;
    retire: z.ZodArray<z.ZodNumber>;
    claim: z.ZodArray<z.ZodNumber>;
    lease: z.ZodBoolean;
    end: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type ReadDirectoryBatchRequest = z.infer<typeof Request>;
export interface ReadDirectoryDescription {
    /** Null when canonical namespace placement does not permit a local answer. */
    readonly key: string | null;
    readonly handle: RuntimeFileHandle;
    /** Identity only: local fstat must use the final admitted namespace, not a stat taken earlier in the batch. */
    readonly dev: number;
    readonly ino: number;
    /**
     * What the authority's access check saw of the directory before it opened
     * it (its mode, owner, group and ctime: a chmod, chown or ACL change moves
     * ctime too); null if the name changed identity meanwhile. A store entry
     * showing the same identity and the same of these would be granted the
     * same open now. (Not a revision: a directory's revision is its subtree's,
     * which a change anywhere below it moves.)
     */
    readonly opened: OpenedAs | null;
}
export interface OpenedAs {
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
    readonly ctime: number;
}
export interface ReadDirectoryBatchResult {
    readonly channel: string;
    readonly sequence: number;
    readonly opened: readonly ReadDirectoryDescription[];
    readonly retired: readonly number[];
    readonly claimed: readonly number[];
    readonly outstanding: number;
    readonly acquire: VfsAcquireResult;
}
export interface ReadDirectorySupervisor {
    fsReadDirectories(request: ReadDirectoryBatchRequest): Promise<ReadDirectoryBatchResult>;
}
/** The process's DescriptorScope (descriptors.ts), as far as this account needs it. */
interface Scope {
    readonly closed: boolean;
    readonly subscriptions: Set<() => void>;
}
interface Binding {
    readonly scope: Scope;
    readonly place: (path: RuntimeFsPath, handle: RuntimeFileHandle) => Awaitable<string | null>;
}
/** Called only by ProcessFiles where each face is bound to its actual descriptor scope. */
export declare function registerDirectoryReadBridge(fs: RuntimeFsBridge, scope: Scope, place: Binding['place']): void;
/** A normal close also retires a prefetched handle's accounting. */
export declare function directoryReadHandleClosed(scope: Scope, id: number): void;
export declare function hasDirectoryReadBridge(fs: RuntimeFsBridge): boolean;
/**
 * Must be delivered once. Its cached answer keeps the ORIGINAL client's
 * ask time: replaying it never renews lease trust. IDs from an abandoned
 * answer remain charged until a later channel exchange or scope teardown.
 */
export declare function readDirectoryBatch(fs: RuntimeFsBridge, input: unknown): Promise<ReadDirectoryBatchResult>;
export {};
//# sourceMappingURL=read-directory-batch.d.ts.map