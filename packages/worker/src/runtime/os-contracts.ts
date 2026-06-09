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

export type RuntimePackageAbi =
  | 'javascript'
  | typeof NIMBUS_ABI_TARGET
  | 'pyodide-emscripten-2025_0-wasm32'
  | 'py3-none-any'
  | 'python-source-pure'
  | 'pyodide'
  | 'ruby-wasm'
  | 'native-unsupported';

export const NIMBUS_RUNTIME_ABIS: Readonly<Record<string, RuntimePackageAbi>> = Object.freeze({
  clang: NIMBUS_ABI_TARGET,
  python: 'pyodide',
  ruby: 'ruby-wasm',
  node: 'javascript',
  bun: 'javascript',
});

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
