import type { VfsEvent } from '../vfs/events.js';
export type RuntimeFileType = 'file' | 'directory' | 'symlink';
export interface RuntimeVfsStat {
    type: RuntimeFileType;
    size: number;
    ctime: number;
    mtime: number;
    mode: number;
    revision: number;
}
export interface RuntimeVfsDirEntry {
    name: string;
    type: RuntimeFileType;
}
export interface RuntimeOpenFlags {
    read?: boolean;
    write?: boolean;
    append?: boolean;
    create?: boolean;
    truncate?: boolean;
    followSymlinks?: boolean;
    expectedRevision?: number;
}
export interface RuntimeFileHandle {
    id: number;
    path: string;
    flags: Required<Omit<RuntimeOpenFlags, 'expectedRevision'>> & {
        expectedRevision?: number;
    };
    position: number;
    baseRevision: number;
    closed: boolean;
}
export interface RuntimeFsBridge {
    stat(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<RuntimeVfsStat | null>;
    readFile(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<Uint8Array | null>;
    writeFile(path: string, bytes: string | Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): Promise<void>;
    open(path: string, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle>;
    read(handleId: number, offset: number | null, length: number): Promise<Uint8Array>;
    write(handleId: number, offset: number | null, bytes: Uint8Array): Promise<number>;
    close(handleId: number): Promise<void>;
    readdir(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<RuntimeVfsDirEntry[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    readlink(path: string): Promise<string | null>;
    symlink(target: string, path: string): Promise<void>;
    fsync(handleId?: number): Promise<void>;
    revision(path?: string): Promise<number>;
    subscribe?(path: string, listener: (event: VfsEvent) => void): () => void;
}
export interface RuntimeProcessBridge {
    spawn(command: string, args: string[], options?: {
        cwd?: string;
        env?: Record<string, string>;
        tty?: RuntimeTtyOptions;
    }): Promise<{
        pid: number;
    }>;
    writeStdin(pid: number, bytes: string | Uint8Array): Promise<void>;
    endStdin(pid: number): Promise<void>;
    kill(pid: number, signal?: string): Promise<void>;
    wait(pid: number, timeoutMs?: number): Promise<{
        exitCode: number | null;
    }>;
}
export interface RuntimeTtyOptions {
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
    stderrIsTTY?: boolean;
    columns?: number;
    rows?: number;
    raw?: boolean;
}
export interface RuntimePortBridge {
    register(port: number, processId: number, handler: (request: Request) => Promise<Response>): Promise<void>;
    unregister(port: number, processId?: number): Promise<void>;
    list(): Promise<Array<{
        port: number;
        processId: number;
        registeredAt: number;
    }>>;
}
export type RuntimePackageAbi = 'javascript' | 'wasm32-wasi-nimbus' | 'pyodide' | 'ruby-wasm' | 'native-unsupported';
export interface RuntimeCommandProvider {
    runtimeName: string;
    version: string;
    abi: RuntimePackageAbi;
    commands: string[];
    packageManagers?: string[];
    libraries?: string[];
}
export type RuntimeDiagnosticEvent = {
    type: 'fs-cache';
    hit: boolean;
    path: string;
    bytes?: number;
    revision?: number;
} | {
    type: 'fs-flush';
    path?: string;
    bytes: number;
    durationMs: number;
} | {
    type: 'fs-invalidation';
    path: string;
    revision: number;
    lagMs?: number;
} | {
    type: 'unsupported-abi';
    packageName?: string;
    abi: string;
    message: string;
};
//# sourceMappingURL=os-contracts.d.ts.map