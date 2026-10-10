/**
 * git/pack/buffered-fs.ts — the git network facet's filesystem: cf-git's
 * writes buffered as records for the wave writer (@nimbus-sh/platform
 * wave-writer.ts), which publishes them in W7 waves, one in flight while the
 * next buffers; its reads answered from the buffer, from the closed-world
 * metadata overlay a clone reads back, or from the supervisor.
 *
 * With a worktreeRoot (fetch, pull, push in an existing repository) the
 * writer writes that worktree the way git's checkout does (entry.c
 * create_directories, has_symlink_leading_path): below its top, .git aside,
 * a leading component that is not a real directory (a link, dangling or
 * not, or a file) is deleted and replaced by a directory rather than
 * followed, and a file replaces a link at its own path rather than writing
 * through it.
 */
import { createWaveWriter, type WaveStats } from '@nimbus-sh/platform/wave-writer.js';
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { fsError, type GitFsBackend, type GitFsStat } from '../git-fs.js';
import {
  facetFileApi, METADATA_MAX_ACCOUNTED_BYTES, METADATA_MAX_ENTRIES, READ_RANGE_BYTES, supervisorStat,
  WHOLE_FILE_RPC_SAFE_BYTES, type FacetStats, type GitFacetSupervisor, type MetadataOverlayStats, type SupervisorStat,
} from './facet-supervisor.js';
import { MOUNT_WAVE_FILE_MAX, replaceFile } from './mount-writer.js';

/** A path the overlay knows, as the wave that publishes it will. */
export interface OverlayEntry {
  kind: 'dir' | 'file' | 'symlink';
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  atimeMs: number;
  target?: string;
}

const METADATA_ENTRY_OVERHEAD_BYTES = 256;
const textEncoder = new TextEncoder();

function parentOf(path: string): string {
  return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
}

/** An overlay entry as an inode: a link followed reads as the file it names. */
function overlayStat(entry: OverlayEntry, follow: boolean): GitFsStat {
  return {
    type: entry.kind === 'symlink' && !follow ? 'symlink' : entry.kind === 'dir' ? 'dir' : 'file',
    size: entry.size,
    mode: entry.mode,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    atimeMs: entry.atimeMs,
    uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1,
  };
}

/** A directory the writer holds, or the root: stamped now. */
function directoryNow(): GitFsStat {
  const now = Date.now();
  return { type: 'dir', size: 0, mode: 0o755, mtimeMs: now, ctimeMs: now, atimeMs: now, uid: 1000, gid: 1000, dev: 0, ino: 0, nlink: 1 };
}

/** A supervisor stat as an overlay entry. */
export function overlayEntryOf(st: SupervisorStat): OverlayEntry {
  const converted = supervisorStat(st);
  return {
    kind: converted.type === 'dir' ? 'dir' : converted.type === 'symlink' ? 'symlink' : 'file',
    size: converted.size,
    mode: converted.mode,
    mtimeMs: converted.mtimeMs,
    ctimeMs: converted.ctimeMs,
    atimeMs: converted.atimeMs,
  };
}

export interface BufferedFs {
  backend: GitFsBackend;
  flushWave(): Promise<void>;
  overlayStats(): MetadataOverlayStats;
  /**
   * `alreadyDurable` records that these exact bytes are known to be durably
   * published at path (the caller read them back), so waves can assert the
   * pin's presence without ever re-writing unchanged content.
   */
  pinFile(path: string, data: string, alreadyDurable?: boolean): void;
  unpinFile(path: string): void;
  waveStats(): WaveStats;
}

