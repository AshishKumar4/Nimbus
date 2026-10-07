/**
 * git/clone-job.ts — a clone's durable job record, and the cleanup of a
 * clone that failed or was cut short, as git's remove_junk (builtin/clone.c)
 * cleans up after one.
 *
 * A clone's record (DO storage, CLONE_JOB_PREFIX and its destination) is
 * written under the clone's lease before the clone writes anything. It names
 * the job (its id is the one the clone's marker, .git/nimbus-clone-job,
 * carries), the credential the clone writes as, whether the destination
 * existed, and the clone's phase: 'transport' until every object the clone
 * fetches is in, then 'checkout' (git's junk_mode: JUNK_LEAVE_NONE, then
 * JUNK_LEAVE_REPO). It goes when the clone has finished, or its cleanup has.
 *
 * Cleanup runs in the DO on the session's filesystem, as the record's
 * credential, a slice of entries at a time with the DO yielded between
 * slices (a worktree of 33,980 files must not hold it):
 *   transport  everything in the destination, files first, then the
 *              directories deepest first, the job marker last; then the
 *              destination itself unless it existed (git keeps one that did,
 *              emptied)
 *   checkout   only what is Nimbus's: the clone's staging directory, its
 *              temporary packs and the job marker; the repository and what
 *              was checked out stay, as git leaves them ("Clone succeeded,
 *              but checkout failed.")
 * Each slice walks afresh, so a cleanup cut short (a reset) is finished by
 * the next: a session finishes, at start, every record whose clone is not
 * running. A destination whose marker names another job is not the
 * record's to touch: only the record goes.
 */
export const CLONE_JOB_PREFIX = 'git-clone-job:';
/** The marker a clone writes first in its .git (network-facet.ts GIT_CLONE_JOB_MARKER). */
const MARKER = 'nimbus-clone-job';
/** The clone's own scratch in .git: its staging directory, and its temporary packs' prefix. */
const STAGE_DIR = '.git/nimbus-clone';
const PACK_DIR = '.git/objects/pack';
const TMP_PACK_PREFIX = 'tmp_pack_';
/** Entries a cleanup removes before it yields the DO. */
export const CLEANUP_SLICE_ENTRIES = 2000;
const key = (dir) => CLONE_JOB_PREFIX + dir;
export async function writeCloneJob(storage, record) {
    await storage.put(key(record.dir), record);
}
export async function setCloneJobPhase(storage, record, phase) {
    record.phase = phase;
    await storage.put(key(record.dir), record);
}
export async function deleteCloneJob(storage, dir) {
    await storage.delete(key(dir));
}
export async function listCloneJobs(storage) {
    return [...(await storage.list({ prefix: CLONE_JOB_PREFIX })).values()];
}
function isAbsent(error) {
    const code = error?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}
