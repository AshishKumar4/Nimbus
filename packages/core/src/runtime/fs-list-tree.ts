import { FS_LIST_PAGE_LIMIT } from '../constants.js';
import { normalizeVfsPath } from '../vfs/path.js';
import type { RuntimeFsBridge, VfsListEntry, VfsListTree } from './os-contracts.js';

/** Walks a subtree's listing begins before it is refused (EAGAIN): each met a change between its pages. */
const LIST_TREE_WALKS = 4;

/**
 * Everything beneath directory `root` that `bridge`'s process may see, as
 * its listing pages it, walked here at once: every entry current at one
 * revision (a walk whose pages are not all at one is walked again), and the
 * subtree whole. Past `maxEntries` it is refused (E2BIG), so the caller
 * lists it some other way rather than mistaking part of it for all of it.
 * The session's fsListTree (session/rpc.ts).
 */
export async function subtreeListing(bridge: Pick<RuntimeFsBridge, 'list'>, root: string, maxEntries: number): Promise<VfsListTree> {
  const key = normalizeVfsPath(root);
  for (let walk = 0; walk < LIST_TREE_WALKS; walk++) {
    const listed = await walkOnce(bridge, key, maxEntries);
    if (listed !== null) return listed;
  }
  throw Object.assign(new Error(`EAGAIN: /${key} changed while it was listed`), { code: 'EAGAIN' });
}

/** One walk of the subtree at `key`; null when a page was at another revision than the first. */
async function walkOnce(bridge: Pick<RuntimeFsBridge, 'list'>, key: string, maxEntries: number): Promise<VfsListTree | null> {
  const prefix = key === '' ? '' : `${key}/`;
  let after: string | null = key === '' ? null : prefix;
  let at: { epoch: string; rev: number } | null = null;
  const entries: VfsListEntry[] = [];
  for (;;) {
    const page = await bridge.list(after, FS_LIST_PAGE_LIMIT);
    if (at === null) at = { epoch: page.epoch, rev: page.rev };
    else if (page.epoch !== at.epoch || page.rev !== at.rev) return null;
    for (const entry of page.entries) {
      const path = normalizeVfsPath(entry.path);
      if (path === key) continue;
      if (!path.startsWith(prefix)) return { ...at, entries };
      if (entries.length === maxEntries) {
        throw Object.assign(new Error(`E2BIG: /${key} holds more than ${maxEntries} entries`), { code: 'E2BIG' });
      }
      entries.push(entry);
    }
    if (page.next === null) return { ...at, entries };
    after = page.next;
  }
}
