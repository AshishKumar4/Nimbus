/**
 * git/pack/mount-writer.ts — a clone's files on a mounted filesystem.
 *
 * A wave writes a file to a mount in one call, up to ROUTED_FILE_MAX bytes
 * (sqlite-vfs.ts); a larger one it refuses. So on a mount, a file within
 * that goes in the wave as on the session's own filesystem, and a larger
 * one is written as any program writes a large file: through the session's
 * file API (open, write in pieces, close), under the clone's lease, once
 * what the waves hold before it is published, so it lands in git's order;
 * its directory is made first, as `mkdir -p` would.
 * The index, which git writes whole to index.lock and renames over
 * .git/index, is written the same way. Its stat is the receipt a wave would
 * have answered.
 */
import type { CloneReceipt, CloneWriter } from './clone.js';

/** sqlite-vfs.ts ROUTED_FILE_MAX: the largest file a wave writes to a mount. */
export const MOUNT_WAVE_FILE_MAX = 4 * 1024 * 1024;
/** One write's bytes: well inside what one RPC carries. */
const WRITE_PIECE_BYTES = 1024 * 1024;

/** An open file's stat, as fstat answers it: what its receipt is made of. */
export interface FileStat {
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
}

/** The session's file API, as the clone's supervisor binding offers it (its lease presented). */
export interface FileApi {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  fsOpen(path: string, flags: { write: true; create: true; truncate: true; mode: number }): Promise<{ id: number }>;
  fsWrite(handleId: number, offset: number, bytes: Uint8Array): Promise<number>;
  fsFstat(handleId: number): Promise<FileStat>;
  fsClose(handleId: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * A file written at `at` as a program writes one: its directory made
 * (`mkdir -p`), then opened, written in pieces and closed, at `written` (a
 * name beside it, renamed over it after, as git's lock files are) or at
 * `at` itself. Answers its stat.
 */
export async function writeInPlace(api: FileApi, at: string, mode: number, bytes: Uint8Array, written = at): Promise<FileStat> {
  await api.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true });
  const handle = await api.fsOpen(written, { write: true, create: true, truncate: true, mode });
  let stat: FileStat;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += WRITE_PIECE_BYTES) {
      await api.fsWrite(handle.id, offset, bytes.subarray(offset, Math.min(bytes.byteLength, offset + WRITE_PIECE_BYTES)));
    }
    stat = await api.fsFstat(handle.id);
  } finally {
    await api.fsClose(handle.id);
  }
  if (written !== at) await api.rename(written, at);
  return stat;
}

/**
 * `writer` (rooted at `dir`, a namespace path on a mount), with each file
 * over a wave's mount limit written through `api` instead, its receipt to
 * `onReceipts`.
 */
export function mountWriter(writer: CloneWriter, api: FileApi, dir: string, onReceipts?: (receipts: CloneReceipt[]) => void): CloneWriter {
  const root = dir.replace(/\/+$/, '');
  return {
    async file(path, mode, bytes) {
      if (bytes.byteLength <= MOUNT_WAVE_FILE_MAX) return await writer.file(path, mode, bytes);
      // What the waves hold before it (its directory among them) lands first.
      await writer.flush();
      const at = root + '/' + path;
      // git writes its index whole to index.lock, then renames it over the index.
      const stat = await writeInPlace(api, at, mode, bytes, path === '.git/index' ? at + '.lock' : at);
      onReceipts?.([{
        path: at.replace(/^\/+/, ''),
        ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, uid: stat.uid, gid: stat.gid, dev: stat.dev,
      }]);
    },
    symlink: (path, target) => writer.symlink(path, target),
    directory: (path) => writer.directory(path),
    remove: (path, directory) => writer.remove(path, directory),
    setPin: (path, text, durable) => writer.setPin(path, text, durable),
    flush: () => writer.flush(),
  };
}
