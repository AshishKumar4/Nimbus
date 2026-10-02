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
 * cannot rename in place has the destination replaced where it is, after
 * what it held is kept to put back.
 *
 * Everything it creates is created private (the owner's bits only, as GNU
 * cp creates a copy before it sets the mode) and given its own mode once its
 * content is complete, so no one reads a copy its source would not let them.
 *
 * Neither atomic to a reader nor across a crash: from the source's removal
 * to the final rename, what is moving is only at the staged name,
 * `.nimbus-move-<id>` in the destination's directory.
 */
import { sha256Hex } from '../_shared/crypto.js';
import { isVfsError, syscallError } from './vfs-error.js';
/** Move `from` to `to` as mv does: one rename, or a carry across filesystems (above). Directories too. */
export async function move(fs, from, to, options = {}) {
    if (typeof fs.rename === 'function') {
        try {
            await fs.rename(from, to);
            return;
        }
        catch (error) {
            if (!isVfsError(error, 'EXDEV'))
                throw error;
        }
    }
    await carry(fs, from, to, options.onPreserveFailure);
}
async function carry(fs, fromInput, toInput, onPreserveFailure) {
    const refused = (code, detail) => syscallError(code, 'rename', fromInput, { dest: toInput, detail });
    const from = withoutTrailingSlash(fromInput);
    const spelled = withoutTrailingSlash(toInput);
    // rename(2)'s refusals, since the filesystem never got as far as making them.
    const source = await fs.stat(from, { follow: false });
    if (source === null)
        throw refused('ENOENT');
    const directory = source.type === 'directory';
    if (!directory && (from !== fromInput || spelled !== toInput))
        throw refused('ENOTDIR');
    const [fromParent, fromName] = parentAndName(from);
    const [toParent, toName] = parentAndName(spelled);
    // A last component of `.` or `..` names a directory by its relation to another (Linux: EBUSY).
    if ([fromName, toName].some((name) => name === '' || name === '.' || name === '..'))
        throw refused('EBUSY');
    const holder = await fs.stat(toParent);
    if (holder === null)
        throw refused('ENOENT');
    if (holder.type !== 'directory')
        throw refused('ENOTDIR');
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
    if (at === to || sameFile)
        throw refused('EINVAL', 'source and destination are the same file');
    if (existing !== null) {
        if (directory && existing.type !== 'directory')
            throw refused('ENOTDIR');
        if (!directory && existing.type === 'directory')
            throw refused('EISDIR');
        if (directory && (await fs.readdir(to)).length > 0)
            throw refused('ENOTEMPTY');
    }
    if (directory && within(parent, at))
        throw refused('EINVAL', 'a directory cannot move beneath itself');
    const staged = join(parent, `.nimbus-move-${crypto.randomUUID()}`);
    const c = { fs, from, to, staged, source, existing, manifest: new Map(), onPreserveFailure, settled: false, refused };
    try {
        await copyEntry(fs, from, source, staged, { named: to, onPreserveFailure, manifest: c.manifest });
        await confirm(c, staged);
    }
    catch (error) {
        throw await undone(c, error, () => discard(fs, staged), `${from} is as it was, and part of a copy is left at ${staged}`);
    }
    // The copy is confirmed: the source goes, then the copy takes the destination's place.
    try {
        await removeEntry(fs, from, source);
        // Confirmed too: a backend that reported a partial removal whole would leave a move half made.
        if (await fs.stat(from, { follow: false }) !== null)
            throw refused('EIO', `${from} is still there after its removal`);
        await place(c);
    }
    catch (error) {
        if (c.settled)
            throw error;
        throw await undone(c, error, async () => {
            await restore(fs, staged, from);
            await discard(fs, staged);
        }, `what was moving is at ${staged}`);
    }
}
/** `error`, once `undo` has put things back; when it could not, EIO naming both and what is left where. */
async function undone(c, error, undo, left) {
    try {
        await undo();
        return error;
    }
    catch (failure) {
        const cause = error instanceof Error ? error.message : String(error);
        const undoing = failure instanceof Error ? failure.message : String(failure);
        return c.refused('EIO', `the move failed (${cause}) and undoing it failed (${undoing}); ${left}`);
    }
}
/**
 * The staged copy into the destination's place: one rename over it. Where
 * the filesystem has no rename in place, the destination is written where
 * it is, and what it held is kept and put back on a failure.
 */
