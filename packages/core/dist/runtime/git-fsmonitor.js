/** Git's fsmonitor hook protocol v2, over the existing VFS coherence read API.
 * Tokens are global revisions. Their epoch/provenance is held only in this
 * incarnation, bounded by the same LRU primitive as other runtime caches.
 * An unknown/expired token, restore, or new host always invalidates all. */
import { LruMap } from '../_shared/lru-map.js';
import { normalizeVfsPath } from '../vfs/path.js';
const REPOSITORIES = 128;
const TOKENS_PER_REPOSITORY = 32;
const MAX_REPLY_BYTES = 64 * 1024;
const encoder = new TextEncoder();
export function makeGitFsmonitor() {
    const trusted = new LruMap(REPOSITORIES);
    return {
        async query({ fs, cwd, cred, token }) {
            const root = normalizeVfsPath(cwd);
            const key = JSON.stringify([root, cred.uid, cred.gid, [...cred.groups].sort((a, b) => a - b)]);
            const cursor = /^(0|[1-9]\d*)$/.test(token) && Number.isSafeInteger(Number(token)) ? Number(token) : -1;
            let history = trusted.get(key);
            const epoch = cursor >= 0 ? history?.tokens.get(cursor) ?? null : null;
            const delta = await fs.acquire(epoch, Math.max(0, cursor), { namespace: true });
            if (!Number.isSafeInteger(delta.rev) || delta.rev < 0)
                throw new Error('fsmonitor: invalid VFS revision');
            if (!history) {
                history = { epoch: delta.epoch, untrustedThrough: cursor, highWater: delta.rev, tokens: new LruMap(TOKENS_PER_REPOSITORY) };
                trusted.set(key, history);
            }
            else if (history.epoch !== delta.epoch) {
                // Numeric revisions can repeat after a restore. Never re-authorize
                // an old token simply because we returned that number in a new epoch.
                history.untrustedThrough = Math.max(history.untrustedThrough, history.highWater, cursor);
                history.epoch = delta.epoch;
                history.tokens.clear();
            }
            history.highWater = Math.max(history.highWater, delta.rev);
            if (delta.rev > history.untrustedThrough)
                history.tokens.set(delta.rev, delta.epoch);
            const reply = (paths) => encoder.encode(`${delta.rev}\0${paths.map((path) => `${path}\0`).join('')}`);
            if (epoch === null || delta.poison || cursor > delta.rev)
                return reply(['/']);
            const paths = new Set();
            const prefix = root === '' ? '' : `${root}/`;
            let sawRoot = false;
            let size = String(delta.rev).length + 1;
            for (const entry of delta.paths) {
                const path = normalizeVfsPath(entry.path);
                // A structural/subtree change at an ancestor covers this worktree.
                if ((entry.structural || entry.subtree) && (path === root || root.startsWith(`${path}/`) || path === ''))
                    return reply(['/']);
                if (path === root) {
                    sawRoot = true;
                    continue;
                }
                if (!path.startsWith(prefix))
                    continue;
                sawRoot = true;
                const relative = path.slice(prefix.length);
                if (relative === '.git' || relative.startsWith('.git/'))
                    continue;
                // The feed includes parent-directory watermark stamps. The actual
                // changed path invalidates Git's untracked parent too; do not force
                // an entire subtree stat for every sibling of a single changed file.
                if (entry.stat?.type === 'directory' && !entry.structural && !entry.subtree)
                    continue;
                const name = entry.structural || entry.subtree || entry.stat?.type === 'directory' ? `${relative}/` : relative;
                if (paths.has(name))
                    continue;
                size += encoder.encode(name).byteLength + 1;
                if (size > MAX_REPLY_BYTES)
                    return reply(['/']);
                paths.add(name);
            }
            // A symlinked cwd may not use the storage names in the revision feed.
            // Its subtree watermark still moves: fail closed, never answer clean
            // when a changed tree cannot be located among the visible log names.
            if (!sawRoot && await fs.revision(root) > cursor)
                return reply(['/']);
            return reply([...paths].sort());
        },
    };
}
