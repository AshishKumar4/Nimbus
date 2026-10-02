/**
 * mv's move, for any VFS: rename(2) where the filesystem can, and where it
 * answers EXDEV (another filesystem, or a backend that cannot rename in
 * place) a carry that happens whole or not at all.
 *
 * The carry stages a copy beside the destination and confirms it, then
 * removes the source, then puts the copy in the destination's place with one
 * rename. Until that rename the destination keeps what it held. A failure at
 * any step puts back what of the source had gone and removes the staged
 * copy, so a failed move leaves both names as they were. A backend that
 * cannot rename in place is written over where it is, after what the
 * destination held is kept to put back.
 *
 * Neither atomic to a reader nor across a crash: from the source's removal
 * to the final rename, what is moving is only at the staged name,
 * `.nimbus-move-<id>` in the destination's directory.
 */

import { isVfsError, syscallError, type VfsError } from './vfs-error.js';
import type { Awaitable, VFS, VfsStat } from './vfs.js';

/** A namespace to move within: a VFS, with realpath where it has one (to refuse a tree moved beneath itself through a link). */
export type MoveFs = VFS & { realpath?(path: string): Awaitable<string> };

export interface MoveOptions {
  /**
   * A copied entry's mode or times the destination refused. They are carried
   * best effort, as GNU mv carries them (mv.c: require_preserve = false), so
   * the move still happens; `path` is where the entry ends up.
   */
  onPreserveFailure?(failure: { what: 'times' | 'permissions'; path: string; error: VfsError }): Awaitable<void>;
}

type PreserveFailure = MoveOptions['onPreserveFailure'];

/** Move `from` to `to` as mv does: one rename, or a carry across filesystems (above). Directories too. */
export async function move(fs: MoveFs, from: string, to: string, options: MoveOptions = {}): Promise<void> {
  if (typeof fs.rename === 'function') {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!isVfsError(error, 'EXDEV')) throw error;
    }
  }
  await carry(fs, from, to, options.onPreserveFailure);
}

/** One carry: its two names, what was at them when it began, and where the copy is staged. */
interface Carry {
  readonly fs: MoveFs;
  readonly from: string;
  readonly to: string;
  readonly staged: string;
  readonly source: VfsStat;
  readonly existing: VfsStat | null;
  /** rename(2)'s error for the call, naming both paths as given. */
  refused(code: VfsError['code'], detail?: string): VfsError;
}

async function carry(fs: MoveFs, fromInput: string, toInput: string, onPreserveFailure: PreserveFailure): Promise<void> {
  const refused = (code: VfsError['code'], detail?: string): VfsError =>
    syscallError(code, 'rename', fromInput, { dest: toInput, detail });
  const from = withoutTrailingSlash(fromInput);
  const to = withoutTrailingSlash(toInput);

  // rename(2)'s refusals, since the filesystem never got as far as making them.
  const source = await fs.stat(from, { follow: false });
  if (source === null) throw refused('ENOENT');
  const directory = source.type === 'directory';
  if (!directory && (from !== fromInput || to !== toInput)) throw refused('ENOTDIR');
  // A bare name's directory is `.`, which means the same directory the name does.
  const cut = to.lastIndexOf('/');
  const parent = cut < 0 ? '.' : cut === 0 ? '/' : to.slice(0, cut);
  const holder = await fs.stat(parent);
  if (holder === null) throw refused('ENOENT');
  if (holder.type !== 'directory') throw refused('ENOTDIR');
  const existing = await fs.stat(to, { follow: false });
  const sameFile = existing !== null && source.ino !== undefined && source.dev !== undefined
    && source.ino === existing.ino && source.dev === existing.dev;
  if (from === to || sameFile) throw refused('EINVAL', 'source and destination are the same file');
  if (existing !== null) {
    if (directory && existing.type !== 'directory') throw refused('ENOTDIR');
    if (!directory && existing.type === 'directory') throw refused('EISDIR');
    if (directory && (await fs.readdir(to)).length > 0) throw refused('ENOTEMPTY');
  }
  if (directory && await beneath(fs, parent, from)) throw refused('EINVAL', 'a directory cannot move beneath itself');

  const c: Carry = { fs, from, to, staged: join(parent, `.nimbus-move-${crypto.randomUUID()}`), source, existing, refused };
  try {
    await copyEntry(fs, from, source, c.staged, to, onPreserveFailure);
    await confirm(c, c.staged);
  } catch (error) {
    throw await undone(c, error, () => discard(fs, c.staged), true);
  }
  // The copy is confirmed: the source goes, then the copy takes the destination's place.
  try {
    await removeEntry(fs, from, source);
    // Confirmed too: a backend that reported a partial removal whole would leave a move half made.
    if (await fs.stat(from, { follow: false }) !== null) throw refused('EIO', `${from} is still there after its removal`);
    await place(c);
  } catch (error) {
    throw await undone(c, error, async () => {
      await restore(fs, c.staged, from);
      await discard(fs, c.staged);
    }, true);
  }
}