export function createBufferedFs(
  supervisor: GitFacetSupervisor,
  stats: FacetStats,
  authoritativeRoot: string | null,
  authoritativeRootMetadata: OverlayEntry | null,
  phaseDeadline: number | null = null,
  worktreeRoot: string | null = null,
  onMount = false,
): BufferedFs {
  // On a mount, a file past a wave's limit is written in place (pack/mount-writer.ts).
  const fileApi = onMount ? facetFileApi(supervisor, stats, phaseDeadline) : null;
  const metadata = new Map<string, OverlayEntry>();
  const children = new Map<string, Set<string>>();
  let metadataAccountedBytes = 0;
  let overlayFailure: Error | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  function stampEntry(entry: OverlayEntry, mtimeMs: number): void {
    entry.atimeMs = mtimeMs;
    entry.mtimeMs = mtimeMs;
    entry.ctimeMs = mtimeMs;
  }

  // Each record carries its overlay metadata (fetch and pull have no other
  // record of a buffered file); a cut stamps the wave's mtime on it, so the
  // overlay's stat agrees with what the wave publishes.
  const writer = createWaveWriter<OverlayEntry>({
    supervisor: {
      writeBatchStream(stream, fence) {
        stats.supervisorRpc.writeBatchStream++;
        return supervisor.writeBatchStream(stream, fence);
      },
      openWaveWriter() {
        return typeof supervisor.openWaveWriter === 'function' ? supervisor.openWaveWriter() : Promise.resolve(null);
      },
    },
    root: authoritativeRoot,
    worktreeRoot,
    deadline: phaseDeadline,
    directoryMode(path) {
      const entry = metadata.get(path);
      return entry && entry.kind === 'dir' ? entry.mode : undefined;
    },
    onCut(cut) {
      for (const dir of cut.directories) {
        const entry = metadata.get(dir);
        if (entry && entry.kind === 'dir') stampEntry(entry, cut.mtimeMs);
      }
      for (const file of cut.files) {
        const entry = file.meta || metadata.get(file.path);
        if (entry && (entry.kind === 'file' || entry.kind === 'symlink')) stampEntry(entry, cut.mtimeMs);
      }
    },
    onWave(report) {
      stats.filesWritten += report.files;
      stats.bytesWritten += report.bytes;
    },
    onResend(lost) {
      console.warn('[git] write wave re-sent', JSON.stringify(lost));
    },
  });

  function assertFlushHealthy(): void {
    if (overlayFailure) throw overlayFailure;
    writer.assertHealthy();
  }

  async function flushWave(): Promise<void> {
    if (overlayFailure) throw overlayFailure;
    await writer.flush();
  }

  // No read reports a link, or resolves through one, before the link is
  // durable: a read waits out every link written and not yet published.
  async function awaitPublishedSymlinks(): Promise<void> {
    if (writer.hasUnpublishedSymlinks) await flushWave();
  }

  // A read the overlay cannot answer goes to the supervisor, which must
  // already hold every write the adapter has made.
  async function awaitSupervisorReadable(): Promise<void> {
    await awaitPublishedSymlinks();
    await writer.settled();
    assertFlushHealthy();
  }

  function isAuthoritativePath(path: string): boolean {
    return authoritativeRoot !== null && (path === authoritativeRoot || path.startsWith(authoritativeRoot + '/'));
  }

  function metadataCost(path: string, entry: OverlayEntry): number {
    const targetBytes = entry.kind === 'symlink' ? textEncoder.encode(entry.target).byteLength : 0;
    return METADATA_ENTRY_OVERHEAD_BYTES + textEncoder.encode(path).byteLength + targetBytes;
  }

  function addChild(path: string): void {
    const parent = parentOf(path);
    let names = children.get(parent);
    if (!names) children.set(parent, names = new Set());
    const name = path.slice(parent ? parent.length + 1 : 0);
    if (name) names.add(name);
  }

  function removeChild(path: string): void {
    const parent = parentOf(path);
    const names = children.get(parent);
    if (!names) return;
    names.delete(path.slice(parent ? parent.length + 1 : 0));
    if (names.size === 0) children.delete(parent);
  }

  function setMetadata(path: string, entry: OverlayEntry): void {
    if (!isAuthoritativePath(path)) return;
    const previous = metadata.get(path);
    const previousCost = previous ? metadataCost(path, previous) : 0;
    const nextEntries = metadata.size + (previous ? 0 : 1);
    const nextBytes = metadataAccountedBytes - previousCost + metadataCost(path, entry);
    if (nextEntries > METADATA_MAX_ENTRIES || nextBytes > METADATA_MAX_ACCOUNTED_BYTES) {
      const error = new Error(`git clone metadata overlay exceeded its bound (${nextEntries} entries, ${nextBytes} accounted bytes)`);
      overlayFailure = error;
      throw error;
    }
    metadata.set(path, entry);
    metadataAccountedBytes = nextBytes;
    if (!previous) addChild(path);
    if (entry.kind === 'dir' && !children.has(path)) children.set(path, new Set());
  }

  function removeMetadata(path: string, recursive: boolean): void {
    if (!isAuthoritativePath(path)) return;
    const paths = [path];
    if (recursive) {
      for (let index = 0; index < paths.length; index++) {
        const parent = paths[index];
        for (const name of children.get(parent) || []) paths.push(parent + '/' + name);
      }
    }
    paths.sort((left, right) => right.length - left.length);
    for (const candidate of paths) {
      const previous = metadata.get(candidate);
      if (!previous) continue;
      metadataAccountedBytes -= metadataCost(candidate, previous);
      metadata.delete(candidate);
      children.delete(candidate);
      removeChild(candidate);
    }
  }

  function ensureMetadataParents(path: string, timestamp: number): void {
    if (!isAuthoritativePath(path)) return;
    let parent = parentOf(path);
    while (isAuthoritativePath(parent)) {
      if (!metadata.has(parent)) {
        setMetadata(parent, { kind: 'dir', size: 0, mode: 0o755, mtimeMs: timestamp, ctimeMs: timestamp, atimeMs: timestamp });
      }
      if (parent === authoritativeRoot) break;
      parent = parentOf(parent);
    }
  }

  function recordDirectory(path: string): void {
    if (!isAuthoritativePath(path)) return;
    const existing = metadata.get(path);
    if (existing && existing.kind === 'dir') return;
    const now = Date.now();
    ensureMetadataParents(path, now);
    setMetadata(path, { kind: 'dir', size: 0, mode: 0o755, mtimeMs: now, ctimeMs: now, atimeMs: now });
  }

  /** `path` through the overlay's links (the final one when `followFinal`), and the entry it lands on. */
  function resolveMetadataPath(path: string, syscall: string, followFinal = true): { path: string; entry: OverlayEntry | undefined } {
    const seen = new Set<string>();
    let current = normalizeVfsPath(path);
    for (let depth = 0; depth < 40; depth++) {
      const parts = current.split('/').filter(Boolean);
      let prefix = '';
      let followed = false;
      for (let index = 0; index < parts.length; index++) {
        prefix = prefix ? prefix + '/' + parts[index] : parts[index];
        const entry = metadata.get(prefix);
        if (!entry) continue;
        const isFinal = index === parts.length - 1;
        if (entry.kind === 'symlink' && (followFinal || !isFinal)) {
          if (seen.has(prefix)) throw fsError('ELOOP', syscall, path);
          seen.add(prefix);
          const target = entry.target!.startsWith('/')
            ? normalizeVfsPath(entry.target!)
            : normalizeVfsPath(parentOf(prefix) + '/' + entry.target);
          const remainder = parts.slice(index + 1).join('/');
          current = remainder ? normalizeVfsPath(target + '/' + remainder) : target;
          followed = true;
          break;
        }
        if (!isFinal && entry.kind !== 'dir') throw fsError('ENOTDIR', syscall, path);
      }
      if (!followed) return { path: current, entry: metadata.get(current) };
    }
    throw fsError('ELOOP', syscall, path);
  }

  if (authoritativeRoot !== null && authoritativeRootMetadata) setMetadata(authoritativeRoot, authoritativeRootMetadata);

  // Mutations apply in call order: each waits for the one before it, and the
  // writer admits its record (cutting a wave first when it would not fit).
  function bufferMutation(mutate: () => Promise<void>): Promise<void> {
    const operation = mutationQueue.then(async () => {
      assertFlushHealthy();
      return mutate();
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // A file the writer holds, or a stat of one, for a path no wave has published.
  function bufferedStat(path: string, follow: boolean): GitFsStat | null {
    const buffered = writer.bufferedRecord(path);
    if (!buffered) return null;
    const now = Date.now();
    return overlayStat(buffered.meta || { kind: buffered.kind, size: buffered.size, mode: 0o644, mtimeMs: now, ctimeMs: now, atimeMs: now }, follow);
  }

  async function readSupervisorFile(durablePath: string, filepath: string, knownSize: number | null): Promise<Uint8Array | null> {
    await awaitSupervisorReadable();
    let size = knownSize;
    if (size === null) {
      stats.supervisorRpc.stat++;
      size = await useRpcResource(supervisor.stat(durablePath), (result) => result === null || result === undefined ? null : Number(result.size));
    }
    if (size === null) return null;
    if (!Number.isSafeInteger(size) || size < 0) throw fsError('EIO', 'open', filepath, 'invalid file size ' + String(size));
    // Ordinary RPC values have a 32 MiB structured-clone ceiling, so a larger
    // file is reconstructed through the bounded range RPC, whatever its kind.
    if (size > WHOLE_FILE_RPC_SAFE_BYTES) {
      const data = new Uint8Array(size);
      for (let offset = 0; offset < size;) {
        const expected = Math.min(READ_RANGE_BYTES, size - offset);
        stats.supervisorRpc.fsReadRange++;
        offset += await useRpcResource(supervisor.fsReadRange(durablePath, offset, expected), (result) => {
          if (result === null || result === undefined) throw fsError('EIO', 'open', filepath, `range ${offset}..${offset + expected} is missing`);
          const chunk = result instanceof Uint8Array ? result : new Uint8Array(result);
          if (chunk.byteLength !== expected) {
            throw fsError('EIO', 'open', filepath, `range ${offset}..${offset + expected} returned ${chunk.byteLength} bytes`);
          }
          data.set(chunk, offset);
          return chunk.byteLength;
        });
      }
      return data;
    }
    stats.supervisorRpc.readFile++;
    return useRpcResource(supervisor.readFileBytes(durablePath), (result) => {
      if (result === null || result === undefined) return null;
      return (result instanceof Uint8Array ? result : new Uint8Array(result)).slice();
    });
  }

  const backend: GitFsBackend = {
    async stat(p, follow) {
      assertFlushHealthy();
      await awaitPublishedSymlinks();
      const resolved = resolveMetadataPath(p, follow ? 'stat' : 'lstat', follow);
      if (resolved.entry) return overlayStat(resolved.entry, follow);
      if (isAuthoritativePath(resolved.path)) return null;
      // A path the writer holds: through the overlay's links for lstat, as given for stat.
      const at = follow ? p : resolved.path;
      const buffered = bufferedStat(at, follow);
      if (buffered) return buffered;
      if (writer.isBufferedDirectory(at)) return directoryNow();
      if (writer.isBufferedDelete(at)) return null;
      if (!at) return directoryNow();
      await awaitSupervisorReadable();
      stats.supervisorRpc[follow ? 'stat' : 'lstat']++;
      const st = await useRpcResource(follow ? supervisor.stat(resolved.path) : supervisor.lstat(resolved.path), (result) => result);
      return st ? supervisorStat(st) : null;
    },

    async readFile(p) {
      assertFlushHealthy();
      await awaitPublishedSymlinks();
      // The buffer first: insertion order preserves what git wrote.
      const buffered = writer.buffered(p);
      if (buffered !== undefined) return buffered;
      if (writer.isBufferedDelete(p)) return null;
      const resolved = resolveMetadataPath(p, 'open');
      if (resolved.path !== p) {
        const target = writer.buffered(resolved.path);
        if (target !== undefined) return target;
      }
      if (resolved.entry && resolved.entry.kind === 'dir') return null;
      if (!resolved.entry && isAuthoritativePath(resolved.path)) return null;
      return readSupervisorFile(resolved.path, p, resolved.entry && resolved.entry.kind === 'file' ? resolved.entry.size : null);
    },

    async writeFile(p, data, executable) {
      assertFlushHealthy();
      // Every buffered record owns its ArrayBuffer: the W7 stream transfers
      // what it enqueues, and isomorphic-git hands writeFile subarray views
      // of a pack-sized parent, and pako's pooled output as whole views of
      // a shared buffer (both detached a later wave in production). So the
      // bytes are copied here, once, unconditionally.
      let buf: Uint8Array;
      if (typeof data === 'string') {
        buf = textEncoder.encode(data);
      } else {
        // One copy, by set(): the wave's encoder slices chunk views of it (tests/unit/git-network-facet-wave-memory.mjs).
        buf = new Uint8Array(data.length);
        buf.set(data);
      }
      return bufferMutation(async () => {
        const now = Date.now();
        ensureMetadataParents(p, now);
        const mode = executable ? 0o755 : 0o644;
        const fileMetadata: OverlayEntry = { kind: 'file', size: buf.length, mode, mtimeMs: now, ctimeMs: now, atimeMs: now };
        setMetadata(p, fileMetadata);
        if (fileApi !== null && buf.length > MOUNT_WAVE_FILE_MAX) {
          // What the waves hold before it lands first; then the file, as a program writes it.
          await writer.flush();
          const stat = await replaceFile(fileApi, '/' + p, mode, buf);
          stampEntry(fileMetadata, stat.mtime);
          stats.filesWritten++;
          stats.bytesWritten += buf.length;
          return;
        }
        await writer.file(p, mode, buf, fileMetadata);
      });
    },

    // unlink(2) and rmdir(2): a buffered delete removes the whole subtree at
    // its path, so neither may take a directory it would not take on disk.
    // unlink refuses a directory; rmdir refuses a non-directory and a
    // directory that still holds anything (untracked files a checkout leaves).
    async unlink(p, filepath) {
      assertFlushHealthy();
      const st = await backend.stat(p, false);
      if (st === null) throw fsError('ENOENT', 'unlink', filepath);
      if (st.type === 'dir') throw fsError('EISDIR', 'unlink', filepath);
      return bufferMutation(async () => {
        removeMetadata(p, false);
        await writer.remove(p);
      });
    },

    async readdir(p, filepath) {
      assertFlushHealthy();
      await awaitPublishedSymlinks();
      const resolved = resolveMetadataPath(p, 'scandir');
      const local = resolved.entry;
      if (local || isAuthoritativePath(resolved.path)) {
        if (!local) throw fsError('ENOENT', 'scandir', filepath);
        if (local.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', filepath);
        return [...(children.get(resolved.path) || [])];
      }
      await awaitSupervisorReadable();
      stats.supervisorRpc.readdir++;
      const entries = await useRpcResource(supervisor.readdir(resolved.path), (result) => result);
      const names = new Set(Array.isArray(entries) ? entries.map((entry) => typeof entry === 'string' ? entry : entry.name) : []);
      // What the writer holds below it, and less what it deletes there.
      const prefix = resolved.path ? resolved.path + '/' : '';
      const buffered = writer.bufferedPaths();
      for (const paths of [buffered.files, buffered.directories]) {
        for (const bp of paths) {
          if (!bp.startsWith(prefix)) continue;
          const first = bp.slice(prefix.length).split('/')[0];
          if (first) names.add(first);
        }
      }
      for (const dp of buffered.deletes) {
        if (!dp.startsWith(prefix)) continue;
        const rest = dp.slice(prefix.length);
        if (rest.indexOf('/') < 0) names.delete(rest);
      }
      return [...names];
    },

    async mkdir(p) {
      assertFlushHealthy();
      if (!p) return;
      return bufferMutation(async () => {
        recordDirectory(p);
        await writer.directory(p);
      });
    },

    async rmdir(p, filepath, recursive) {
      assertFlushHealthy();
      if (!recursive) {
        const st = await backend.stat(p, false);
        if (st === null) throw fsError('ENOENT', 'rmdir', filepath);
        if (st.type !== 'dir') throw fsError('ENOTDIR', 'rmdir', filepath);
        if ((await backend.readdir(p, filepath)).length > 0) throw fsError('ENOTEMPTY', 'rmdir', filepath);
      }
      return bufferMutation(async () => {
        removeMetadata(p, true);
        await writer.remove(p, true);
      });
    },

    async symlink(target, p) {
      assertFlushHealthy();
      return bufferMutation(async () => {
        const now = Date.now();
        ensureMetadataParents(p, now);
        const linkMetadata: OverlayEntry = {
          kind: 'symlink', target, size: textEncoder.encode(target).byteLength, mode: 0o777, mtimeMs: now, ctimeMs: now, atimeMs: now,
        };
        setMetadata(p, linkMetadata);
        await writer.symlink(p, target, linkMetadata);
      });
    },

    async readlink(p, filepath) {
      assertFlushHealthy();
      await awaitPublishedSymlinks();
      const resolved = resolveMetadataPath(p, 'readlink', false);
      const local = resolved.entry;
      if (local && local.kind === 'symlink') return local.target!;
      if (local) throw fsError('EINVAL', 'readlink', filepath);
      if (isAuthoritativePath(resolved.path)) throw fsError('ENOENT', 'readlink', filepath);
      await awaitSupervisorReadable();
      stats.supervisorRpc.readlink++;
      return useRpcResource(supervisor.readlink(resolved.path), (result) => {
        if (result === null || result === undefined) throw fsError('ENOENT', 'readlink', filepath);
        return String(result);
      });
    },
  };

  return {
    backend,
    flushWave,
    overlayStats: () => ({ entries: metadata.size, accountedBytes: metadataAccountedBytes, maxEntries: METADATA_MAX_ENTRIES, maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES }),
    pinFile: (path, data, alreadyDurable = false) => writer.setPin(normalizeVfsPath(path), data, alreadyDurable),
    unpinFile: (path) => writer.clearPin(normalizeVfsPath(path)),
    waveStats: () => writer.stats(),
  };
}
