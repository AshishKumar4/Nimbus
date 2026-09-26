/**
 * What resident node processes read synchronously and did not have, per
 * installed package, shared across sessions.
 *
 * A launch holds its data plan (data-plan.ts) and module map; a file neither
 * names is a first miss: the read fails with EAGAIN naming it, and the facet
 * faults the file in with an async read through the supervisor. Such a path
 * belongs to a package, not to a session (`dist/runtime/x.js` of one tarball
 * is the same file for everyone), so it is recorded under the package's
 * integrity (the hash the lockfile pins the tarball to; for a package no
 * lockfile pins, the content key of its package.json), and a later launch
 * that loads that exact tarball can hold the file from its first instruction.
 *
 * The profile is shared by every tenant, so nothing in it is taken on a
 * program's word:
 *   - Evidence (`verifiedEvidence`) is a reported miss the SUPERVISOR served
 *     an async read for, for that process, that is a regular file inside a
 *     package as the process's own credential stats it. A program that lies
 *     about its misses names paths it was never served, and they are dropped.
 *   - An entry is shared only once two different sessions have observed it,
 *     so one session alone cannot seed what every other tenant stages.
 *   - What a shared profile adds to one launch is bounded in bytes, a share of
 *     the launch's own plan budget, not in paths.
 *   - Entries earn their place, and only the supervisor can raise one: a
 *     launch that staged an entry and was never asked to fault it in raises
 *     its score, once per session, so a score counts the distinct sessions
 *     that vouched for it; the program saying it never read the entry lowers
 *     it (a program's word can only lower); a launch that reported nothing
 *     is no information either way; a plan that found no regular file there
 *     removes it; at zero it is gone.
 *   - It stores package-relative paths only, validated on the way in and on
 *     the way out, never content. At launch an entry becomes a path inside a
 *     package directory of the session's OWN filesystem, planned only where
 *     the credentialed listing shows a regular file and read through the same
 *     credentialed authority as every other planned file. So the worst a
 *     poisoned profile can do is stage more of the session's own files,
 *     within the byte share.
 */
import { packageRootOf } from './data-plan.js';

/** The R2 surface this needs. */
export interface ReadProfileBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  delete?(key: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * Profiles live in the npm tarball cache bucket (NPM_TARBALL_CACHE), per
 * package version like the tarballs, under their own prefix: tarball keys are
 * `v2/t/...` (npm/r2-cache.ts), so the keyspaces never meet.
 */
const PREFIX = 'read-profiles/v2/';
/** How long a listing of which packages have profiles is reused. */
const INDEX_TTL_MS = 60_000;
/** Entries one package's profile stores (a storage bound, not what a launch stages). */
export const READ_PROFILE_MAX_ENTRIES = 1024;
/** Bytes of one profile path. */
export const READ_PROFILE_MAX_PATH_LENGTH = 512;
/** Distinct sessions an entry must be observed by before it is shared. */
export const READ_PROFILE_SHARE_AFTER = 2;
/** Session tags an entry keeps. */
const MAX_SEEN = 4;
/** A score's ceiling: one unread launch per point before an entry is dropped. */
const MAX_SCORE = 8;
/** A tarball integrity (SRI), or the content key of an unpinned package's package.json. */
const IDENTITY = /^(?:sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}|pkgjson:[0-9a-f]{32,128})$/;
const TAG = /^[0-9a-f]{16}$/;

/** A package-relative path a profile may hold, or false. */
export function validProfilePath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > READ_PROFILE_MAX_PATH_LENGTH) return false;
  if (rel.includes('\0') || rel.includes('\\')) return false;
  const segments = rel.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..') && !segments.includes('node_modules');
}

/** A session's tag in a profile: never the session id itself. */
export async function sessionTag(sessionId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId)));
  return Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One miss the supervisor can vouch for: a regular file in a package, and its size. */
export interface ProfileEvidence {
  path: string;
  size: number;
}

/**
 * The misses worth recording: those in `reported` (what the program says it
 * missed) that the supervisor itself `served` an async read for, and that
 * `stat` (as the process's credential) shows as a regular file inside a
 * package. Everything else the program claims is dropped.
 */
export async function verifiedEvidence(
  reported: Iterable<string>,
  served: ReadonlySet<string>,
  stat: (path: string) => Promise<{ type: string; size: number } | null>,
): Promise<ProfileEvidence[]> {
  const out: ProfileEvidence[] = [];
  const seen = new Set<string>();
  for (const raw of reported) {
    if (typeof raw !== 'string') continue;
    const path = raw.replace(/^\/+/, '');
    if (seen.has(path) || !served.has(path)) continue;
    seen.add(path);
    const root = packageRootOf(path);
    if (root === null || !validProfilePath(path.slice(root.length + 1))) continue;
    let st: { type: string; size: number } | null;
    try { st = await stat('/' + path); } catch { continue; }
    if (st === null || st.type !== 'file') continue;
    out.push({ path, size: st.size });
  }
  return out;
}