/**
 * `error`, once `undo` has put things back; when it could not, EIO naming
 * both, and the staged copy when `staged` says it is what is left.
 */
async function undone(c: Carry, error: unknown, undo: () => Promise<void>, staged: boolean): Promise<unknown> {
  try {
    await undo();
    return error;
  } catch (failure) {
    const cause = error instanceof Error ? error.message : String(error);
    const undoing = failure instanceof Error ? failure.message : String(failure);
    return c.refused('EIO', `the move failed (${cause}) and undoing it failed (${undoing})`
      + (staged ? `; what was moving is at ${c.staged}` : ''));
  }
}

/**
 * The staged copy into the destination's place: one rename over it. Where
 * the filesystem has no rename in place, the destination is written where
 * it is, and what it held is kept and put back on a failure.
 */
async function place(c: Carry): Promise<void> {
  const { fs, staged, to, from, source, existing } = c;
  if (typeof fs.rename === 'function') {
    try {
      await fs.rename(staged, to);
      return;
    } catch (error) {
      if (!isVfsError(error, 'EXDEV')) throw error;
    }
  }
  const kept = existing === null ? null : await keep(fs, to, existing);
  try {
    // A file is written over in place; anything else is replaced, never written through.
    if (existing !== null && !(existing.type === 'file' && source.type === 'file')) await removeEntry(fs, to, existing);
    await copyEntry(fs, staged, source, to, to, undefined);
    await confirm(c, to);
  } catch (error) {
    throw await undone(c, error, () => putBack(fs, to, kept), false);
  }
  try {
    await discard(fs, staged);
  } catch (error) {
    // The staged copy was the witness the source is put back from, and part
    // of it may be gone now; the destination holds the whole copy.
    throw await undone(c, error, async () => {
      await restore(fs, to, from);
      await putBack(fs, to, kept);
    }, false);
  }
}

/** What a destination held, to put back. */
type Kept =
  | { type: 'file'; bytes: Uint8Array; stat: VfsStat }
  | { type: 'symlink'; target: string }
  | { type: 'directory'; stat: VfsStat };

async function keep(fs: MoveFs, path: string, stat: VfsStat): Promise<Kept> {
  if (stat.type === 'file') return { type: 'file', bytes: await fs.readFile(path), stat };
  if (stat.type === 'symlink') return { type: 'symlink', target: await readlinkOf(fs, path) };
  return { type: 'directory', stat };
}

async function putBack(fs: MoveFs, path: string, kept: Kept | null): Promise<void> {
  const now = await fs.stat(path, { follow: false });
  if (now !== null && !(now.type === 'file' && kept?.type === 'file')) await removeEntry(fs, path, now);
  if (kept === null) return;
  if (kept.type === 'symlink') {
    await fs.symlink!(kept.target, path);
    return;
  }
  if (kept.type === 'file') await fs.writeFile(path, kept.bytes, { mode: permissions(kept.stat) });
  else await fs.mkdir(path, { mode: permissions(kept.stat) });
  await preserve(fs, kept.stat, path, path, undefined);
}

/**
 * Copy one entry (a tree, for a directory) onto a name that is not there,
 * links as links, with its mode and times best effort. `named` is where the
 * entry ends up, for what is reported.
 */
