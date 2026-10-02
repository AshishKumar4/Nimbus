/**
 * mv's move, for any VFS: rename(2) where the filesystem can, and where it
 * answers EXDEV (another filesystem, or a backend that cannot rename in
 * place) a carry that happens whole or not at all.
 *
 * The carry stages a copy beside the destination and confirms it, then
 * removes the source, then puts the copy in the destination's place with one
 * rename. Until that rename the destination keeps what it held. A failure
 * before it puts back what of the source had gone and removes the staged
 * copy, so the move leaves both names as they were. A backend that cannot
 * rename in place has the destination replaced where it is, after what it
 * held is kept to put back; another writer using the destination meanwhile
 * can lose its write, as it can on any filesystem written in place.
 *
 * Everything it creates is created private (the owner's bits only, as GNU
 * cp creates a copy before it sets the mode) and given its own mode once its
 * content is complete, so no one reads a copy its source would not let them.
 *
 * The final rename's own answer says what happened, never what the names
 * hold afterwards. A refusal (RENAME_REFUSALS: made before anything
 * changed), or a filesystem saying it renamed nothing (renameOutcome), is
 * clean: the source is put back from the staged copy, which goes, and the
 * refusal is the answer. A filesystem saying it renamed all of it is a move
 * that happened: the residue at the staged name goes. Anything else (EIO, no
 * code at all) may have renamed the copy in whole or in part, and another
 * writer may since have used the destination, so nothing is undone or
 * removed: the answer is EIO, naming where what was moving may be.
 *
 * Neither atomic to a reader nor across a crash: from the source's removal
 * to the final rename, what is moving is only at the staged name,
 * `.nimbus-move-<id>` in the destination's directory.
 */

import { isVfsError, RENAME_REFUSALS, renameOutcome, syscallError, type VfsError } from './vfs-error.js';
import type { Awaitable, VFS, VfsStat } from './vfs.js';

/** A namespace to move within: a VFS, and its realpath where it has one (links are otherwise walked with readlink). */
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
  /** Set once nothing is to be undone: the move happened, or whether it did is not known. */
  settled: boolean;
  /** rename(2)'s error for the call, naming both paths as given. */
  refused(code: VfsError['code'], detail?: string, cause?: unknown): VfsError;
}

async function carry(fs: MoveFs, fromInput: string, toInput: string, onPreserveFailure: PreserveFailure): Promise<void> {
  const refused = (code: VfsError['code'], detail?: string, cause?: unknown): VfsError =>
    syscallError(code, 'rename', fromInput, { dest: toInput, detail, cause });
  const from = withoutTrailingSlash(fromInput);
  const spelled = withoutTrailingSlash(toInput);

  // rename(2)'s refusals, since the filesystem never got as far as making them.
  const source = await fs.stat(from, { follow: false });
  if (source === null) throw refused('ENOENT');
  const directory = source.type === 'directory';
  if (!directory && (from !== fromInput || spelled !== toInput)) throw refused('ENOTDIR');
  const [fromParent, fromName] = parentAndName(from);
  const [toParent, toName] = parentAndName(spelled);
  // A last component of `.` or `..` names a directory by its relation to another (Linux: EBUSY).
  if ([fromName, toName].some((name) => name === '' || name === '.' || name === '..')) throw refused('EBUSY');
  const holder = await fs.stat(toParent);
  if (holder === null) throw refused('ENOENT');
  if (holder.type !== 'directory') throw refused('ENOTDIR');
  // Both names where the walk reaches them, taken once, as rename(2) takes
  // them: the destination may be spelled through the source, which is gone
  // before the copy is placed. `src/../dst` is not beneath src, and neither
  // is a name through a link in src to elsewhere.
  const parent = await physical(fs, toParent);
  const to = join(parent, toName);
  const at = join(await physical(fs, fromParent), fromName);
  const existing = await fs.stat(to, { follow: false });
  const sameFile = existing !== null && source.ino !== undefined && source.dev !== undefined
    && source.ino === existing.ino && source.dev === existing.dev;
  if (at === to || sameFile) throw refused('EINVAL', 'source and destination are the same file');
  if (existing !== null) {
    if (directory && existing.type !== 'directory') throw refused('ENOTDIR');
    if (!directory && existing.type === 'directory') throw refused('EISDIR');
    if (directory && (await fs.readdir(to)).length > 0) throw refused('ENOTEMPTY');
  }
  if (directory && within(parent, at)) throw refused('EINVAL', 'a directory cannot move beneath itself');

  const staged = join(parent, `.nimbus-move-${crypto.randomUUID()}`);
  const c: Carry = { fs, from, to, staged, source, existing, settled: false, refused };
  try {
    await copyEntry(fs, from, source, staged, { named: to, onPreserveFailure });
    await confirm(c, staged);
  } catch (error) {
    throw await undone(c, error, () => discard(fs, staged), `${from} is as it was, and part of a copy is left at ${staged}`);
  }
  // The copy is confirmed: the source goes, then the copy takes the destination's place.
  try {
    await removeEntry(fs, from, source);
    // Confirmed too: a backend that reported a partial removal whole would leave a move half made.
    if (await fs.stat(from, { follow: false }) !== null) throw refused('EIO', `${from} is still there after its removal`);
    await place(c);
  } catch (error) {
    if (c.settled) throw error;
    throw await undone(c, error, async () => {
      await restore(fs, staged, from);
      await discard(fs, staged);
    }, `what was moving is at ${staged}`);
  }
}

