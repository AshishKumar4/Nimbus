/** Git's fsmonitor v2 over the existing credential-bound coherence barrier.
 * Tokens are durable VFS revisions; an optional state port preserves issued
 * token provenance across hibernation, not a second mutation journal. */
import { LruMap } from '../_shared/lru-map.js';
import { normalizeVfsPath } from '../vfs/path.js';
const REPOSITORIES = 128;
const TOKENS_PER_REPOSITORY = 32;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_MOUNT_BYTES = 4096;
const encoder = new TextEncoder();
/** Bounded host metadata in its existing SQL port; no change to VFS tables. */
export function sqliteGitFsmonitorState(sql, namespace) {
    let ready = false;
    const init = () => {
        if (ready)
            return;
        sql.exec('CREATE TABLE IF NOT EXISTS nimbus_git_fsmonitor (key TEXT PRIMARY KEY, value TEXT NOT NULL, used INTEGER NOT NULL)');
        ready = true;
    };
    const keyFor = (key) => JSON.stringify([namespace, key]);
    return {
        load(key) {
            init();
            const row = [...sql.exec('SELECT value FROM nimbus_git_fsmonitor WHERE key = ?', keyFor(key))][0];
            return row === undefined ? null : String(row.value);
        },
        save(key, value) {
            init();
            sql.exec('INSERT OR REPLACE INTO nimbus_git_fsmonitor (key, value, used) VALUES (?, ?, (SELECT COALESCE(MAX(used), 0) + 1 FROM nimbus_git_fsmonitor))', keyFor(key), value);
            sql.exec('DELETE FROM nimbus_git_fsmonitor WHERE key NOT IN (SELECT key FROM nimbus_git_fsmonitor ORDER BY used DESC, key LIMIT ?)', REPOSITORIES);
        },
    };
}
const revision = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function restore(value) {
    if (value === null)
        return undefined;
    try {
        const row = JSON.parse(value);
        if (typeof row.epoch !== 'string' || !revision(row.highWater) || !Number.isSafeInteger(row.untrustedThrough)
            || row.untrustedThrough < -1 || !Array.isArray(row.tokens) || row.tokens.length > TOKENS_PER_REPOSITORY)
            return undefined;
        const tokens = new LruMap(TOKENS_PER_REPOSITORY);
        for (const token of row.tokens) {
            if (!revision(token.rev) || token.rev > row.highWater || token.rev <= row.untrustedThrough
                || !(token.mounts === null || (Array.isArray(token.mounts) && token.mounts.every((p) => typeof p === 'string'))))
                return undefined;
            const mounts = boundedMounts(token.mounts);
            tokens.set(token.rev, { epoch: row.epoch, mounts });
        }
        return { epoch: row.epoch, highWater: row.highWater, untrustedThrough: row.untrustedThrough, tokens };
    }
    catch {
        return undefined;
    }
}
function serialize(history) {
    const tokens = [...history.tokens.keys()].map((rev) => ({ rev, mounts: history.tokens.get(rev).mounts }));
    return JSON.stringify({ epoch: history.epoch, highWater: history.highWater, untrustedThrough: history.untrustedThrough, tokens });
}
/** Unknown/oversized mount metadata is full invalidation, never omission. */
function boundedMounts(mounts) {
    if (mounts === null)
        return null;
    const unique = [...new Set(mounts)].sort();
    return unique.reduce((bytes, path) => bytes + encoder.encode(path).byteLength + 1, 0) > MAX_MOUNT_BYTES ? null : unique;
}
const mergeMounts = (before, after) => before === null || after === null ? null : boundedMounts([...before, ...after]);
export function makeGitFsmonitor(state) {
    const trusted = new LruMap(REPOSITORIES);
    const pending = new Map();
    return {
        async query({ fs, cwd, cred, token, mounts = [] }) {
            const root = normalizeVfsPath(cwd);
            const key = JSON.stringify([root, cred.uid, cred.gid, [...cred.groups].sort((a, b) => a - b)]);
            // Serialize only this repository/principal: two helper children may
            // query concurrently, but neither may overwrite the other's tokens.
            const prior = pending.get(key);
            const work = (async () => {
                if (prior)
                    await prior.catch(() => { });
                const cursor = /^(0|[1-9]\d*)$/.test(token) && Number.isSafeInteger(Number(token)) ? Number(token) : -1;
                let history = trusted.get(key) ?? (state ? restore(await state.load(key)) : undefined);
                if (history)
                    trusted.set(key, history);
                const before = history ? serialize(history) : null;
                const issued = cursor >= 0 ? history?.tokens.get(cursor) : undefined;
                const epoch = issued?.epoch ?? null;
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
                // Every mounted backend is uncertain: its external writes have no
                // journal. Keep each issued revision's mount footprint, so unmounting
                // between queries also invalidates the old prefix. Reissuing the same
                // number unions footprints instead of falsely making an older token clean.
                const currentMounts = mounts === null ? null : boundedMounts(mounts.map(normalizeVfsPath).filter((point) => {
                    if (point === root || root.startsWith(point + '/') || point === '')
                        return true;
                    if (!point.startsWith(root === '' ? '' : root + '/'))
                        return false;
                    const relative = point.slice(root === '' ? 0 : root.length + 1);
                    return relative !== '.git' && !relative.startsWith('.git/');
                }));
                const dirtyMounts = mergeMounts(issued ? issued.mounts : [], currentMounts);
                if (delta.rev > history.untrustedThrough) {
                    const old = history.tokens.get(delta.rev);
                    history.tokens.set(delta.rev, { epoch: delta.epoch, mounts: mergeMounts(old ? old.mounts : [], currentMounts) });
                }
                const saved = serialize(history);
                if (state && saved !== before)
                    await state.save(key, saved);
                const reply = (paths) => encoder.encode(`${delta.rev}\0${paths.map((path) => `${path}\0`).join('')}`);
                if (epoch === null || delta.poison || cursor > delta.rev)
                    return reply(['/']);
                const paths = new Set();
                const prefix = root === '' ? '' : `${root}/`;
                let sawRoot = false;
                let size = String(delta.rev).length + 1;
                if (dirtyMounts === null)
                    return reply(['/']);
                for (const point of dirtyMounts) {
                    if (point === root || root.startsWith(point + '/') || point === '')
                        return reply(['/']);
                    const name = point.slice(prefix.length) + '/';
                    size += encoder.encode(name).byteLength + 1;
                    paths.add(name);
                }
                // Even this fast path is after acquisition: restore/epoch changes
                // and a pruned journal must be observed before answering clean.
                if (delta.paths.length === 0 && await fs.revision(root) <= cursor)
                    return reply([...paths].sort());
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
            })();
            pending.set(key, work);
            try {
                return await work;
            }
            finally {
                if (pending.get(key) === work)
                    pending.delete(key);
            }
        },
    };
}
