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
 * Each slice walks what is left, so a cleanup cut short (a reset) is
 * finished by the next generation of the session: it lists the records of
 * earlier generations before it serves anything, reserves each destination
 * (its lease) before the filesystem takes a write, and cleans them up in the
 * background. A destination whose marker names another job is not the
 * record's to touch: only the record goes. The clone proves its
 * destination absent or empty before it writes the record, so a cleanup
 * removes only what the clone made.
 */

import type { VfsCred } from '@nimbus-sh/core/vfs/vfs.js';

/** What a clone's job record says. */
export interface CloneJobRecord {
  version: 1;
  jobId: string;
  /** The destination, as the session's filesystem names it (no leading slash). */
  dir: string;
  /** The credential the clone writes as, and its cleanup removes as. */
  cred: VfsCred;
  /** The destination existed (empty) before the clone: its cleanup keeps it. */
  rootExisted: boolean;
  phase: 'transport' | 'checkout';
  /** The session's generation (fabric generation.ts) that ran the clone: an earlier one's clone is not running. */
  generation: number;
  startedAt: number;
}

/** The storage the records live in (DurableObjectStorage's async KV). */
export interface CloneJobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export const CLONE_JOB_PREFIX = 'git-clone-job:';
/** The marker a clone writes first in its .git (network-facet.ts GIT_CLONE_JOB_MARKER). */
const MARKER = 'nimbus-clone-job';
/** The clone's own scratch in .git: its staging directory, and its temporary packs' prefix. */
const STAGE_DIR = '.git/nimbus-clone';
const PACK_DIR = '.git/objects/pack';
const TMP_PACK_PREFIX = 'tmp_pack_';

/** Entries a cleanup removes before it yields the DO. */
export const CLEANUP_SLICE_ENTRIES = 2000;

const key = (dir: string) => CLONE_JOB_PREFIX + dir;

export async function writeCloneJob(storage: CloneJobStorage, record: CloneJobRecord): Promise<void> {
  await storage.put(key(record.dir), record);
}

export async function setCloneJobPhase(storage: CloneJobStorage, record: CloneJobRecord, phase: CloneJobRecord['phase']): Promise<void> {
  record.phase = phase;
  await storage.put(key(record.dir), record);
}

export async function deleteCloneJob(storage: CloneJobStorage, dir: string): Promise<void> {
  await storage.delete(key(dir));
}

export async function listCloneJobs(storage: CloneJobStorage): Promise<CloneJobRecord[]> {
  return [...(await storage.list<CloneJobRecord>({ prefix: CLONE_JOB_PREFIX })).values()];
}

/** What a cleanup works through: the session's filesystem, as the record's credential (and the clone's lease, while it holds one). */
export interface CleanupFs {
  readFile(path: string): Uint8Array;
  readdir(path: string): { name: string; type: string }[];
  unlink(path: string): void;
  rmdir(path: string): void;
}

