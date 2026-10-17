/**
 * object-store.ts — the files a KV or R2 binding's objects live in, for both
 * emulators:
 *
 *   <root>/.nimbus/<kind>/<binding>/<key>        — body (raw bytes)
 *   <root>/.nimbus/<kind>/<binding>/<key>.meta   — sidecar JSON
 *
 * A key is stored URL-encoded, so any key is one path segment of its
 * binding's own directory, and so is the binding's name; a name that does
 * not decode is no key's (an upload being written). Each emulator keeps
 * its own sidecar schema and policies: KV's expiry, R2's conditionals,
 * ranges and delimiters. Both list keys in UTF-8 byte order and page with
 * Cloudflare's local cursor, the last key listed in base64.
 */

import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { nameDec } from '@nimbus-sh/core/_shared/bytes.js';

/** The directory a binding's objects live in, under the project `root`. */
export function objectStoreDir(root: string, kind: 'kv' | 'r2', binding: string): string {
  const project = normalizeVfsPath(root);
  return `${project ? `${project}/` : ''}.nimbus/${kind}/${objectFileName(binding)}`;
}

/**
 * The file a key's body is stored in; its sidecar is the same name plus
 * `.meta`. URL-encoding leaves dots as they are, so the dots of `.` and
 * `..` (the directory and its parent) are encoded, and so is the last dot
 * of a key ending `.meta` (another key's sidecar).
 */
export function objectFileName(key: string): string {
  if (key === '.' || key === '..') return key.replaceAll('.', '%2E');
  const name = encodeURIComponent(key);
  return name.endsWith('.meta') ? `${name.slice(0, -5)}%2Emeta` : name;
}

/** A file a body is written to before it replaces its key's: no key's name, as it does not decode. */
export function uploadFileName(): string {
  return `%upload-${crypto.randomUUID()}`;
}

/** Remove a key's body and its sidecar, each where it exists. */
export function removeObjectFiles(vfs: Pick<CredentialedVfs, 'exists' | 'unlink'>, dir: string, fileName: string): void {
  for (const path of [`${dir}/${fileName}`, `${dir}/${fileName}.meta`]) {
    try { if (vfs.exists(path)) vfs.unlink(path); } catch { /* already gone */ }
  }
}

/** -1, 0 or 1 as `a` sorts before, with or after `b` in UTF-8 byte order (SQLite's BINARY collation). */
export function utf8Order(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(left.length - right.length);
}

/** The keys under `dir` that start with `prefix`, each with its file name, in key order. */
export function listObjectFiles(
  vfs: Pick<CredentialedVfs, 'readdir'>,
  dir: string,
  prefix: string,
): Array<{ key: string; fileName: string }> {
  let entries: Array<{ name: string; type: string }>;
  try {
    entries = vfs.readdir(dir);
  } catch {
    return []; // nothing stored yet: no directory, no keys
  }
  const objects: Array<{ key: string; fileName: string }> = [];
  for (const entry of entries) {
    if (entry.type === 'directory' || entry.name.endsWith('.meta')) continue;
    let key: string;
    try { key = decodeURIComponent(entry.name); } catch { continue; }
    if (key.startsWith(prefix)) objects.push({ key, fileName: entry.name });
  }
  return objects.sort((a, b) => utf8Order(a.key, b.key));
}

/** The cursor of a page whose last key is `key`: the key, base64 of its UTF-8. */
export function cursorAfter(key: string): string {
  return btoa(Array.from(new TextEncoder().encode(key), (byte) => String.fromCharCode(byte)).join(''));
}

/** The key a cursor's page ended at, which the next page starts after. */
export function cursorKey(cursor: string): string {
  return nameDec.decode(Uint8Array.from(atob(cursor), (char) => char.charCodeAt(0)));
}
