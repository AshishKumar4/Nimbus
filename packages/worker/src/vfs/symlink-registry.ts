/**
 * symlink-registry.ts — virtual symlink table backed by a special
 * JSON file in the SqliteVFS.
 *
 * SHELL-FOLLOWUPS-4 (2026-05-11): Real symlink support for `ln -s`
 * + `readlink`. Pre-fix `ln -s` copied the file content into a new
 * regular file; `readlink` returned empty.
 *
 * Why a registry (not VFS-schema change):
 *   - SqliteVFS schema is anti-touch for surrounding waves.
 *   - Symlinks have minimal storage requirement (path → target string).
 *   - Persistence across reconnect/eviction is automatic because the
 *     registry file lives in the same SqliteVFS that gets snapshotted.
 *
 * Storage: `/.nimbus-symlinks.json` with shape `{ [linkPath]: target }`.
 * The registry is in-memory cached on first read; writes flush back
 * to the file synchronously.
 *
 * Resolution: callers (`ls -la`, `cat`, `readlink`, `rm`) check the
 * registry FIRST before treating a path as a regular file. This
 * means symlinks transparently dereference for read but appear in
 * `ls -la` with proper `lrwxrwxrwx` mode and `-> target` suffix.
 *
 * Loop guard: `resolveSymlinkChain` follows at most 40 hops (matches
 * POSIX SYMLOOP_MAX).
 */

import type { SqliteVFS } from './sqlite-vfs.js';

const REGISTRY_PATH = '.nimbus-symlinks.json';

export class SymlinkRegistry {
  private vfs: SqliteVFS;
  private cache: Map<string, string> | null = null;

  constructor(vfs: SqliteVFS) {
    this.vfs = vfs;
  }

  /** Lazy-load + memoize the registry. */
  private load(): Map<string, string> {
    if (this.cache) return this.cache;
    try {
      if (this.vfs.exists(REGISTRY_PATH)) {
        const raw = this.vfs.readFileString(REGISTRY_PATH);
        const obj = JSON.parse(raw);
        this.cache = new Map(Object.entries(obj));
      } else {
        this.cache = new Map();
      }
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  /** Write the cache back to the registry file. */
  private flush(): void {
    if (!this.cache) return;
    const obj: Record<string, string> = {};
    for (const [k, v] of this.cache) obj[k] = v;
    try {
      this.vfs.writeFile(REGISTRY_PATH, JSON.stringify(obj));
    } catch { /* fail-soft */ }
  }

  /** Normalize a path: strip leading slashes (VFS internal convention). */
  private norm(p: string): string {
    return p.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  /** Create or replace a symlink. Target is stored verbatim (can be
   *  absolute or relative — interpretation happens at resolve time). */
  set(linkPath: string, target: string): void {
    const cache = this.load();
    cache.set(this.norm(linkPath), target);
    this.flush();
  }

  /** Remove a symlink. Returns true if it existed. */
  delete(linkPath: string): boolean {
    const cache = this.load();
    const ok = cache.delete(this.norm(linkPath));
    if (ok) this.flush();
    return ok;
  }

  /** Check if `path` is registered as a symlink (no chain resolution). */
  isSymlink(path: string): boolean {
    return this.load().has(this.norm(path));
  }

  /** Get the immediate target of a symlink. Returns null if not a symlink. */
  readlink(path: string): string | null {
    const v = this.load().get(this.norm(path));
    return v === undefined ? null : v;
  }

  /**
   * Follow a symlink chain until we hit a non-symlink (or run out of
   * hops). Returns the resolved path (canonicalized to no-leading-slash).
   * If the chain breaks (max-hops or missing target), returns the
   * last-resolved path or null.
   *
   * `cwd` is used to resolve RELATIVE symlink targets (target without
   * leading `/`). POSIX semantics: relative targets resolve from the
   * symlink's directory, not the current cwd.
   */
  resolveChain(startPath: string): string | null {
    let cur = this.norm(startPath);
    for (let hops = 0; hops < 40; hops++) {
      const target = this.load().get(cur);
      if (target === undefined) return cur;  // not a symlink — done
      if (target.startsWith('/')) {
        cur = this.norm(target);
      } else {
        // Relative target: resolve from symlink's parent dir.
        const parent = cur.includes('/') ? cur.substring(0, cur.lastIndexOf('/')) : '';
        const parts = (parent + '/' + target).split('/');
        const out: string[] = [];
        for (const s of parts) {
          if (s === '..') out.pop();
          else if (s !== '.' && s !== '') out.push(s);
        }
        cur = out.join('/');
      }
    }
    // ELOOP
    return null;
  }

  /** List all currently-registered symlinks (debugging / ls -la support). */
  list(): { link: string; target: string }[] {
    const out: { link: string; target: string }[] = [];
    for (const [k, v] of this.load()) {
      out.push({ link: k, target: v });
    }
    return out;
  }
}