/** How a cleanup went. */
export interface CleanupOutcome {
  /** 'removed': git's JUNK_LEAVE_NONE; 'kept-repo': JUNK_LEAVE_REPO; 'not-ours': another job's marker. */
  outcome: 'removed' | 'kept-repo' | 'not-ours';
  removed: number;
  slices: number;
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The job the destination's marker names: null with no marker; undefined when it is not one. */
function markerJob(fs: CleanupFs, dir: string): string | null | undefined {
  let raw: Uint8Array;
  try {
    raw = fs.readFile(dir + '/.git/' + MARKER);
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
  try {
    const marker = JSON.parse(new TextDecoder().decode(raw)) as { jobId?: unknown };
    return typeof marker.jobId === 'string' ? marker.jobId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The record's cleanup, then the record. `yieldBetween` lets the DO serve
 * others between slices; `sliceEntries` bounds a slice.
 */
export async function cleanUpClone(
  fs: CleanupFs,
  storage: CloneJobStorage,
  record: CloneJobRecord,
  options: { sliceEntries?: number; yieldBetween?: () => Promise<void> } = {},
): Promise<CleanupOutcome> {
  const sliceEntries = options.sliceEntries ?? CLEANUP_SLICE_ENTRIES;
  const yieldBetween = options.yieldBetween ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
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
    let targets = record.phase === 'transport'
      ? [dir]
      : [dir + '/' + STAGE_DIR, ...tmpPacks(fs, dir)];
    for (;;) {
      const done = removeSlice(fs, targets, marker, record.phase === 'transport' ? dir : null, sliceEntries);
      removed += done.removed;
      slices++;
      targets = done.remaining;
      if (targets.length === 0) break;
      await yieldBetween();
    }
    fs.unlink(marker);
    removed++;
  }
  if (record.phase === 'transport') {
    // Empty now, unless something not the clone's is in them (then they stay).
    removed += removeIfEmpty(fs, dir + '/.git');
    if (!record.rootExisted) removed += removeIfEmpty(fs, dir);
  }
  await deleteCloneJob(storage, dir);
  return { outcome: record.phase === 'transport' ? 'removed' : 'kept-repo', removed, slices };
}

/** 1 when the empty directory `path` was removed; 0 when it is gone or not empty. */
function removeIfEmpty(fs: CleanupFs, path: string): number {
  try {
    fs.rmdir(path);
    return 1;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (isAbsent(error) || code === 'ENOTEMPTY') return 0;
    throw error;
  }
}

/** The session's filesystem, as the cleanup of a clone no lease holds takes it. */
export interface SessionCleanupFs {
  as(cred: VfsCred, options?: { mutationOwner?: string }): CleanupFs & {
    acquireExclusiveMutation(path: string, options?: { includeMissingAncestors?: boolean }): { owner: string };
  };
  releaseExclusiveMutation(owner: string): void;
}

/** The records of clones an earlier generation of the session ran (than `current`): none of them is running. */
export async function listInterruptedClones(storage: CloneJobStorage, current: number): Promise<CloneJobRecord[]> {
  return (await listCloneJobs(storage)).filter((record) => !(record.generation >= current));
}

/** A clone's record, and the lease its cleanup holds on its destination. */
export interface ReservedClone {
  record: CloneJobRecord;
  owner: string;
}

/**
 * Each record's destination reserved (its lease taken, as the record's
 * credential), before anything else can write there: the session does this
 * as its filesystem comes up. One that cannot be reserved (another lease
 * overlaps it) is left for the next generation.
 */
export function reserveInterruptedClones(vfs: SessionCleanupFs, records: readonly CloneJobRecord[]): ReservedClone[] {
  const reserved: ReservedClone[] = [];
  for (const record of records) {
    try {
      reserved.push({ record, owner: vfs.as(record.cred).acquireExclusiveMutation(record.dir, { includeMissingAncestors: true }).owner });
    } catch {
      // Left for the next generation.
    }
  }
  return reserved;
}

/**
 * The cleanup of each reserved clone, in slices, its lease released when it
 * is done (or has failed: its record stays for the next generation).
 */
export async function finishReservedClones(
  vfs: SessionCleanupFs,
  storage: CloneJobStorage,
  reserved: readonly ReservedClone[],
  options: { sliceEntries?: number; yieldBetween?: () => Promise<void> } = {},
): Promise<CleanupOutcome[]> {
  const outcomes: CleanupOutcome[] = [];
  let failure: unknown = null;
  for (const { record, owner } of reserved) {
    try {
      outcomes.push(await cleanUpClone(vfs.as(record.cred, { mutationOwner: owner }), storage, record, options));
    } catch (error) {
      failure ??= error;
    } finally {
      vfs.releaseExclusiveMutation(owner);
    }
  }
  if (failure !== null) throw failure;
  return outcomes;
}

/** The clone's temporary packs, by name. */
function tmpPacks(fs: CleanupFs, dir: string): string[] {
  try {
    return fs.readdir(dir + '/' + PACK_DIR).filter(({ name }) => name.startsWith(TMP_PACK_PREFIX)).map(({ name }) => dir + '/' + PACK_DIR + '/' + name);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
}

/**
 * One slice: up to `limit` removals under `targets` (each a file or a
 * directory taken whole), files before the directories that held them,
 * never `marker`; a target that is `keep` is emptied, not removed. What is
 * already gone costs nothing. `remaining` is the targets not yet done: none
 * when nothing but the marker (and the kept target) is left.
 */
function removeSlice(fs: CleanupFs, targets: readonly string[], marker: string, keep: string | null, limit: number): { removed: number; remaining: string[] } {
  let removed = 0;
  // Depth first: a directory goes once it is empty.
  const visit = (path: string, type: string): boolean => {
    if (type === 'missing') return true;
    if (removed >= limit) return false;
    if (type === 'directory') {
      let entries: { name: string; type: string }[];
      try {
        entries = fs.readdir(path);
      } catch (error) {
        if (isAbsent(error)) return true;
        throw error;
      }
      let empty = true;
      for (const entry of entries) {
        const child = path + '/' + entry.name;
        if (child === marker) {
          empty = false;
          continue;
        }
        if (!visit(child, entry.type)) return false;
      }
      if (!empty || path === keep) return true;
      if (removed >= limit) return false;
      try {
        fs.rmdir(path);
        removed++;
      } catch (error) {
        if (!isAbsent(error)) throw error;
      }
      return true;
    }
    try {
      fs.unlink(path);
      removed++;
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
    return true;
  };
  for (const [i, target] of targets.entries()) {
    if (!visit(target, kindOf(fs, target))) return { removed, remaining: targets.slice(i) };
  }
  return { removed, remaining: [] };
}

function kindOf(fs: CleanupFs, path: string): string {
  const slash = path.lastIndexOf('/');
  const parent = slash < 0 ? '' : path.slice(0, slash);
  const name = path.slice(slash + 1);
  try {
    return fs.readdir(parent).find((entry) => entry.name === name)?.type ?? 'missing';
  } catch (error) {
    if (isAbsent(error)) return 'missing';
    throw error;
  }
}
