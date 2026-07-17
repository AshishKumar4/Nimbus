import type { VfsEvent } from '../vfs/events.js';
export interface VfsCred {
    readonly uid: number;
    readonly gid: number;
    readonly groups: readonly number[];
    readonly umask: number;
}
export declare const CRED_KERNEL: VfsCred;
export declare function requireVfsCred(value: unknown, source: string): VfsCred;
export type RuntimeFileType = 'file' | 'directory' | 'symlink';
export interface RuntimeVfsStat {
    type: RuntimeFileType;
    size: number;
    ctime: number;
    atime: number;
    mtime: number;
    mode: number;
    uid: number;
    gid: number;
    /** Per-path revision: changes iff this path (or its subtree) mutated. */
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
    /** Stateless ranged read: clamped at EOF; null when the path is absent. */
    readRange(path: string, offset: number, length: number, options?: {
        followSymlinks?: boolean;
    }): Promise<Uint8Array | null>;
    /**
     * Stateless ranged write: updates only the chunks the range touches
     * (never a whole-file rewrite), zero-filling any gap past EOF.
     * Creates the file when missing. Returns bytes written.
     */
    writeRange(path: string, offset: number, bytes: Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): Promise<number>;
    /** Truncate or zero-extend to `size`, touching only the boundary chunk. */
    truncate(path: string, size: number, options?: {
        followSymlinks?: boolean;
    }): Promise<void>;
    utimes(path: string, atimeMs: number, mtimeMs: number, options?: {
        followSymlinks?: boolean;
    }): Promise<void>;
    /** Set permission bits (POSIX chmod — follows symlinks). */
    chmod(path: string, mode: number): Promise<void>;
    /** Check access using the bridge's process credential. */
    access(path: string, mode: number): Promise<void>;
    /** Change stored ownership, optionally operating on a symlink itself. */
    chown(path: string, uid: number, gid: number, options?: {
        followSymlinks?: boolean;
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
    /**
     * Without a path: the global VFS mutation watermark. With a path: a
     * per-path subtree watermark — it changes iff that path or anything
     * under it mutated, so consumers can cache without global invalidation.
     */
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
export declare const NIMBUS_OS_NAME = "nimbus";
export declare const NIMBUS_ABI_TARGET = "wasm32-wasi-nimbus";
export declare const NIMBUS_ABI_ID = "wasm32-wasi-nimbus";
/** Canonical Pyodide package artifact ABI label. The single source of
 *  truth for the label — runtime manifests, the pip planner, and
 *  diagnostics all consume this constant. */
export declare const PYODIDE_PACKAGE_ABI = "pyodide-emscripten-2025_0-wasm32";
/** Canonical artifact class for native platform binaries Nimbus cannot
 *  execute (Linux/Windows/macOS executables, .node bindings, native
 *  wheels/gems). */
export declare const NATIVE_UNSUPPORTED_ABI = "native-unsupported";
export type RuntimePackageAbi = 'javascript' | typeof NIMBUS_ABI_TARGET | typeof PYODIDE_PACKAGE_ABI | 'py3-none-any' | 'python-source-pure' | 'pyodide' | 'ruby-wasm' | typeof NATIVE_UNSUPPORTED_ABI;
export declare const NIMBUS_RUNTIME_ABIS: Readonly<Record<string, RuntimePackageAbi>>;
/** Name-to-name package rewrite at the resolver/installer boundary. */
export interface PackageSwapEntry {
    /** Original package name the user (or a transitive dep) asked for. */
    from: string;
    /** Package name we install instead. */
    to: string;
    /** One-line reason shown to the user. */
    reason: string;
    /**
     * 'drop-in' = `require(from)` and `require(to)` work identically — same
     *             export shape.
     * 'shim'    = (reserved) we write package.json `dependencies` so consumer
     *             imports `from`, gets `to`.
     * 'manual'  = (reserved) consumer code change required. Demoted to
     *             rejects because listing it here would silently break
     *             user code.
     */
    compat: 'drop-in' | 'shim' | 'manual';
}
/**
 * Staged-artifact entry: a package whose only published runnable form is a
 * platform-native binary (so it would otherwise hit the native-artifact
 * reject), but for which Nimbus ships a prebuilt JS/WASM bundle in the
 * static-assets layer. At resolve time the package's native shards
 * (optionalDependencies) and lifecycle scripts are dropped and its `bin` is
 * rewritten to a Nimbus shim that loads the staged bundle.
 */
export interface PackageStagedArtifactEntry {
    /** Package name the user installs (e.g. `opencode-ai`). */
    from: string;
    /** Bin name the staged artifact provides (e.g. `opencode`). */
    bin: string;
    /** Stable artifact id the node runtime resolves to a staged asset path. */
    artifact: string;
    /** One-line reason shown to the user. */
    reason: string;
}
/** Deny-list entry with a helpful, always-actionable message. */
export interface PackageRejectEntry {
    from: string;
    reason: string;
    /** Optional swap-target suggestion shown inline. */
    suggest?: string;
    /**
     * 'fail' = hard-fail at any depth.
     * 'warn' = top-level hard-fails; transitive logs `[skip]` and drops the
     *          package from the resolved tree (matches genuinely-optional
     *          natives like fsevents).
     */
    transitive: 'fail' | 'warn';
}
/**
 * The one typed package-ABI policy. Defined once in supervisor code
 * (`facets/wasm-swap-registry.ts: PACKAGE_ABI_POLICY`) and serialized
 * verbatim into resolver/loader facet preambles — generated dynamic
 * Workers cannot import supervisor modules, so the policy travels as
 * JSON plus serialized policy functions. The preamble parity unit test
 * (`tests/unit/package-abi-policy.mjs`) extracts the injected policy and
 * asserts equality with this object so the two can never drift.
 */
export interface PackageAbiPolicy {
    /** Public compiled-artifact target string (`wasm32-wasi-nimbus`). */
    abiTarget: typeof NIMBUS_ABI_TARGET;
    /** Artifact classes Nimbus can install and execute. */
    acceptedArtifactClasses: readonly RuntimePackageAbi[];
    /** Artifact class assigned to rejected native platform artifacts. */
    nativeArtifactClass: typeof NATIVE_UNSUPPORTED_ABI;
    /** Drop-in name rewrites (native package → published WASM build). */
    swaps: readonly PackageSwapEntry[];
    /** Native-only packages Nimbus ships a prebuilt JS/WASM artifact for. */
    stagedArtifacts: readonly PackageStagedArtifactEntry[];
    /** Known-native deny list with per-entry transitive policy. */
    rejects: readonly PackageRejectEntry[];
    /** Build-only packages skipped at transitive depth. */
    skipPackages: readonly string[];
    /** Build-only package name prefixes skipped at transitive depth. */
    skipPrefixes: readonly string[];
    /** Packages exempted from skipPackages when a framework needs them. */
    frameworkRequiredPackages: readonly string[];
    /** Known native-shard name globs, matched as `prefix-…`. */
    nativeShardPrefixes: readonly string[];
    /** Exact names exempted from nativeShardPrefixes (pure WASM builds). */
    nativeShardExemptions: readonly string[];
    /** bin-target file extensions that mark a native executable. */
    nativeBinExtensions: readonly string[];
}
export type RuntimeAbiCapability = 'wasi.snapshot-preview1' | 'wasi.unstable-import-alias' | 'vfs.snapshot-diff' | 'stdio' | 'argv' | 'env' | 'clock' | 'random' | 'path' | 'symlink' | 'hardlink' | 'poll' | 'outbound-tcp-devtcp';
export interface RuntimeAbiDescriptor {
    os: typeof NIMBUS_OS_NAME;
    target: typeof NIMBUS_ABI_TARGET;
    id: typeof NIMBUS_ABI_ID;
    env: Readonly<Record<string, string>>;
    capabilities: readonly RuntimeAbiCapability[];
}
export declare const WASM32_WASI_NIMBUS_ABI: RuntimeAbiDescriptor;
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