async function place(c) {
    const { fs, staged, to, from, source, existing } = c;
    if (typeof fs.rename === 'function') {
        try {
            await fs.rename(staged, to);
            return;
        }
        catch (error) {
            if (!isVfsError(error, 'EXDEV')) {
                await settle(c, error);
                return;
            }
        }
    }
    const kept = existing === null ? null : await keep(fs, to, existing);
    try {
        // Replaced, as a rename replaces it, never written through: the copy is
        // never seen under what the destination's mode allowed.
        if (existing !== null)
            await removeEntry(fs, to, existing);
        await copyEntry(fs, staged, source, to, { named: to });
        await confirm(c, to);
    }
    catch (error) {
        throw await undone(c, error, () => putBack(fs, to, kept), `${to} could not be put back as it was`);
    }
    try {
        await discard(fs, staged);
    }
    catch (error) {
        // The staged copy was the witness the source is put back from, and part
        // of it may be gone now; the destination holds the whole copy.
        throw await undone(c, error, async () => {
            await restore(fs, to, from);
            await putBack(fs, to, kept);
        }, `what was moving is at ${to}`);
    }
}
/**
 * After the final rename failed, where the copy is. A backend can fail a
 * rename it has made, in whole or in part: SqliteVFS moves a tree in bounded
 * steps, publishing it at the destination before it retires the staged name,
 * and a mounted backend can apply a rename and still throw. So the outcome is
 * read from what each name holds, against the copy's manifest; never from the
 * error, and never from inode numbers, which a namespace may derive from the
 * path.
 *
 * The destination holding the copy is a move that happened: the remainder at
 * the staged name goes. The staged name holding it is a move that did not:
 * a tree published in part is taken back, and the caller undoes the rest.
 * Neither holding it is the one loss a carry cannot undo, and it says so,
 * naming what is in neither.
 */
