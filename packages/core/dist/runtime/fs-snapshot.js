import { FS_LIST_PAGE_LIMIT } from '../constants.js';
import { normalizeVfsPath } from '../vfs/path.js';
/**
 * Everything beneath directory `root` that `bridge`'s process may see, as
 * its listing pages it, walked here at once (a page of the session's own
 * filesystem is answered in the turn it is asked): every entry current at
 * one revision, and the subtree whole. Past `maxEntries` it is refused (E2BIG),
 * so the caller lists it some other way rather than mistaking part of it
 * for all of it. The session's fsSnapshot (session/rpc.ts).
 */
export async function subtreeSnapshot(bridge, root, maxEntries) {
    const key = normalizeVfsPath(root);
    const prefix = key === '' ? '' : `${key}/`;
    let after = key === '' ? null : prefix;
    let at = null;
    const entries = [];
    for (;;) {
        const page = await bridge.list(after, FS_LIST_PAGE_LIMIT);
        at ??= { epoch: page.epoch, rev: page.rev };
        for (const entry of page.entries) {
            const path = normalizeVfsPath(entry.path);
            if (path === key)
                continue;
            if (!path.startsWith(prefix))
                return { ...at, entries };
            if (entries.length === maxEntries) {
                throw Object.assign(new Error(`E2BIG: /${key} holds more than ${maxEntries} entries`), { code: 'E2BIG' });
            }
            entries.push(entry);
        }
        if (page.next === null)
            return { ...at, entries };
        after = page.next;
    }
}
