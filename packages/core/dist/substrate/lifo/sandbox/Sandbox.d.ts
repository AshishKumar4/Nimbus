import { Kernel } from '../kernel/index.js';
import { Shell } from '../shell/Shell.js';
import type { NativeFsModule } from '../kernel/vfs/providers/NativeFsProvider.js';
import type { SandboxOptions, SandboxCommands, SandboxFs } from './types.js';
export declare class Sandbox {
    /** Programmatic command execution */
    readonly commands: SandboxCommands;
    /** Filesystem operations */
    readonly fs: SandboxFs;
    /** Environment variables */
    readonly env: Record<string, string>;
    readonly kernel: Kernel;
    readonly shell: Shell;
    private _destroyed;
    private constructor();
    /** Current working directory */
    get cwd(): string;
    set cwd(path: string);
    /**
     * Create a new Sandbox instance.
     * Orchestrates all boot steps: Kernel, VFS, Registry, Shell, config sourcing.
     */
    static create(options?: SandboxOptions): Promise<Sandbox>;
    /**
     * Mount a native filesystem directory into the virtual filesystem.
     * Only works in Node.js environments (or when a custom fsModule is provided).
     *
     * Once mounted, all VFS operations (and therefore the node-compat fs shim)
     * on paths under `virtualPath` will be delegated through the VFS mount system
     * to the NativeFsProvider, which in turn delegates to the real node:fs module.
     *
     * @param virtualPath - Path inside the virtual filesystem (e.g. "/mnt/project")
     * @param hostPath - Host filesystem path to mount (e.g. "/home/user/my-project")
     * @param options - Optional settings: readOnly, fsModule
     */
    mountNative(virtualPath: string, hostPath: string, options?: {
        readOnly?: boolean;
        fsModule?: NativeFsModule;
    }): void;
    /**
     * Unmount a previously mounted filesystem.
     *
     * @param virtualPath - The virtual path that was passed to mountNative()
     */
    unmountNative(virtualPath: string): void;
    /**
     * Export the entire VFS as a tar.gz snapshot.
     */
    exportSnapshot(): Promise<Uint8Array>;
    /**
     * Restore VFS from a tar.gz snapshot.
     */
    importSnapshot(data: Uint8Array): Promise<void>;
    /**
     * Destroy the sandbox, releasing all resources.
     */
    destroy(): void;
}
//# sourceMappingURL=Sandbox.d.ts.map