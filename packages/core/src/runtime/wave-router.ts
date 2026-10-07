/**
 * The namespace as every wave's router (SqliteVFS.setWaveRouter). A W7 wave
 * is streamed to the session's SQLite filesystem, whoever sends it (a
 * process's binding, or a command holding the engine), and each of its
 * records lands where the namespace puts a mutation of that name: its
 * directory resolved by the mutations' own lookup (CompositeVFS
 * .mutationRoute, links followed into mounts), and the record applied on a
 * mount by the namespace's own operations, so a mount's guard, read-only
 * flag and refusals are the wave's as they are a single call's.
 *
 * On a mount, a record is applied as an upsert is, by the operations a
 * program would use, each refusal before anything is lost:
 *   - a directory: mkdir -p, a directory already there kept;
 *   - a file: written where it can be written in place, to a staged name in
 *     its directory chunk by chunk as the wave delivers them (each chunk's
 *     credit released once written), then renamed over its name; on a
 *     backend that cannot write in place, taken whole up to
 *     HELD_FILE_BYTES, ENOTSUP past it;
 *   - a link: made at a staged name, then renamed over its name, so a
 *     backend that cannot make it refuses before the old entry goes;
 *   - a removal: rm -r, refused (EIO, naming what stayed) when it kept or
 *     failed to remove anything.
 */

import type { CompositeVFS } from '../vfs/composite.js';
import type { RoutedChunk, RoutedStat, RoutedWaveRecord, WaveRouter } from '../vfs/sqlite-vfs.js';
import type { VfsCred, VfsStat } from '../vfs/vfs.js';
import { VfsError, type VfsErrorCode } from '../vfs/vfs-error.js';

/**
 * The most a wave holds of one file for a mount that cannot write in place:
 * half the session's shared write credit, so a held file never starves the
 * wave of the credit its next chunk needs.
 */
export const HELD_FILE_BYTES = 4 * 1024 * 1024;

export function namespaceWaveRouter(namespace: CompositeVFS, credential: (cred: VfsCred) => VfsCred): WaveRouter {
  const view = (cred: VfsCred, guard?: () => void): CompositeVFS => {
    const as = namespace.as(credential(cred));
    return guard === undefined ? as : as.scoped(guard);
  };
  return {
    async resolveDirectory(path, cred, signal) {
      const ns = view(cred);
      let missing = '';
      for (let at = path; ; ) {
        signal?.throwIfAborted();
        try {
          const resolved = (await ns.mutationRoute(at, { follow: true })).path;
          return missing === '' ? resolved : `${resolved === '/' ? '' : resolved}/${missing}`;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if ((code !== 'ENOENT' && code !== 'ENOTDIR') || at === '/') throw error;
          const cut = at.lastIndexOf('/');
          missing = missing === '' ? at.slice(cut + 1) : `${at.slice(cut + 1)}/${missing}`;
          at = at.slice(0, cut) || '/';
        }
      }
    },
    placement(path) {
      const point = namespace.mountOf(path);
      if (point !== '/') return point;
      // A directory above a mount point is the namespace's, though on the root.
      return namespace.composes(path) ? point : null;
    },
    async apply(record, cred, guard) {
      // Guarded: every call to the backend. Cleanup of a staged name is not: it is the wave's own.
      return applyRecord(view(cred, guard), view(cred), record);
    },
  };
}

async function applyRecord(ns: CompositeVFS, cleanup: CompositeVFS, record: RoutedWaveRecord): Promise<RoutedStat | null> {
  switch (record.type) {
    case 'directory':
      await ns.mkdir(record.path, { recursive: true, mode: record.mode });
      return null;
    case 'delete': {
      if ((await ns.stat(record.path, { follow: false })) === null) return null;
      const removal = await ns.removeRecursive(record.path);
      if (removal.kept.length > 0 || removal.failures.length > 0) {
        const first = removal.failures[0];
        const code: VfsErrorCode = first?.error.code ?? 'EIO';
        throw new VfsError(code, `rm -r removed ${removal.removed.length}, kept ${removal.kept.length}${removal.kept.length > 0 ? ` (${removal.kept.slice(0, 3).join(', ')})` : ''}, failed ${removal.failures.length}${first ? ` (${first.path}: ${first.error.message})` : ''}`, record.path);
      }
      return null;
    }
    case 'symlink': {
      const staged = stagedName(record.path);
      await ns.symlink(record.target, staged);
      try {
        await ns.rename(staged, record.path);
      } catch (error) {
        await cleanup.unlink(staged).catch(() => {});
        throw error;
      }
      return statOf(await ns.stat(record.path, { follow: false }));
    }
    case 'file':
      await (ns.writesInPlace(record.path) ? spool(ns, cleanup, record) : holdWhole(ns, record));
      return statOf(await ns.stat(record.path, { follow: false }));
  }
}

/** Write a file at a staged name chunk by chunk, each chunk's credit released once written, then rename it over its name. */
async function spool(ns: CompositeVFS, cleanup: CompositeVFS, record: Extract<RoutedWaveRecord, { type: 'file' }>): Promise<void> {
  const staged = stagedName(record.path);
  let offset = 0;
  let made = false;
  try {
    await ns.writeFile(staged, new Uint8Array(0), { mode: record.mode });
    made = true;
    for await (const chunk of record.chunks) {
      try {
        await ns.writeRange(staged, offset, chunk.data);
        offset += chunk.data.byteLength;
      } finally {
        chunk.release();
      }
    }
    await ns.rename(staged, record.path);
  } catch (error) {
    if (made) await cleanup.unlink(staged).catch(() => {});
    // What the wave hands over after the failure goes back to it as it comes.
    await drain(record.chunks).catch(() => {});
    throw error;
  }
}

/** Take a file whole, for a backend that cannot write in place, up to HELD_FILE_BYTES. */
async function holdWhole(ns: CompositeVFS, record: Extract<RoutedWaveRecord, { type: 'file' }>): Promise<void> {
  if (record.size > HELD_FILE_BYTES) {
    await drain(record.chunks);
    throw new VfsError('ENOTSUP',
      `a wave's file goes to a mount that cannot write in place whole, up to ${HELD_FILE_BYTES} bytes; this one is ${record.size}`, record.path);
  }
  const held: RoutedChunk[] = [];
  try {
    for await (const chunk of record.chunks) held.push(chunk);
    const bytes = new Uint8Array(record.size);
    let at = 0;
    for (const chunk of held) { bytes.set(chunk.data, at); at += chunk.data.byteLength; }
    await ns.writeFile(record.path, bytes, { mode: record.mode });
  } finally {
    for (const chunk of held) chunk.release();
  }
}

async function drain(chunks: AsyncIterable<RoutedChunk>): Promise<void> {
  for await (const chunk of chunks) chunk.release();
}

/** A name beside `path` in its directory that no program names. */
function stagedName(path: string): string {
  const cut = path.lastIndexOf('/');
  return `${path.slice(0, cut)}/.${path.slice(cut + 1)}.nimbus-wave-${crypto.randomUUID().slice(0, 8)}`;
}

function statOf(stat: VfsStat | null): RoutedStat | null {
  if (stat === null) return null;
  return {
    ino: stat.ino ?? 0,
    mode: stat.mode ?? 0,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs ?? stat.mtimeMs,
    uid: stat.uid ?? 0,
    gid: stat.gid ?? 0,
    dev: stat.dev ?? 0,
  };
}
