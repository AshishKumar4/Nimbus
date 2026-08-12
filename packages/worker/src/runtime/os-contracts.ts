import type { VfsEvent } from '../vfs/events.js';

/**
 * A value SQLite can return in a row.
 *
 * `ArrayBufferView` is in the union because the host decides the blob
 * representation and the hosts disagree: workerd's SqlStorage hands back an
 * `ArrayBuffer`, `bun:sqlite` and `better-sqlite3` hand back a `Uint8Array`.
 * Both are read through `blobToUint8Array`, which has always accepted either.
 */
export type SqlValue = ArrayBuffer | ArrayBufferView | string | number | bigint | null;

export type SqlRow = Record<string, SqlValue>;

/**
 * The whole of the SQL surface the Nimbus filesystem needs.
 *
 * One method, because that is what the filesystem actually calls — 88 sites,
 * all `exec`, all consuming the result by spreading it. workerd's `SqlStorage`
 * satisfies this structurally, so the Durable Object path passes
 * `ctx.storage.sql` unchanged and pays nothing for the indirection.
 *
 * NOT named `SqlStorage`, deliberately. That name is an ambient global from
 * `@cloudflare/workers-types`: a port sharing it would still resolve in any
 * file that forgot the import, silently re-binding to workerd's type while
 * appearing decoupled. A distinct name makes the choice visible at the import.
 */
export interface SqlDatabase {
  exec(query: string, ...bindings: unknown[]): Iterable<SqlRow>;
}

/**
 * Synchronous, all-or-nothing grouping of `exec` calls.
 *
 * Separate from {@link NimbusSqlDatabase} because it is a property of the
 * STORE, not of the statement runner, and because hosts expose it apart from
 * `exec`: workerd puts it on `ctx.storage`, `bun:sqlite` builds one with
 * `db.transaction(fn)`. The filesystem's atomicity guarantees rest entirely on
 * this being a real transaction — an implementation that merely calls the
 * callback silently converts every atomic write into a torn one.
 */
export interface SqlTransactions {
  transactionSync<T>(callback: () => T): T;
}

/** Host object carrying the transaction primitive (workerd: `ctx`). */
export interface TransactionHost {
  readonly storage?: SqlTransactions;
}

export interface VfsCred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
  readonly umask: number;
}

export const CRED_KERNEL: VfsCred = Object.freeze({
  uid: 0,
  gid: 0,
  groups: Object.freeze([0]),
  umask: 0o022,
});

/**
 * The session's unprivileged login identity — `user` in /etc/passwd, the
 * credential every process inherits unless it deliberately transitions.
 *
 * It is also the credential the embedder-facing surfaces act with: the SDK
 * filesystem API, the remote `/rpc` file ops, and the static asset server are
 * host callers, not processes, and files they create must be owned by the same
 * identity `exec` runs as. Never CRED_KERNEL — a pid-less caller must never
 * gain more authority than the shell it is writing files for.
 */
export const CRED_SESSION_USER: VfsCred = Object.freeze({
  uid: 1000,
  gid: 1000,
  groups: Object.freeze([1000]),
  umask: 0o022,
});