/** `error`, once `undo` has put things back; when it could not, EIO naming both and what is left where. */
async function undone(c: Carry, error: unknown, undo: () => Promise<void>, left: string): Promise<unknown> {
  try {
    await undo();
    return error;
  } catch (failure) {
    const cause = error instanceof Error ? error.message : String(error);
    const undoing = failure instanceof Error ? failure.message : String(failure);
    return c.refused('EIO', `the move failed (${cause}) and undoing it failed (${undoing}); ${left}`);
  }
}

/**
 * The staged copy into the destination's place: one rename over it. Where
 * the filesystem has no rename in place, the destination is replaced where
 * it is, and what it held is kept and put back on a failure.
 */
async function place(c: Carry): Promise<void> {
  const { fs, staged, to, from, source, existing } = c;
  if (typeof fs.rename === 'function') {
    try {
      await fs.rename(staged, to);
      return;
    } catch (error) {
      const outcome = renameOutcome(error);
      const refused = outcome === 'none' || (outcome === undefined && isVfsError(error) && RENAME_REFUSALS.has(error.code));
      // EXDEV: this filesystem cannot rename in place, and the copy goes there another way, below.
      if (!(refused && isVfsError(error, 'EXDEV'))) {
        // Refused before anything changed: the caller puts the source back and rethrows it.
        if (refused) throw error;
        c.settled = true;
        // Said to have moved it all: the move happened, and the staged name holds residue.
        if (outcome === 'all') return await dropResidue(c);
        // Anything else may have renamed it in whole or in part, and another
        // writer may since have used the destination: nothing is undone.
        const cause = error instanceof Error ? error.message : String(error);
        throw c.refused('EIO', `renaming ${staged} to ${to} failed (${cause}), and may have been done in whole or in part, `
          + `so nothing was undone or removed: ${from} is gone, and what was moving is at ${staged}, at ${to}, or partly at each`, error);
      }
    }
  }
  const kept = existing === null ? null : await keep(fs, to, existing);
  try {
    // Replaced, as a rename replaces it, never written through: the copy is
    // never seen under what the destination's mode allowed.
    if (existing !== null) await removeEntry(fs, to, existing);
    await copyEntry(fs, staged, source, to, { named: to });
    await confirm(c, to);
  } catch (error) {
    throw await undone(c, error, () => putBack(fs, to, kept), `${to} could not be put back as it was`);
  }
  // The destination holds the whole copy: the move has happened.
  c.settled = true;
  await dropResidue(c);
}

/** What is left at the staged name once the move has happened goes; EIO, saying the move happened, when it cannot. */
async function dropResidue(c: Carry): Promise<void> {
  try {
    await discard(c.fs, c.staged);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw c.refused('EIO', `moved to ${c.to}, but what was left at ${c.staged} could not be removed (${cause})`, error);
  }
}

/** What a destination held, to put back. */
type Kept =
  | { type: 'file'; bytes: Uint8Array; stat: VfsStat }
  | { type: 'symlink'; target: string }
  | { type: 'directory'; stat: VfsStat };

async function keep(fs: MoveFs, path: string, stat: VfsStat): Promise<Kept> {
  // A copy: a backend may hand out its own buffer, which the overwrite then changes.
  if (stat.type === 'file') return { type: 'file', bytes: (await fs.readFile(path)).slice(), stat };
  if (stat.type === 'symlink') return { type: 'symlink', target: await readlinkOf(fs, path) };
  return { type: 'directory', stat };
}

