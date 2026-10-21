import { FS_LIST_PAGE_LIMIT } from '../constants.js';
import { beforeSubtree, normalizeVfsPath } from '../vfs/path.js';
import { samePosition } from './feed-position.js';
/** Walks a subtree's listing begins before it is refused (EAGAIN): each met a change between its pages. */
const LIST_TREE_WALKS = 4;
/**
 * Everything beneath directory `root` that `bridge`'s process may see, as
 * its listing pages it, walked here at once: every entry current at one
 * position (a walk whose pages are not all at one is walked again), and the
 * subtree whole. Past `maxEntries` it is refused (E2BIG), so the caller
 * lists it some other way rather than mistaking part of it for all of it.
 * The root is walked as it stands, never followed: one that is not a
 * directory (missing, a file, a symlink) has nothing beneath it to walk, and
 * is refused (ENOENT, ENOTDIR) rather than listed as an empty directory; the
 * caller lists what a link leads to some other way.
 * The session's fsListTree (session/rpc.ts).
 */
export async function subtreeListing(bridge, root, maxEntries) {
    const key = normalizeVfsPath(root);
    for (let walk = 0; walk < LIST_TREE_WALKS; walk++) {
        const listed = await walkOnce(bridge, key, maxEntries);
        if (listed === null)
            continue;
        if (listed.entries.length === 0) {
            const at = await bridge.stat(`/${key}`, { followSymlinks: false });
            if (at === null)
                throw Object.assign(new Error(`ENOENT: /${key} is not there`), { code: 'ENOENT' });
            if (at.type !== 'directory')
                throw Object.assign(new Error(`ENOTDIR: /${key} is not a directory`), { code: 'ENOTDIR' });
        }
        return listed;
    }
    throw Object.assign(new Error(`EAGAIN: /${key} changed while it was listed`), { code: 'EAGAIN' });
}
/** One walk of the subtree at `key`; null when a page was at another position than the first. */
async function walkOnce(bridge, key, maxEntries) {
    const prefix = key === '' ? '' : `${key}/`;
    let after = key === '' ? null : prefix;
    let at = null;
    const entries = [];
    for (;;) {
        const page = await bridge.list(after, FS_LIST_PAGE_LIMIT);
        if (at === null)
            at = page.position;
        else if (!samePosition(page.position, at))
            return null;
        for (const entry of page.entries) {
            const path = normalizeVfsPath(entry.path);
            if (path === key || beforeSubtree(path, key))
                continue;
            if (!path.startsWith(prefix))
                return { position: at, entries };
            if (entries.length === maxEntries) {
                throw Object.assign(new Error(`E2BIG: /${key} holds more than ${maxEntries} entries`), { code: 'E2BIG' });
            }
            entries.push(entry);
        }
        if (page.next === null)
            return { position: at, entries };
        after = page.next;
    }
}