export function requireVfsCred(value: unknown, source: string): VfsCred {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${source} requires process credentials`);
  }
  const uid = 'uid' in value ? value.uid : undefined;
  const gid = 'gid' in value ? value.gid : undefined;
  const groups = 'groups' in value ? value.groups : undefined;
  const umask = 'umask' in value ? value.umask : undefined;
  if (
    typeof uid !== 'number' || !Number.isInteger(uid)
    || typeof gid !== 'number' || !Number.isInteger(gid)
    || !Array.isArray(groups)
    || typeof umask !== 'number' || !Number.isInteger(umask)
  ) {
    throw new Error(`${source} requires process credentials`);
  }
  const normalizedGroups: number[] = [];
  for (const group of groups) {
    if (typeof group !== 'number' || !Number.isInteger(group)) {
      throw new Error(`${source} requires process credentials`);
    }
    normalizedGroups.push(group);
  }
  return {
    uid,
    gid,
    groups: normalizedGroups,
    umask,
  };
}

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
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeVfsStat | null>;
  readFile(path: string, options?: { followSymlinks?: boolean }): Promise<Uint8Array | null>;
  /**
   * Whole-file write. Returns the revision the write produced, so a caller
   * holding the bytes it just sent can tell its own mutation apart from a
   * peer's when {@link RuntimeFsBridge.acquire} reports the path back.
   */
  writeFile(path: string, bytes: string | Uint8Array, options?: {
    createParents?: boolean;
    expectedRevision?: number;
  }): Promise<number>;
  /** Stateless ranged read: clamped at EOF; null when the path is absent. */
  readRange(path: string, offset: number, length: number, options?: { followSymlinks?: boolean }): Promise<Uint8Array | null>;
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
  truncate(path: string, size: number, options?: { followSymlinks?: boolean }): Promise<void>;
  utimes(path: string, atimeMs: number, mtimeMs: number, options?: { followSymlinks?: boolean }): Promise<void>;
  /** Set permission bits (POSIX chmod — follows symlinks). */
  chmod(path: string, mode: number): Promise<void>;
  /** Check access using the bridge's process credential. */
  access(path: string, mode: number): Promise<void>;
  /** Change stored ownership, optionally operating on a symlink itself. */
  chown(path: string, uid: number, gid: number, options?: { followSymlinks?: boolean }): Promise<void>;
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
  /**
   * Without a path: the global VFS mutation watermark. With a path: a
   * per-path subtree watermark — it changes iff that path or anything
   * under it mutated, so consumers can cache without global invalidation.
   */
  revision(path?: string): Promise<number>;
  /**
   * The cache-coherence barrier. A caller holding a resident cache stamped
   * at `(epoch, cursor)` gets back every path mutated since, and re-stamps.
   *
   * `poison` means the view cannot be repaired incrementally — a different
   * supervisor incarnation, or a cursor older than the retained log — and
   * the caller must drop its entire resident set. That costs a cold cache;
   * the alternative would be serving a stale byte.
   */
  acquire(epoch: string | null, cursor: number): Promise<VfsAcquireResult>;
  /**
   * Enumerate every path this bridge's credential can see, one bounded page at
   * a time, resuming past `after`.
   *
   * {@link RuntimeFsBridge.acquire} tells a caller what CHANGED; this tells it
   * what EXISTS. A resident cache can be kept coherent with the barrier alone,
   * but it can only be made COMPLETE with this: every map a process is shipped
   * describes what it was GIVEN, so a cache enumerated from them can never
   * hold a path that was not already staged.
   */
  list(after?: string | null, limit?: number): Promise<VfsListPage>;
  subscribe?(path: string, listener: (event: VfsEvent) => void): () => void;
}

/**
 * One path in an {@link RuntimeFsBridge.acquire} delta, with the revision it
 * was last mutated at. The revision is what makes the delta usable by the
 * process that caused it: a caller holding the revision its own write
 * produced keeps that cell, while a peer's later write to the same path
 * reports a higher revision and still invalidates.
 */
export interface VfsInvalidatedPath {
  path: string;
  rev: number;
}

/** Result of a {@link RuntimeFsBridge.acquire} barrier. */
export interface VfsAcquireResult {
  epoch: string;
  rev: number;
  paths: VfsInvalidatedPath[];
  poison: boolean;
}

/**
 * One path in a {@link RuntimeFsBridge.list} page.
 *
 * `size` is here because the only consumer of an enumeration is a filler that
 * must then FETCH the bytes, and every batch read is bounded by a byte total
 * the caller has to compute before it asks. A list without sizes forces a stat
 * per path just to pack a request — the round trip the enumeration exists to
 * remove.
 *
 * `rev` is the path's own last-mutation revision for a file and a subtree
 * watermark for a directory ({@link RuntimeFsBridge.revision} semantics
 * unchanged). It is what lets a cached row be DATED, and an undated row is
 * exactly the row that can never be invalidated.
 */
export interface VfsListEntry {
  path: string;
  kind: RuntimeFileType;
  size: number;
  rev: number;
}

/**
 * One page of {@link RuntimeFsBridge.list}.
 *
 * `next` is the resume key, and `null` means the listing is COMPLETE. That
 * distinction is the contract: a caller that cannot tell a truncated page from
 * a finished one treats a partial filesystem as the whole one — the same class
 * of defect as reading a truncated file as a complete one, which is why
 * `_rpcFsReadBatch` rejects rather than truncates.
 *
 * `epoch`/`rev` are read BEFORE the page is walked, for the same reason
 * `buildPrefetchBundle` reads its cursor before its walk: a mutation landing
 * during enumeration must be reported by the next ACQUIRE, never silently
 * missed. Dating rows at a cursor OLDER than their bytes costs a refetch;
 * dating them newer would serve a stale byte.
 */
export interface VfsListPage {
  epoch: string;
  rev: number;
  entries: VfsListEntry[];
  next: string | null;
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

/**
 * Where a registered port's traffic goes: one process, reached by HTTP.
 *
 * The whole of what a listening process exposes, deliberately. A resident
 * process never receives a WebSocket — every inbound socket Nimbus serves
 * terminates on the session and reaches the process, if at all, as events on a
 * poll — so a target that could return a 101 would describe a case no runner
 * produces.
 *
 * Lives here rather than beside the registry because both ends need it and
 * neither owns it: the port registry stores these, and the process fabric
 * hands one back for every resident process it starts. Defining it in either
 * would make the other import a peer's internals to name its own contract.
 */
export interface RouteableFacetTarget {
  handleHttpRequest(request: Request): Promise<Response>;
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
  bash: NIMBUS_ABI_TARGET,
  clang: NIMBUS_ABI_TARGET,
  python: 'pyodide',
  // The wasm32-wasi interpreter. It does have compiled packages — numpy, and
  // markupsafe's speedups — but they are linked into a prebuilt interpreter
  // variant rather than loaded at run time, so no wheel carrying a native
  // extension can be installed. See packages/worker/wasm/python/EXTENSIONS.md.
  cpython: NATIVE_UNSUPPORTED_ABI,
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
  | 'outbound-tcp-devtcp'
  | 'wasi.threads';

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
    // Cooperative, correct, and not parallel — see runtime/wasi-threads.ts.
    'wasi.threads',
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