async function copyEntry(fs: MoveFs, from: string, stat: VfsStat, to: string, named: string, onPreserveFailure: PreserveFailure): Promise<void> {
  if (stat.type === 'symlink') {
    if (typeof fs.symlink !== 'function') throw syscallError('ENOTSUP', 'symlink', named, { detail: 'this filesystem cannot hold a link' });
    await fs.symlink(await readlinkOf(fs, from), to);
    return;
  }
  if (stat.type === 'directory') {
    // Writable while it fills; its own mode once it has.
    const mode = permissions(stat);
    await fs.mkdir(to, mode === undefined ? undefined : { mode: mode | 0o700 });
    for (const entry of await fs.readdir(from)) {
      const child = join(from, entry.name);
      const childStat = entry.stat ?? await fs.stat(child, { follow: false });
      // Gone since the listing: nothing to carry.
      if (childStat === null) continue;
      await copyEntry(fs, child, childStat, join(to, entry.name), join(named, entry.name), onPreserveFailure);
    }
  } else if (typeof fs.copy === 'function') {
    await fs.copy(from, to);
  } else {
    const mode = permissions(stat);
    await fs.writeFile(to, await fs.readFile(from), mode === undefined ? undefined : { mode });
  }
  await preserve(fs, stat, to, named, onPreserveFailure);
}

async function preserve(fs: MoveFs, stat: VfsStat, path: string, named: string, onPreserveFailure: PreserveFailure): Promise<void> {
  const attempt = async (what: 'times' | 'permissions', apply: () => Awaitable<void>): Promise<void> => {
    try {
      await apply();
    } catch (error) {
      if (!isVfsError(error)) throw error;
      await onPreserveFailure?.({ what, path: named, error });
    }
  };
  if (typeof fs.utimes === 'function') await attempt('times', () => fs.utimes!(path, stat.atimeMs ?? stat.mtimeMs, stat.mtimeMs));
  const mode = permissions(stat);
  if (typeof fs.chmod === 'function' && mode !== undefined) await attempt('permissions', () => fs.chmod!(path, mode));
}

/** The copy at `path` is the source's kind of entry, and for a file, its size: what the source may go on. */
async function confirm(c: Carry, path: string): Promise<void> {
  const landed = await c.fs.stat(path, { follow: false });
  if (landed === null || landed.type !== c.source.type || (c.source.type === 'file' && landed.size !== c.source.size)) {
    throw c.refused('EIO', `the copy at ${path} is not what was copied`);
  }
}

/** rm -r of one entry, or its first failure. */
async function removeEntry(fs: MoveFs, path: string, stat: VfsStat): Promise<void> {
  if (stat.type !== 'directory') {
    await fs.unlink(path);
    return;
  }
  if (typeof fs.removeRecursive === 'function') {
    const failure = (await fs.removeRecursive(path))?.failures[0];
    if (failure !== undefined) throw failure.error;
    return;
  }
  for (const entry of await fs.readdir(path)) {
    const child = join(path, entry.name);
    const childStat = entry.stat ?? await fs.stat(child, { follow: false });
    if (childStat !== null) await removeEntry(fs, child, childStat);
  }
  if (typeof fs.rmdir === 'function') await fs.rmdir(path);
  else await fs.unlink(path);
}

async function discard(fs: MoveFs, path: string): Promise<void> {
  const stat = await fs.stat(path, { follow: false });
  if (stat !== null) await removeEntry(fs, path, stat);
}

/** Put back from `held` (a whole copy) whatever of `path` is gone; what is still there stays. */
async function restore(fs: MoveFs, held: string, path: string): Promise<void> {
  const heldStat = await fs.stat(held, { follow: false });
  if (heldStat === null) return;
  const now = await fs.stat(path, { follow: false });
  if (now === null) {
    await copyEntry(fs, held, heldStat, path, path, undefined);
    return;
  }
  if (now.type !== 'directory' || heldStat.type !== 'directory') return;
  for (const entry of await fs.readdir(held)) await restore(fs, join(held, entry.name), join(path, entry.name));
}

async function readlinkOf(fs: MoveFs, path: string): Promise<string> {
  if (typeof fs.readlink !== 'function') throw syscallError('ENOTSUP', 'readlink', path, { detail: 'this filesystem cannot read a link' });
  return await fs.readlink(path);
}

/** Whether `dir`, or a name beneath it, is `path`: lexically, and where the namespace has realpath, after every link. */
async function beneath(fs: MoveFs, path: string, dir: string): Promise<boolean> {
  if (within(path, dir)) return true;
  if (typeof fs.realpath !== 'function') return false;
  return within(await fs.realpath(path), await fs.realpath(dir));
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

function permissions(stat: VfsStat): number | undefined {
  return stat.mode === undefined ? undefined : stat.mode & 0o7777;
}

function withoutTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' && path.startsWith('/') ? '/' : trimmed;
}

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}
