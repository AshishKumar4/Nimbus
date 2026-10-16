/**
 * git/pack/buffered-fs.ts — the git network facet's filesystem: cf-git's
 * writes buffered as records for the wave writer (@nimbus-sh/platform
 * wave-writer.ts), which publishes them in W7 waves, one in flight while the
 * next buffers; its reads answered from the buffer, or from the supervisor.
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
import { enc } from '@nimbus-sh/core/_shared/bytes.js';
import { fsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { ROUTED_FILE_MAX } from '@nimbus-sh/core/runtime/wave-contracts.js';
import type { GitFsBackend, GitFsStat } from '../git-fs.js';
import {
  facetFileApi, READ_RANGE_BYTES, supervisorStat, WHOLE_FILE_RPC_SAFE_BYTES, type FacetStats, type GitFacetSupervisor,
} from './facet-supervisor.js';
import { replaceFile } from './mount-writer.js';

/** A buffered file or link, as the wave that publishes it will make it. */
interface RecordEntry {
  kind: 'file' | 'symlink';
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  atimeMs: number;
}

/** A record as an inode: a link followed reads as the file it names. */
function recordStat(entry: RecordEntry, follow: boolean): GitFsStat {
  return {
    type: entry.kind === 'symlink' && !follow ? 'symlink' : 'file',
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

export interface BufferedFs {
  backend: GitFsBackend;
  flushWave(): Promise<void>;
  waveStats(): WaveStats;
}

export function createBufferedFs(
  supervisor: GitFacetSupervisor,
  stats: FacetStats,
  phaseDeadline: number | null = null,
  worktreeRoot: string | null = null,
  onMount = false,
): BufferedFs {
  // On a mount, a file past a wave's limit is written in place (pack/mount-writer.ts).
  const fileApi = onMount ? facetFileApi(supervisor, stats, phaseDeadline) : null;
  let mutationQueue: Promise<void> = Promise.resolve();

  // Each record carries its metadata: a stat of a path still buffered (fetch
  // and pull have no other record of it) answers from it.
  const writer = createWaveWriter<RecordEntry>({
    supervisor: {
      writeBatchStream(stream, fence) {
        stats.supervisorRpc.writeBatchStream++;
        return supervisor.writeBatchStream(stream, fence);
      },
      openWaveWriter() {
        return typeof supervisor.openWaveWriter === 'function' ? supervisor.openWaveWriter() : Promise.resolve(null);
      },
    },
    root: null,
    worktreeRoot,
    deadline: phaseDeadline,
    onWave(report) {
      stats.filesWritten += report.files;
      stats.bytesWritten += report.bytes;
    },
    onResend(lost) {
      console.warn('[git] write wave re-sent', JSON.stringify(lost));
    },
  });

  function assertFlushHealthy(): void {
    writer.assertHealthy();
  }

  async function flushWave(): Promise<void> {
    await writer.flush();
  }

  // No read reports a link, or resolves through one, before the link is
  // durable: a read waits out every link written and not yet published.
  async function awaitPublishedSymlinks(): Promise<void> {
    if (writer.hasUnpublishedSymlinks) await flushWave();
  }

  // A read the buffer cannot answer goes to the supervisor, which must
  // already hold every write the adapter has made.
  async function awaitSupervisorReadable(): Promise<void> {
    await awaitPublishedSymlinks();
    await writer.settled();
    assertFlushHealthy();
  }

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
    return recordStat(buffered.meta || { kind: buffered.kind, size: buffered.size, mode: 0o644, mtimeMs: now, ctimeMs: now, atimeMs: now }, follow);
  }

  async function readSupervisorFile(path: string): Promise<Uint8Array | null> {
    await awaitSupervisorReadable();
    stats.supervisorRpc.stat++;
    const size = await useRpcResource(supervisor.stat(path), (result) => result === null || result === undefined ? null : Number(result.size));
    if (size === null) return null;
    if (!Number.isSafeInteger(size) || size < 0) throw fsError('EIO', 'open', path, undefined, { detail: 'invalid file size ' + String(size) });
    // Ordinary RPC values have a 32 MiB structured-clone ceiling, so a larger
    // file is reconstructed through the bounded range RPC, whatever its kind.
    if (size > WHOLE_FILE_RPC_SAFE_BYTES) {
      const data = new Uint8Array(size);
      for (let offset = 0; offset < size;) {
        const expected = Math.min(READ_RANGE_BYTES, size - offset);
        stats.supervisorRpc.fsReadRange++;
        offset += await useRpcResource(supervisor.fsReadRange(path, offset, expected), (result) => {
          if (result === null || result === undefined) throw fsError('EIO', 'open', path, undefined, { detail: `range ${offset}..${offset + expected} is missing` });
          const chunk = result instanceof Uint8Array ? result : new Uint8Array(result);
          if (chunk.byteLength !== expected) {
            throw fsError('EIO', 'open', path, undefined, { detail: `range ${offset}..${offset + expected} returned ${chunk.byteLength} bytes` });
          }
          data.set(chunk, offset);
          return chunk.byteLength;
        });
      }
      return data;
    }
    stats.supervisorRpc.readFile++;
    return useRpcResource(supervisor.readFileBytes(path), (result) => {
      if (result === null || result === undefined) return null;
      return (result instanceof Uint8Array ? result : new Uint8Array(result)).slice();
    });
  }

  const backend: GitFsBackend = {
    async stat(p, follow) {
      assertFlushHealthy();
      await awaitPublishedSymlinks();
      // A path the writer holds.
      const buffered = bufferedStat(p, follow);
      if (buffered) return buffered;
      if (writer.isBufferedDirectory(p)) return directoryNow();
      if (writer.isBufferedDelete(p)) return null;
      if (!p) return directoryNow();
      await awaitSupervisorReadable();
      stats.supervisorRpc[follow ? 'stat' : 'lstat']++;
      const st = await useRpcResource(follow ? supervisor.stat(p) : supervisor.lstat(p), (result) => result);
      return st ? supervisorStat(st) : null;
    },

    async readFile(p) {
      assertFlushHealthy();
      await awaitPublishedSymlinks();
      // The buffer first: insertion order preserves what git wrote.
      const buffered = writer.buffered(p);
      if (buffered !== undefined) return buffered;
      if (writer.isBufferedDelete(p)) return null;
      return readSupervisorFile(p);
    },

    async writeFile(p, data, requested) {
      assertFlushHealthy();
      // Every buffered record owns its ArrayBuffer: the W7 stream transfers
      // what it enqueues, and isomorphic-git hands writeFile subarray views
      // of a pack-sized parent, and pako's pooled output as whole views of
      // a shared buffer (both detached a later wave in production). So the
      // bytes are copied here, once, unconditionally.
      let buf: Uint8Array;
      if (typeof data === 'string') {
        buf = enc.encode(data);
      } else {
        // One copy, by set(): the wave's encoder slices chunk views of it (tests/unit/git-network-facet-wave-memory.mjs).
        buf = new Uint8Array(data.length);
        buf.set(data);
      }
      return bufferMutation(async () => {
        // The session makes the file with the bits asked for (0666 when none, as
        // a program's create) under its own creation policy: the process's
        // umask, a default ACL, a setgid parent.
        const mode = requested ?? 0o666;
        if (fileApi !== null && buf.length > ROUTED_FILE_MAX) {
          // What the waves hold before it lands first; then the file, as a program writes it.
          await writer.flush();
          await replaceFile(fileApi, '/' + p, mode, buf);
          stats.filesWritten++;
          stats.bytesWritten += buf.length;
          return;
        }
        // This facet's own record of it is git's view, as every buffered stat here is: executable or not.
        const now = Date.now();
        await writer.file(p, mode, buf, {
          kind: 'file', size: buf.length, mode: (mode & 0o111) !== 0 ? 0o755 : 0o644, mtimeMs: now, ctimeMs: now, atimeMs: now,
        });
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
      return bufferMutation(() => writer.remove(p));
    },

    async readdir(p) {
      assertFlushHealthy();
      await awaitSupervisorReadable();
      stats.supervisorRpc.readdir++;
      const entries = await useRpcResource(supervisor.readdir(p), (result) => result);
      const names = new Set(Array.isArray(entries) ? entries.map((entry) => typeof entry === 'string' ? entry : entry.name) : []);
      // What the writer holds below it, and less what it deletes there.
      const prefix = p ? p + '/' : '';
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
      return bufferMutation(() => writer.directory(p));
    },

    async rmdir(p, filepath, recursive) {
      assertFlushHealthy();
      if (!recursive) {
        const st = await backend.stat(p, false);
        if (st === null) throw fsError('ENOENT', 'rmdir', filepath);
        if (st.type !== 'dir') throw fsError('ENOTDIR', 'rmdir', filepath);
        if ((await backend.readdir(p, filepath)).length > 0) throw fsError('ENOTEMPTY', 'rmdir', filepath);
      }
      return bufferMutation(() => writer.remove(p, true));
    },

    async symlink(target, p) {
      assertFlushHealthy();
      return bufferMutation(async () => {
        const now = Date.now();
        const linkMetadata: RecordEntry = {
          kind: 'symlink', size: enc.encode(target).byteLength, mode: 0o777, mtimeMs: now, ctimeMs: now, atimeMs: now,
        };
        await writer.symlink(p, target, linkMetadata);
      });
    },

    async readlink(p, filepath) {
      assertFlushHealthy();
      await awaitSupervisorReadable();
      stats.supervisorRpc.readlink++;
      return useRpcResource(supervisor.readlink(p), (result) => {
        if (result === null || result === undefined) throw fsError('ENOENT', 'readlink', filepath);
        return String(result);
      });
    },
  };

  return {
    backend,
    flushWave,
    waveStats: () => writer.stats(),
  };
}