/**
 * The paths a supervisor served async reads for, per process. Bounded per
 * process: evidence is what a process was served after a miss, and a process
 * that reads more than this many distinct files keeps its first ones.
 */
export class ServedReads {
  static readonly MAX_PER_PROCESS = 4096;
  private readonly byPid = new Map<number, Set<string>>();

  note(pid: number, path: unknown): void {
    if (typeof path !== 'string' || !Number.isInteger(pid) || pid <= 0) return;
    const key = path.replace(/^\/+/, '');
    if (key === '') return;
    let set = this.byPid.get(pid);
    if (!set) this.byPid.set(pid, set = new Set());
    if (set.size < ServedReads.MAX_PER_PROCESS) set.add(key);
  }

  /** What `pid` was served, and forget it. */
  take(pid: number): ReadonlySet<string> {
    const set = this.byPid.get(pid) ?? new Set<string>();
    this.byPid.delete(pid);
    return set;
  }
}

/**
 * `seen`: the sessions that observed the entry. `vouched`: the sessions whose
 * launch staged it and was never served a read of it, each counted once, so a
 * score never exceeds the number of distinct sessions that vouched for it.
 */
interface Entry { size: number; seen: string[]; vouched: string[]; score: number }
type Entries = Map<string, Entry>;

/** One profile entry `lookup` offered a launch. */
export interface StagedProfileEntry {
  /** The namespace key (`<package root>/<rel>`). */
  path: string;
  size: number;
  /** Where the entry lives: its profile object and package-relative path. */
  object: string;
  rel: string;
}

export class ReadProfile {
  private index: { at: number; keys: Set<string> } | null = null;

  constructor(private readonly bucket: ReadProfileBucket, private readonly now: () => number = Date.now) {}

  private static key(integrity: string): string | null {
    return IDENTITY.test(integrity) ? PREFIX + encodeURIComponent(integrity) : null;
  }

  /** Group paths under their package's profile key. */
  private static byPackage<T extends { path: string }>(items: Iterable<T>, integrityOf: (root: string) => string | null) {
    const out = new Map<string, { item: T; rel: string }[]>();
    for (const item of items) {
      const path = item.path.replace(/^\/+/, '');
      const root = packageRootOf(path);
      if (root === null) continue;
      const rel = path.slice(root.length + 1);
      if (!validProfilePath(rel)) continue;
      const integrity = integrityOf(root);
      const key = integrity === null ? null : ReadProfile.key(integrity);
      if (key === null) continue;
      let list = out.get(key);
      if (!list) out.set(key, list = []);
      list.push({ item, rel });
    }
    return out;
  }

  /**
   * File what one session observed (`verifiedEvidence`). Each entry keeps the
   * distinct sessions that observed it; it is shared once there are two.
   */
  async observe(evidence: Iterable<ProfileEvidence>, tag: string, integrityOf: (root: string) => string | null): Promise<number> {
    if (!TAG.test(tag)) return 0;
    let changed = 0;
    for (const [key, items] of ReadProfile.byPackage(evidence, integrityOf)) {
      const entries = await this.read(key);
      let dirty = false;
      for (const { item, rel } of items) {
        const size = Math.max(0, Math.floor(item.size));
        let entry = entries.get(rel);
        if (!entry) {
          if (!ReadProfile.makeRoom(entries)) continue;
          entry = { size, seen: [], vouched: [], score: 0 };
          entries.set(rel, entry);
        }
        entry.size = size;
        if (!entry.seen.includes(tag)) {
          entry.seen = [...entry.seen, tag].slice(-MAX_SEEN);
          dirty = true;
          changed++;
        }
        if (entry.score < 1) { entry.score = 1; dirty = true; }
      }
      if (dirty) {
        await this.write(key, entries);
        this.index?.keys.add(key);
      }
    }
    return changed;
  }

  /**
   * A full profile evicts its weakest unshared entry for a new one; shared
   * entries are never evicted for an observation only one session made.
   */
  private static makeRoom(entries: Entries): boolean {
    if (entries.size < READ_PROFILE_MAX_ENTRIES) return true;
    let weakest: string | null = null;
    for (const [rel, entry] of entries) {
      if (entry.seen.length >= READ_PROFILE_SHARE_AFTER) continue;
      if (weakest === null || entry.score < entries.get(weakest)!.score) weakest = rel;
    }
    if (weakest === null) return false;
    entries.delete(weakest);
    return true;
  }