/** `kept` back at `path`, made at its own mode: what it held was readable under that mode already. */
async function putBack(fs: MoveFs, path: string, kept: Kept | null): Promise<void> {
  const now = await fs.stat(path, { follow: false });
  if (now !== null) await removeEntry(fs, path, now);
  if (kept === null) return;
  if (kept.type === 'symlink') {
    await fs.symlink!(kept.target, path);
    return;
  }
  if (kept.type === 'file') await fs.writeFile(path, kept.bytes, { mode: permissions(kept.stat) });
  else await fs.mkdir(path, { mode: permissions(kept.stat) });
  await preserve(fs, kept.stat, path, path, undefined);
}

interface CopyOptions {
  /** Where the entry ends up, for what is reported. */
  readonly named: string;
  readonly onPreserveFailure?: PreserveFailure;
}

/**
 * Copy one entry (a tree, for a directory) onto a name that is not there,
 * links as links. Each file and directory is made private and given its own
 * mode and times, best effort, once what it holds is complete.
 */
async function copyEntry(fs: MoveFs, from: string, stat: VfsStat, to: string, options: CopyOptions): Promise<void> {
  const { named, onPreserveFailure } = options;
  if (stat.type === 'symlink') {
    if (typeof fs.symlink !== 'function') throw syscallError('ENOTSUP', 'symlink', named, { detail: 'this filesystem cannot hold a link' });
    await fs.symlink(await readlinkOf(fs, from), to);
    return;
  }
  // A source with no mode has nothing to keep private: it is made as any new entry is.
  const own = permissions(stat) !== undefined;
  if (stat.type === 'directory') {
    await fs.mkdir(to, own ? { mode: 0o700 } : undefined);
    for (const entry of await fs.readdir(from)) {
      const child = join(from, entry.name);
      const childStat = entry.stat ?? await fs.stat(child, { follow: false });
      // Gone since the listing: nothing to carry.
      if (childStat === null) continue;
      await copyEntry(fs, child, childStat, join(to, entry.name), { ...options, named: join(named, entry.name) });
    }
  } else {
    // Bytes, never the namespace's copy: across filesystems it makes the file without a mode.
    await fs.writeFile(to, await fs.readFile(from), own ? { mode: 0o600 } : undefined);
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
  if (heldStat === null) throw syscallError('EIO', 'rename', path, { detail: `nothing to put it back from: ${held} is gone` });
  const now = await fs.stat(path, { follow: false });
  if (now === null) {
    await copyEntry(fs, held, heldStat, path, { named: path });
    return;
  }
  if (now.type !== 'directory' || heldStat.type !== 'directory') return;
  for (const entry of await fs.readdir(held)) await restore(fs, join(held, entry.name), join(path, entry.name));
}

async function readlinkOf(fs: MoveFs, path: string): Promise<string> {
  if (typeof fs.readlink !== 'function') throw syscallError('ENOTSUP', 'readlink', path, { detail: 'this filesystem cannot read a link' });
  return await fs.readlink(path);
}

/** `path` with every link on it followed: the namespace's realpath, or a walk where it has none. */
async function physical(fs: MoveFs, path: string): Promise<string> {
  if (typeof fs.realpath === 'function') return await fs.realpath(path);
  const pending = path.split('/');
  const resolved: string[] = [];
  for (let hops = 0; pending.length > 0;) {
    const name = pending.shift()!;
    if (name === '' || name === '.') continue;
    if (name === '..') {
      resolved.pop();
      continue;
    }
    const at = `/${[...resolved, name].join('/')}`;
    if (typeof fs.readlink !== 'function' || (await fs.stat(at, { follow: false }))?.type !== 'symlink') {
      resolved.push(name);
      continue;
    }
    if (++hops > 40) throw syscallError('ELOOP', 'rename', path);
    const target = await fs.readlink(at);
    if (target.startsWith('/')) resolved.length = 0;
    pending.unshift(...target.split('/'));
  }
  return `/${resolved.join('/')}`;
}

/** The directory holding `path` and its last component; a bare name's directory is `.`, which means the same one. */
function parentAndName(path: string): [string, string] {
  const cut = path.lastIndexOf('/');
  return [cut < 0 ? '.' : cut === 0 ? '/' : path.slice(0, cut), path.slice(cut + 1)];
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
