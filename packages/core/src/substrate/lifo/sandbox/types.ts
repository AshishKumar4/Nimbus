import type { Command } from '../commands/types.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { Kernel } from '../kernel/index.js';
import type { Shell } from '../shell/Shell.js';
import type { ITerminal } from '../terminal/ITerminal.js';
import type { VfsFileType as FileType } from '../../../vfs/vfs.js';
import type { SnapshotInfo, SqliteVFS, VfsDiffEntry, VfsExportChunk, VfsExportPage } from '../../../vfs/sqlite-vfs.js';

// ─── Sandbox Options ───

// ─── Command Execution ───

export interface RunOptions {
  /** Working directory for this command */
  cwd?: string;
  /** Extra environment variables for this command */
  env?: Record<string, string>;
  /** Abort signal to cancel the command */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Streaming stdout callback; bytes, see Shell's ExecuteOptions */
  onStdout?: (data: Uint8Array) => void;
  /** Streaming stderr callback; bytes */
  onStderr?: (data: Uint8Array) => void;
  /** Provide stdin content */
  stdin?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── SandboxCommands ───

export interface SandboxCommands {
  run(cmd: string, options?: RunOptions): Promise<CommandResult>;
  register(name: string, handler: Command): void;
  /**
   * The command table itself, for layering a command set over the defaults.
   * Public because composing a workspace means replacing builtins wholesale —
   * the durable-filesystem coreutils override ~25 of them — and every caller
   * that needed it was already reaching through the private field.
   */
  readonly registry: CommandRegistry;
}

// ─── SandboxFs ───

export interface SandboxFs {
  readFile(path: string): Promise<string>;
  readFile(path: string, encoding: null): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<Array<{ name: string; type: FileType }>>;
  stat(path: string): Promise<{ type: FileType; size: number; mtime: number }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
  cp(src: string, dest: string): Promise<void>;
  writeFiles(files: Array<{ path: string; content: string | Uint8Array }>): Promise<void>;
  // ── The content store (SQLite-rooted; mounts are not in snapshots) ──
  /** Pin the tree under `name`; `quiesce` waits for in-flight writes first. */
  snapshot(name: string, options?: { quiesce?: boolean }): Promise<SnapshotInfo>;
  snapshots(): Promise<SnapshotInfo[]>;
  dropSnapshot(name: string): Promise<{ dropped: number }>;
  /** What changed between two snapshots (null: now), paged, by generation. */
  diff(from: string | null, to: string | null, options?: { after?: string; limit?: number }): Promise<{ entries: VfsDiffEntry[]; next: string | null }>;
  /** The tree at a snapshot, read-only (EROFS). */
  at(name: string): SandboxFsReader;
  /**
   * Put back what `name` pinned (under `subtree`). The session user must be
   * able to write every path it changes, checked before the first change;
   * EACCES names the first one it cannot, and nothing changes.
   */
  restore(name: string, options?: { subtree?: string }): Promise<{ restored: number }>;
  /** One page of a snapshot's tree: rows and chunk hashes, never bytes. */
  exportPage(options: { at: string; root?: string; after?: string | null; limit?: number }): Promise<VfsExportPage>;
  /** The bytes of chunks an importing side wants, bounded per frame. */
  exportChunks(hashes: readonly string[]): Promise<{ chunks: VfsExportChunk[]; rest: string[] }>;
  /** Import a page under `dst`: `want` lists the chunks to send; nothing is written until it is empty. */
  importPage(dst: string, page: VfsExportPage, chunks?: Iterable<VfsExportChunk>): Promise<{ imported: number; want: string[]; done: boolean }>;
  /** A digest of a page's tree, equal across workspaces for equal trees. */
  pageDigest(options: { at: string; root?: string; after?: string | null; limit?: number }): Promise<{ digest: string; next: string | null }>;
  storeStats(): Promise<ReturnType<SqliteVFS['storeStats']>>;
}

/** A read-only tree (a snapshot). */
export interface SandboxFsReader {
  readFile(path: string): Promise<string>;
  readFile(path: string, encoding: null): Promise<Uint8Array>;
  readdir(path: string): Promise<Array<{ name: string; type: FileType }>>;
  stat(path: string): Promise<{ type: FileType; size: number; mtime: number }>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string | Uint8Array): Promise<never>;
}

// ─── Internal types for Sandbox internals ───

export interface SandboxInternals {
  kernel: Kernel;
  shell: Shell;
}