/** The job the destination's marker names: null with no marker; undefined when it is not one. */
function markerJob(fs, dir) {
    let raw;
    try {
        raw = fs.readFile(dir + '/.git/' + MARKER);
    }
    catch (error) {
        if (isAbsent(error))
            return null;
        throw error;
    }
    try {
        const marker = JSON.parse(new TextDecoder().decode(raw));
        return typeof marker.jobId === 'string' ? marker.jobId : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The record's cleanup, then the record. `yieldBetween` lets the DO serve
 * others between slices; `sliceEntries` bounds a slice.
 */
export async function cleanUpClone(fs, storage, record, options = {}) {
    const sliceEntries = options.sliceEntries ?? CLEANUP_SLICE_ENTRIES;
    const yieldBetween = options.yieldBetween ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    const { dir } = record;
    const job = markerJob(fs, dir);
    if (job !== null && job !== record.jobId) {
        await deleteCloneJob(storage, dir);
        return { outcome: 'not-ours', removed: 0, slices: 0 };
    }
    let removed = 0;
    let slices = 0;
    // With no marker the clone wrote nothing yet, or an earlier cleanup got as
    // far as removing it: only what comes after the marker is left to do.
    if (job !== null) {
        const marker = dir + '/.git/' + MARKER;
        const targets = record.phase === 'transport'
            ? [dir]
            : [dir + '/' + STAGE_DIR, ...tmpPacks(fs, dir)];
        for (;;) {
            const done = removeSlice(fs, targets, marker, record.phase === 'transport' ? dir : null, sliceEntries);
            removed += done.removed;
            slices++;
            if (done.complete)
                break;
            await yieldBetween();
        }
        fs.unlink(marker);
        removed++;
    }
    if (record.phase === 'transport') {
        // Empty now, unless something not the clone's is in them (then they stay).
        removed += removeIfEmpty(fs, dir + '/.git');
        if (!record.rootExisted)
            removed += removeIfEmpty(fs, dir);
    }
    await deleteCloneJob(storage, dir);
    return { outcome: record.phase === 'transport' ? 'removed' : 'kept-repo', removed, slices };
}
/** 1 when the empty directory `path` was removed; 0 when it is gone or not empty. */
function removeIfEmpty(fs, path) {
    try {
        fs.rmdir(path);
        return 1;
    }
    catch (error) {
        const code = error?.code;
        if (isAbsent(error) || code === 'ENOTEMPTY')
            return 0;
        throw error;
    }
}
/**
 * The cleanup of every clone a previous generation of the session left
 * (records from before `generationStartedAt`: no clone of this generation
 * wrote them, so none is running), each under its own lease while it runs.
 * One whose destination another holds the lease on is left for the next
 * generation.
 */
export async function finishInterruptedClones(vfs, storage, generationStartedAt) {
    const outcomes = [];
    for (const record of await listCloneJobs(storage)) {
        if (record.startedAt >= generationStartedAt)
            continue;
        let owner;
        try {
            owner = vfs.as(record.cred).acquireExclusiveMutation(record.dir, { includeMissingAncestors: true }).owner;
        }
        catch {
            continue;
        }
        try {
            outcomes.push(await cleanUpClone(vfs.as(record.cred, { mutationOwner: owner }), storage, record));
        }
        finally {
            vfs.releaseExclusiveMutation(owner);
        }
    }
    return outcomes;
}
/** The clone's temporary packs, by name. */
function tmpPacks(fs, dir) {
    try {
        return fs.readdir(dir + '/' + PACK_DIR).filter(({ name }) => name.startsWith(TMP_PACK_PREFIX)).map(({ name }) => dir + '/' + PACK_DIR + '/' + name);
    }
    catch (error) {
        if (isAbsent(error))
            return [];
        throw error;
    }
}
/**
 * One slice: up to `limit` removals under `targets` (each a file or a
 * directory taken whole), files before the directories that held them,
 * never `marker`; a target that is `keep` is emptied, not removed. Complete
 * when nothing but the marker (and the kept target) is left.
 */
function removeSlice(fs, targets, marker, keep, limit) {
    let removed = 0;
    // Depth first: a directory goes once it is empty.
    const visit = (path, type) => {
        if (removed >= limit)
            return false;
        if (type === 'directory') {
            let entries;
            try {
                entries = fs.readdir(path);
            }
            catch (error) {
                if (isAbsent(error))
                    return true;
                throw error;
            }
            let empty = true;
            for (const entry of entries) {
                const child = path + '/' + entry.name;
                if (child === marker) {
                    empty = false;
                    continue;
                }
                if (!visit(child, entry.type))
                    return false;
            }
            if (!empty || path === keep)
                return true;
            if (removed >= limit)
                return false;
            try {
                fs.rmdir(path);
            }
            catch (error) {
                if (!isAbsent(error))
                    throw error;
            }
            removed++;
            return true;
        }
        try {
            fs.unlink(path);
        }
        catch (error) {
            if (!isAbsent(error))
                throw error;
        }
        removed++;
        return true;
    };
    for (const target of targets) {
        if (!visit(target, kindOf(fs, target)))
            return { removed, complete: false };
    }
    return { removed, complete: true };
}
function kindOf(fs, path) {
    const slash = path.lastIndexOf('/');
    const parent = slash < 0 ? '' : path.slice(0, slash);
    const name = path.slice(slash + 1);
    try {
        return fs.readdir(parent).find((entry) => entry.name === name)?.type ?? 'missing';
    }
    catch (error) {
        if (isAbsent(error))
            return 'missing';
        throw error;
    }
}
