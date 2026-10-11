/**
 * Read-only directory prefetch is an account of real descriptions, not
 * another descriptor table. All I/O uses the process's existing bridge;
 * its DescriptorScope remains the only owner, including on release/kill.
 */
import { z } from 'zod';
import type { Awaitable, RuntimeFileHandle, RuntimeFsBridge, RuntimeFsPath, VfsAcquireResult } from './os-contracts.js';
export declare const DIRECTORY_PREFETCH_LIMIT = 64;
export declare const DIRECTORY_BATCH_LIMIT = 32;
export declare const DIRECTORY_READ_RPC: "fsReadDirectories";
declare const Request: z.ZodObject<{
    channel: z.ZodString;
    sequence: z.ZodNumber;
    epoch: z.ZodNullable<z.ZodString>;
    cursor: z.ZodNumber;
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
}, z.core.$strip>;
export type ReadDirectoryBatchRequest = z.infer<typeof Request>;
export interface ReadDirectoryDescription {
    /** Null when canonical namespace placement does not permit a local answer. */
    readonly key: string | null;
    readonly handle: RuntimeFileHandle;
    /** Identity only: local fstat must use the final admitted namespace, not a stat taken earlier in the batch. */
    readonly dev: number;
    readonly ino: number;
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
interface Scope {
    readonly closed: boolean;
}
interface Channel {
    sequence: number;
}
interface Tracked {
    readonly channel: string;
    claimed: boolean;
}
interface Budget {
    ended: boolean;
    reserved: number;
    readonly channels: Map<string, Channel>;
    readonly tracked: Map<number, Tracked>;
    tail: Promise<void>;
}
interface Binding {
    readonly scope: Scope;
    readonly budget: Budget;
    readonly place: (path: RuntimeFsPath, handle: RuntimeFileHandle) => Awaitable<string | null>;
}
/** Called only by ProcessFiles where each face is bound to its actual descriptor scope. */
export declare function registerDirectoryReadBridge(fs: RuntimeFsBridge, scope: Scope, place: Binding['place']): void;
/** A normal close also retires a prefetched handle's accounting. */
export declare function directoryReadHandleClosed(scope: Scope, id: number): void;
/** The authoritative scope closes descriptions; drop accounting at that same lifetime boundary. */
export declare function disposeDirectoryReadScope(scope: Scope): void;
export declare function hasDirectoryReadBridge(fs: RuntimeFsBridge): boolean;
/**
 * Must be delivered once. Its cached answer keeps the ORIGINAL client's
 * ask time: replaying it never renews lease trust. IDs from an abandoned
 * answer remain charged until a later channel exchange or scope teardown.
 */
export declare function readDirectoryBatch(fs: RuntimeFsBridge, input: unknown): Promise<ReadDirectoryBatchResult>;
export {};
//# sourceMappingURL=read-directory-batch.d.ts.map