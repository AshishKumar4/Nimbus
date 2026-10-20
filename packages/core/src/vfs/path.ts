/**
 * vfs/path.ts — Canonical VFS path normalization: a path as the store's key,
 * its names reduced by the one root-clamped lexical reduction
 * (rootClampedSegments) with no leading or trailing slash.
 *
 * Examples:
 *   normalizeVfsPath('/foo/./bar/../baz') -> 'foo/baz'
 *   normalizeVfsPath('/foo//bar/')         -> 'foo/bar'
 *   normalizeVfsPath('../escape')          -> 'escape'  (bounded; doesn't go negative)
 */
import { rootClampedSegments } from '@nimbus-sh/platform/lexical-path.js';

/**
 * A spelling normalizeVfsPath would change beyond one leading slash: a
 * trailing slash, an empty segment, or a `.`/`..` segment.
 */
const NOT_NORMAL = /\/$|\/\/|(?:^|\/)\.\.?(?:\/|$)/;

/** A plain lookup key, or null when components must be walked before normalization. */
export function plainVfsPath(path: string): string | null {
  return NOT_NORMAL.test(path) ? null : path.charCodeAt(0) === 47 ? path.slice(1) : path;
}

export function normalizeVfsPath(p: string): string {
  const text = String(p ?? '');
  // A key already in canonical form, or an absolute path that is one past
  // its leading slash, as most lookups pass, is returned without the split.
  const plain = plainVfsPath(text);
  if (plain !== null) return plain;
  return rootClampedSegments(text).join('/');
}

/** Dot-only spellings may use indexed lookup; parents and trailing directory checks must be walked. */
let recentLookup: { path: string; key: string | null } | null = null;
let priorLookup: { path: string; key: string | null } | null = null;
export function normalizeVfsLookupPath(path: string): string | null {
  const plain = plainVfsPath(path);
  if (plain !== null) return plain;
  if (recentLookup?.path === path) return recentLookup.key;
  if (priorLookup?.path === path) {
    const matched = priorLookup;
    priorLookup = recentLookup;
    recentLookup = matched;
    return matched.key;
  }
  const key = lookupKey(path);
  priorLookup = recentLookup;
  recentLookup = { path, key };
  return key;
}

/** A path's indexed-lookup key: null when a parent or a directory-sensitive ending must be walked instead. */
function lookupKey(path: string): string | null {
  const segments = path.split('/');
  const leaf = segments[segments.length - 1];
  if (leaf === '' || leaf === '.') return null;
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '..') return null;
    if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/** Resolve a user path against a VFS cwd and return a canonical VFS key. */
export function resolveVfsPath(path: string, cwd: string): string {
  return path.startsWith('/')
    ? normalizeVfsPath(path)
    : normalizeVfsPath(`${cwd}/${path}`);
}

/** Whether one engine key is the other or under it: '' (the root) overlaps every key. */
export function pathsOverlap(left: string, right: string): boolean {
  return left === ''
    || right === ''
    || left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

/** The directory a storage key (already normalized) is under: '' at the root. */
export function parentKey(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

/** The directory a path is in, by its last '/': '/' for a path directly under the root (or none). */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

export function parentVfsPath(path: string): string {
  const clean = normalizeVfsPath(path);
  const idx = clean.lastIndexOf('/');
  return idx > 0 ? clean.slice(0, idx) : '';
}

/** Strip leading slashes only — does not touch internal segments. */
export function stripLeadingSlashes(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * The basename's extension including its leading dot, or an empty string when
 * there is none. A dot that opens the basename belongs to the name (`.bashrc`)
 * rather than to an extension, matching Node's `path.extname`.
 *
 * `endsWith` and `split('.').pop()` are not substitutes for callers deciding
 * how to PARSE a file: neither can say "this path has no extension", and the
 * latter answers `js/bin/tsc` for `home/user.js/bin/tsc`. Extensionless files
 * are the shape of nearly every npm `bin` script, so that answer is
 * load-bearing rather than an edge case.
 */
export function vfsPathExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/**
 * Whether `path` is a sibling of directory `key` whose name extends `key`'s
 * with a character below '/' (`key-x`, `key.x`): it sorts between `key` and
 * `key/`, so a walk of `key` from the cursor `key/` (which names `key`) meets
 * it first, and its own subtree, before `key`'s entries.
 */
export function beforeSubtree(path: string, key: string): boolean {
  return key !== '' && path.length > key.length && path.startsWith(key) && path.charCodeAt(key.length) < 0x2f;
}
