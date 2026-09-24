/**
 * What resident node processes read synchronously and did not have, per
 * installed package, shared across sessions.
 *
 * A launch holds its data plan (data-plan.ts); a file no rule or static
 * reference names is a first miss: the read fails with EAGAIN naming it and
 * the exit report files it. Such a path belongs to a package, not to a
 * session — `dist/runtime/x.js` of one tarball is the same file for everyone —
 * so the miss is recorded under the package's integrity hash (the sha512 the
 * lockfile pins the tarball to), and every later launch that loads that exact
 * tarball holds the file from its first instruction. A package no lockfile
 * pins (a link, a git or file dependency) is identified by the content key of
 * its package.json instead.
 *
 * What a profile can do, and why a hostile one cannot do more:
 *   - It stores package-relative paths only, validated on the way in and on
 *     the way out (no absolute path, no `.`/`..`/empty segment, bounded
 *     length), never content, never anything about the session.
 *   - At launch an entry becomes `<package dir>/<path>`, a path inside a
 *     package directory of the session's OWN filesystem. data-plan.ts takes it
 *     only if the credentialed listing shows a regular file there, and the
 *     facet reads it through the same credentialed authority reads as every
 *     other planned file. So an entry can only widen WHICH of the session's
 *     own files are staged: the worst a poisoned profile costs is extra reads.
 *     It cannot supply bytes, name a file outside the package, or bypass an
 *     access check.
 *   - A profile holds at most READ_PROFILE_MAX_PATHS paths.
 */
import { packageRootOf } from './data-plan.js';

/** The R2 surface this needs. */
export interface ReadProfileBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

const PREFIX = 'read-profile/v1/';
/** How long a listing of which packages have profiles is reused. */
const INDEX_TTL_MS = 60_000;
/** Paths one package's profile holds. */
export const READ_PROFILE_MAX_PATHS = 512;
/** Bytes of one profile path. */
export const READ_PROFILE_MAX_PATH_LENGTH = 512;
/** A tarball integrity (SRI), or the content key of an unpinned package's package.json. */
const IDENTITY = /^(?:sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}|pkgjson:[0-9a-f]{32,128})$/;

/** A package-relative path a profile may hold, or false. */
export function validProfilePath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > READ_PROFILE_MAX_PATH_LENGTH) return false;
  if (rel.includes('\0') || rel.includes('\\')) return false;
  const segments = rel.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..') && !segments.includes('node_modules');
}

export class ReadProfile {
  private index: { at: number; keys: Set<string> } | null = null;

  constructor(private readonly bucket: ReadProfileBucket, private readonly now: () => number = Date.now) {}

  private static key(integrity: string): string | null {
    return IDENTITY.test(integrity) ? PREFIX + encodeURIComponent(integrity) : null;
  }

  /**
   * File `paths` (namespace keys) that a process missed, each under the
   * package it sits in. `integrityOf(root)` is the lockfile's integrity for a
   * package directory, or null; a path outside any package, or in a package
   * with none, is not shared.
   */
  async record(paths: Iterable<string>, integrityOf: (root: string) => string | null): Promise<number> {
    const byPackage = new Map<string, Set<string>>();
    for (const raw of paths) {
      const path = raw.replace(/^\/+/, '');
      const root = packageRootOf(path);
      if (root === null) continue;
      const rel = path.slice(root.length + 1);
      if (!validProfilePath(rel)) continue;
      const integrity = integrityOf(root);
      const key = integrity === null ? null : ReadProfile.key(integrity);
      if (key === null) continue;
      let rels = byPackage.get(key);
      if (!rels) byPackage.set(key, rels = new Set());
      rels.add(rel);
    }
    let added = 0;
    for (const [key, rels] of byPackage) {
      const held = await this.read(key);
      const before = held.size;
      for (const rel of rels) {
        if (held.size >= READ_PROFILE_MAX_PATHS) break;
        held.add(rel);
      }
      if (held.size === before) continue;
      added += held.size - before;
      await this.bucket.put(key, JSON.stringify({ paths: [...held].sort() }));
      this.index?.keys.add(key);
    }
    return added;
  }

  /** The recorded paths (namespace keys) for the packages at `roots`. */
  async lookup(roots: Iterable<string>, integrityOf: (root: string) => string | null): Promise<string[]> {
    const index = await this.listIndex();
    if (index.size === 0) return [];
    const out: string[] = [];
    for (const root of roots) {
      const integrity = integrityOf(root);
      const key = integrity === null ? null : ReadProfile.key(integrity);
      if (key === null || !index.has(key)) continue;
      for (const rel of await this.read(key)) out.push(root + '/' + rel);
    }
    return out;
  }

  private async read(key: string): Promise<Set<string>> {
    const object = await this.bucket.get(key);
    if (!object) return new Set();
    try {
      const parsed = JSON.parse(await object.text()) as { paths?: unknown };
      const paths = Array.isArray(parsed.paths) ? parsed.paths.filter(validProfilePath) : [];
      return new Set(paths.slice(0, READ_PROFILE_MAX_PATHS));
    } catch {
      return new Set();
    }
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