  /**
   * The shared entries for the packages at `roots` (namespace keys), best
   * first (score, then smaller files), whose sizes add up to at most
   * `budgetBytes`.
   */
  async lookup(roots: Iterable<string>, integrityOf: (root: string) => string | null, budgetBytes: number): Promise<StagedProfileEntry[]> {
    const index = await this.listIndex();
    if (index.size === 0) return [];
    const candidates: { path: string; size: number; score: number; key: string; rel: string }[] = [];
    for (const root of new Set(roots)) {
      const integrity = integrityOf(root);
      const key = integrity === null ? null : ReadProfile.key(integrity);
      if (key === null || !index.has(key)) continue;
      for (const [rel, entry] of await this.read(key)) {
        if (entry.seen.length < READ_PROFILE_SHARE_AFTER || entry.score < 1) continue;
        candidates.push({ path: `${root}/${rel}`, size: entry.size, score: entry.score, key, rel });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.size - b.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const out: StagedProfileEntry[] = [];
    let used = 0;
    for (const c of candidates) {
      if (used + c.size > budgetBytes) continue;
      used += c.size;
      out.push({ path: c.path, size: c.size, object: c.key, rel: c.rel });
    }
    return out;
  }

  /**
   * What one launch did with the entries `lookup` gave it. `unread` is what
   * the process reported it never read (its word can only lower a score), or
   * null when it reported no list at all (a launch that died before its
   * report), which says nothing about any entry; `served` is what the
   * supervisor served it async reads for during the launch (a staged file the
   * process used is never faulted in, so an entry staged and not in `served`
   * is the supervisor's evidence it was held); `unresolved` is what the plan
   * found no regular file for; `tag` is the launching session's.
   *   unresolved                            -> removed
   *   no report                             -> unchanged
   *   reported unread                       -> score - 1
   *   staged, never served, tag not vouched -> score + 1 (at most MAX_SCORE)
   *   otherwise                             -> unchanged
   * A score of zero removes the entry.
   */
  async settle(
    staged: Iterable<StagedProfileEntry>,
    unread: ReadonlySet<string> | null,
    served: ReadonlySet<string>,
    unresolved: ReadonlySet<string>,
    tag: string,
  ): Promise<void> {
    const key = (p: string) => p.replace(/^\/+/, '');
    const unreadKeys = unread === null ? null : new Set([...unread].map(key));
    const canVouch = TAG.test(tag);
    const unresolvedKeys = new Set([...unresolved].map(key));
    const byKey = new Map<string, { rel: string; path: string }[]>();
    for (const entry of staged) {
      // Only an object this module names, for a path it validates.
      if (!entry.object.startsWith(PREFIX) || !validProfilePath(entry.rel)) continue;
      let list = byKey.get(entry.object);
      if (!list) byKey.set(entry.object, list = []);
      list.push({ rel: entry.rel, path: key(entry.path) });
    }
    for (const [objectKey, items] of byKey) {
      const entries = await this.read(objectKey);
      let dirty = false;
      for (const { rel, path } of items) {
        const entry = entries.get(rel);
        if (!entry) continue;
        if (unresolvedKeys.has(path)) { entries.delete(rel); dirty = true; continue; }
        if (unreadKeys === null) continue;
        if (unreadKeys.has(path)) entry.score -= 1;
        else if (!served.has(path) && canVouch && !entry.vouched.includes(tag)) {
          entry.vouched = [...entry.vouched, tag].slice(-MAX_SCORE);
          entry.score = Math.min(MAX_SCORE, entry.score + 1);
        } else continue;
        dirty = true;
        if (entry.score <= 0) entries.delete(rel);
      }
      if (dirty) await this.write(objectKey, entries);
    }
  }

  private async write(key: string, entries: Entries): Promise<void> {
    const body: Record<string, Entry> = {};
    for (const rel of [...entries.keys()].sort()) body[rel] = entries.get(rel)!;
    await this.bucket.put(key, JSON.stringify({ entries: body }));
  }

  private async read(key: string): Promise<Entries> {
    const entries: Entries = new Map();
    const object = await this.bucket.get(key);
    if (!object) return entries;
    try {
      const parsed = JSON.parse(await object.text()) as { entries?: unknown };
      if (typeof parsed.entries !== 'object' || parsed.entries === null) return entries;
      for (const [rel, raw] of Object.entries(parsed.entries as Record<string, unknown>)) {
        if (entries.size >= READ_PROFILE_MAX_ENTRIES) break;
        if (!validProfilePath(rel) || typeof raw !== 'object' || raw === null) continue;
        const { size, seen, vouched, score } = raw as Partial<Entry>;
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) continue;
        if (typeof score !== 'number' || !Number.isInteger(score) || score < 1) continue;
        const tagsOf = (list: unknown, max: number): string[] =>
          Array.isArray(list) ? [...new Set(list.filter((t): t is string => typeof t === 'string' && TAG.test(t)))].slice(-max) : [];
        const vouchers = tagsOf(vouched, MAX_SCORE);
        // A score is observation (1) plus distinct vouching sessions; a stored
        // score past that is not one this module wrote.
        entries.set(rel, { size: Math.floor(size), seen: tagsOf(seen, MAX_SEEN), vouched: vouchers, score: Math.min(score, 1 + vouchers.length, MAX_SCORE) });
      }
    } catch {
      // A malformed object is an empty profile.
    }
    return entries;
  }

  private async listIndex(): Promise<Set<string>> {
    if (this.index && this.now() - this.index.at < INDEX_TTL_MS) return this.index.keys;
    const keys = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) keys.add(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.index = { at: this.now(), keys };
    return keys;
  }
}
