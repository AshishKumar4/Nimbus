import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { VFS } from '../substrate/lifo/kernel/vfs/index.js';
import { type NimbusFilesystemAuthority, type NimbusFilesystemBinding, type NimbusHostFilesystemLease, type RuntimeFsBridge, type VfsCred } from './os-contracts.js';
/** The default authority owns descriptor scopes, not the host's database lifetime. */
export declare class SqliteFilesystemAuthority implements NimbusFilesystemAuthority {
    readonly vfs: SqliteVFS;
    private kernel?;
    readonly namespace: string;
    private readonly processes;
    private readonly retired;
    /** The disk this authority credentials; a host composing over the same
     *  session reads it here instead of tracking a second reference. */
    constructor(vfs: SqliteVFS, kernel?: VFS | undefined);
    attachKernel(kernel: VFS): void;
    bind({ pid, cred, signal }: NimbusFilesystemBinding): RuntimeFsBridge;
    openHost(cred: Readonly<VfsCred>, options?: {
        signal?: AbortSignal;
    }): NimbusHostFilesystemLease;
    releaseProcess(pid: number): Promise<void>;
    activateAppendWriter(pid: number, writerId: string): Promise<void>;
    revokeAppendWriter(pid: number, writerId: string): Promise<void>;
    revokeAppendWriters(pid: number): Promise<void>;
    revokeAppendWritersThrough(maxPid: number): Promise<void>;
    private closeScope;
    private view;
}
//# sourceMappingURL=filesystem-authority.d.ts.map