async function settle(c, error) {
    const { fs, to, staged, from, existing, source } = c;
    const cause = error instanceof Error ? error.message : String(error);
    const atDestination = await manifestOf(fs, to);
    if (holdsCopy(atDestination, c.manifest)) {
        c.settled = true;
        try {
            // Its own mode and times, should the destination have held these bytes all along.
            await preserve(fs, source, to, to, c.onPreserveFailure);
            await discard(fs, staged);
        }
        catch (failure) {
            const left = failure instanceof Error ? failure.message : String(failure);
            throw c.refused('EIO', `moved to ${to}, but what was left at ${staged} could not be removed (${left})`);
        }
        return;
    }
    const atStaged = await manifestOf(fs, staged);
    if (holdsCopy(atStaged, c.manifest)) {
        // Only a tree is published in parts, and a tree replaces nothing or an empty directory.
        if (source.type === 'directory') {
            const now = await fs.stat(to, { follow: false });
            const untouched = now === null
                ? existing === null
                : existing !== null && now.type === 'directory' && (await fs.readdir(to)).length === 0;
            if (!untouched)
                await putBack(fs, to, existing === null ? null : { type: 'directory', stat: existing });
        }
        throw error;
    }
    c.settled = true;
    const lost = [...c.manifest].filter(([rel, entry]) => atDestination?.get(rel) !== entry && atStaged?.get(rel) !== entry);
    const named = lost.slice(0, 20).map(([rel]) => (rel === '' ? from : join(from, rel))).join(', ');
    throw c.refused('EIO', `the move failed (${cause}), and neither ${to} nor ${staged} holds the whole of ${from}, which is gone; `
        + (lost.length === 0 ? 'what was moving is split between them' : `in neither: ${named}${lost.length > 20 ? `, and ${lost.length - 20} more` : ''}`));
}
/** The manifest of what is at `path` now, or null where it cannot be read. */
async function manifestOf(fs, path) {
    const manifest = new Map();
    const walk = async (at, rel, stat) => {
        if (stat.type === 'directory') {
            manifest.set(rel, 'directory');
            for (const entry of await fs.readdir(at)) {
                const child = join(at, entry.name);
                const childStat = await fs.stat(child, { follow: false });
                if (childStat !== null)
                    await walk(child, rel === '' ? entry.name : `${rel}/${entry.name}`, childStat);
            }
        }
        else if (stat.type === 'symlink')
            manifest.set(rel, `symlink ${await readlinkOf(fs, at)}`);
        else
            manifest.set(rel, await fileEntry(await fs.readFile(at)));
    };
    try {
        const stat = await fs.stat(path, { follow: false });
        if (stat === null)
            return null;
        await walk(path, '', stat);
        return manifest;
    }
    catch (error) {
        // What cannot be read is not known to hold anything.
        if (isVfsError(error))
            return null;
        throw error;
    }
}
function holdsCopy(found, copy) {
    return found !== null && found.size === copy.size && [...copy].every(([rel, entry]) => found.get(rel) === entry);
}
async function fileEntry(bytes) {
    return `file ${bytes.byteLength} ${await sha256Hex(bytes)}`;
}
async function keep(fs, path, stat) {
    // A copy: a backend may hand out its own buffer, which the overwrite then changes.
    if (stat.type === 'file')
        return { type: 'file', bytes: (await fs.readFile(path)).slice(), stat };
    if (stat.type === 'symlink')
        return { type: 'symlink', target: await readlinkOf(fs, path) };
    return { type: 'directory', stat };
}
/** `kept` back at `path`, made at its own mode: what it held was readable under that mode already. */
async function putBack(fs, path, kept) {
    const now = await fs.stat(path, { follow: false });
    if (now !== null)
        await removeEntry(fs, path, now);
    if (kept === null)
        return;
    if (kept.type === 'symlink') {
        await fs.symlink(kept.target, path);
        return;
    }
    if (kept.type === 'file')
        await fs.writeFile(path, kept.bytes, { mode: permissions(kept.stat) });
    else
        await fs.mkdir(path, { mode: permissions(kept.stat) });
    await preserve(fs, kept.stat, path, path, undefined);
}
/**
 * Copy one entry (a tree, for a directory) onto a name that is not there,
 * links as links. Each file and directory is made private and given its own
 * mode and times, best effort, once what it holds is complete.
 */
