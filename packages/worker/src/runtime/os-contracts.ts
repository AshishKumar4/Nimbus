import type { VfsEvent } from '../vfs/events.js';

export type RuntimeFileType = 'file' | 'directory' | 'symlink';

export interface RuntimeVfsStat {
  type: RuntimeFileType;
  size: number;
  ctime: number;
  atime: number;
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
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeVfsStat | null>;
  readFile(path: string, options?: { followSymlinks?: boolean }): Promise<Uint8Array | null>;
  writeFile(path: string, bytes: string | Uint8Array, options?: {
    createParents?: boolean;
    expectedRevision?: number;
  }): Promise<void>;
  utimes(path: string, atimeMs: number, mtimeMs: number, options?: { followSymlinks?: boolean }): Promise<void>;
  open(path: string, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle>;
  read(handleId: number, offset: number | null, length: number): Promise<Uint8Array>;
  write(handleId: number, offset: number | null, bytes: Uint8Array): Promise<number>;
  close(handleId: number): Promise<void>;
  readdir(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeVfsDirEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
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
  }): Promise<{ pid: number }>;
  writeStdin(pid: number, bytes: string | Uint8Array): Promise<void>;
  endStdin(pid: number): Promise<void>;
  kill(pid: number, signal?: string): Promise<void>;
  wait(pid: number, timeoutMs?: number): Promise<{ exitCode: number | null }>;
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
  list(): Promise<Array<{ port: number; processId: number; registeredAt: number }>>;
}

export const NIMBUS_OS_NAME = 'nimbus';
export const NIMBUS_ABI_TARGET = 'wasm32-wasi-nimbus';
export const NIMBUS_ABI_ID = NIMBUS_ABI_TARGET;

/** Canonical Pyodide package artifact ABI label. The single source of
 *  truth for the label — runtime manifests, the pip planner, and
 *  diagnostics all consume this constant. */
export const PYODIDE_PACKAGE_ABI = 'pyodide-emscripten-2025_0-wasm32';

/** Canonical artifact class for native platform binaries Nimbus cannot
 *  execute (Linux/Windows/macOS executables, .node bindings, native
 *  wheels/gems). */
export const NATIVE_UNSUPPORTED_ABI = 'native-unsupported';

export type RuntimePackageAbi =
  | 'javascript'
  | typeof NIMBUS_ABI_TARGET
  | typeof PYODIDE_PACKAGE_ABI
  | 'py3-none-any'
  | 'python-source-pure'
  | 'pyodide'
  | 'ruby-wasm'
  | typeof NATIVE_UNSUPPORTED_ABI;

export const NIMBUS_RUNTIME_ABIS: Readonly<Record<string, RuntimePackageAbi>> = Object.freeze({
  clang: NIMBUS_ABI_TARGET,
  python: 'pyodide',
  ruby: 'ruby-wasm',
  node: 'javascript',
  bun: 'javascript',
});

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

export type RuntimeAbiCapability =
  | 'wasi.snapshot-preview1'
  | 'wasi.unstable-import-alias'
  | 'vfs.snapshot-diff'
  | 'stdio'
  | 'argv'
  | 'env'
  | 'clock'
  | 'random'
  | 'path'
  | 'symlink'
  | 'hardlink'
  | 'poll'
  | 'outbound-tcp-devtcp';

export interface RuntimeAbiDescriptor {
  os: typeof NIMBUS_OS_NAME;
  target: typeof NIMBUS_ABI_TARGET;
  id: typeof NIMBUS_ABI_ID;
  env: Readonly<Record<string, string>>;
  capabilities: readonly RuntimeAbiCapability[];
}

export const WASM32_WASI_NIMBUS_ABI: RuntimeAbiDescriptor = {
  os: NIMBUS_OS_NAME,
  target: NIMBUS_ABI_TARGET,
  id: NIMBUS_ABI_ID,
  env: Object.freeze({
    NIMBUS_OS: NIMBUS_OS_NAME,
    NIMBUS_ABI: NIMBUS_ABI_ID,
    NIMBUS_ABI_TARGET,
  }),
  capabilities: Object.freeze([
    'wasi.snapshot-preview1',
    'wasi.unstable-import-alias',
    'vfs.snapshot-diff',
    'stdio',
    'argv',
    'env',
    'clock',
    'random',
    'path',
    'symlink',
    'hardlink',
    'poll',
    'outbound-tcp-devtcp',
  ]),
};

export interface RuntimeCommandProvider {
  runtimeName: string;
  version: string;
  abi: RuntimePackageAbi;
  commands: string[];
  packageManagers?: string[];
  libraries?: string[];
}

export type RuntimeDiagnosticEvent =
  | { type: 'fs-cache'; hit: boolean; path: string; bytes?: number; revision?: number }
  | { type: 'fs-flush'; path?: string; bytes: number; durationMs: number }
  | { type: 'fs-invalidation'; path: string; revision: number; lagMs?: number }
  | { type: 'unsupported-abi'; packageName?: string; abi: string; message: string };