async function copyEntry(fs, from, stat, to, options, rel = '') {
    const { named, onPreserveFailure, manifest } = options;
    if (stat.type === 'symlink') {
        if (typeof fs.symlink !== 'function')
            throw syscallError('ENOTSUP', 'symlink', named, { detail: 'this filesystem cannot hold a link' });
        const target = await readlinkOf(fs, from);
        await fs.symlink(target, to);
        manifest?.set(rel, `symlink ${target}`);
        return;
    }
    // A source with no mode has nothing to keep private: it is made as any new entry is.
    const own = permissions(stat) !== undefined;
    if (stat.type === 'directory') {
        await fs.mkdir(to, own ? { mode: 0o700 } : undefined);
        manifest?.set(rel, 'directory');
        for (const entry of await fs.readdir(from)) {
            const child = join(from, entry.name);
            const childStat = entry.stat ?? await fs.stat(child, { follow: false });
            // Gone since the listing: nothing to carry.
            if (childStat === null)
                continue;
            await copyEntry(fs, child, childStat, join(to, entry.name), { ...options, named: join(named, entry.name) }, rel === '' ? entry.name : `${rel}/${entry.name}`);
        }
    }
    else {
        // Bytes, never the namespace's copy: across filesystems it makes the file without a mode.
        const bytes = await fs.readFile(from);
        await fs.writeFile(to, bytes, own ? { mode: 0o600 } : undefined);
        manifest?.set(rel, await fileEntry(bytes));
    }
    await preserve(fs, stat, to, named, onPreserveFailure);
}
async function preserve(fs, stat, path, named, onPreserveFailure) {
    const attempt = async (what, apply) => {
        try {
            await apply();
        }
        catch (error) {
            if (!isVfsError(error))
                throw error;
            await onPreserveFailure?.({ what, path: named, error });
        }
    };
    if (typeof fs.utimes === 'function')
        await attempt('times', () => fs.utimes(path, stat.atimeMs ?? stat.mtimeMs, stat.mtimeMs));
    const mode = permissions(stat);
    if (typeof fs.chmod === 'function' && mode !== undefined)
        await attempt('permissions', () => fs.chmod(path, mode));
}
/** The copy at `path` is the source's kind of entry, and for a file, its size: what the source may go on. */
async function confirm(c, path) {
    const landed = await c.fs.stat(path, { follow: false });
    if (landed === null || landed.type !== c.source.type || (c.source.type === 'file' && landed.size !== c.source.size)) {
        throw c.refused('EIO', `the copy at ${path} is not what was copied`);
    }
}
/** rm -r of one entry, or its first failure. */
async function removeEntry(fs, path, stat) {
    if (stat.type !== 'directory') {
        await fs.unlink(path);
        return;
    }
    if (typeof fs.removeRecursive === 'function') {
        const failure = (await fs.removeRecursive(path))?.failures[0];
        if (failure !== undefined)
            throw failure.error;
        return;
    }
    for (const entry of await fs.readdir(path)) {
        const child = join(path, entry.name);
        const childStat = entry.stat ?? await fs.stat(child, { follow: false });
        if (childStat !== null)
            await removeEntry(fs, child, childStat);
    }
    if (typeof fs.rmdir === 'function')
        await fs.rmdir(path);
    else
        await fs.unlink(path);
}
async function discard(fs, path) {
    const stat = await fs.stat(path, { follow: false });
    if (stat !== null)
        await removeEntry(fs, path, stat);
}
/** Put back from `held` (a whole copy) whatever of `path` is gone; what is still there stays. */
async function restore(fs, held, path) {
    const heldStat = await fs.stat(held, { follow: false });
    if (heldStat === null)
        throw syscallError('EIO', 'rename', path, { detail: `nothing to put it back from: ${held} is gone` });
    const now = await fs.stat(path, { follow: false });
    if (now === null) {
        await copyEntry(fs, held, heldStat, path, { named: path });
        return;
    }
    if (now.type !== 'directory' || heldStat.type !== 'directory')
        return;
    for (const entry of await fs.readdir(held))
        await restore(fs, join(held, entry.name), join(path, entry.name));
}
async function readlinkOf(fs, path) {
    if (typeof fs.readlink !== 'function')
        throw syscallError('ENOTSUP', 'readlink', path, { detail: 'this filesystem cannot read a link' });
    return await fs.readlink(path);
}
/** `path` with every link on it followed: the namespace's realpath, or a walk where it has none. */
async function physical(fs, path) {
    if (typeof fs.realpath === 'function')
        return await fs.realpath(path);
    const pending = path.split('/');
    const resolved = [];
    for (let hops = 0; pending.length > 0;) {
        const name = pending.shift();
        if (name === '' || name === '.')
            continue;
        if (name === '..') {
            resolved.pop();
            continue;
        }
        const at = `/${[...resolved, name].join('/')}`;
        if (typeof fs.readlink !== 'function' || (await fs.stat(at, { follow: false }))?.type !== 'symlink') {
            resolved.push(name);
            continue;
        }
        if (++hops > 40)
            throw syscallError('ELOOP', 'rename', path);
        const target = await fs.readlink(at);
        if (target.startsWith('/'))
            resolved.length = 0;
        pending.unshift(...target.split('/'));
    }
    return `/${resolved.join('/')}`;
}
/** The directory holding `path` and its last component; a bare name's directory is `.`, which means the same one. */
function parentAndName(path) {
    const cut = path.lastIndexOf('/');
    return [cut < 0 ? '.' : cut === 0 ? '/' : path.slice(0, cut), path.slice(cut + 1)];
}
function within(path, dir) {
    return path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}
function permissions(stat) {
    return stat.mode === undefined ? undefined : stat.mode & 0o7777;
}
function withoutTrailingSlash(path) {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed === '' && path.startsWith('/') ? '/' : trimmed;
}
function join(dir, name) {
    return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}
