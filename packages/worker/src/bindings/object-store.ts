/**
 * object-store.ts — the files a KV or R2 binding's objects live in, for both
 * emulators:
 *
 *   <root>/.nimbus/<kind>/<binding>/<key>        — body (raw bytes)
 *   <root>/.nimbus/<kind>/<binding>/<key>.meta   — sidecar JSON
 *
 * A key is stored URL-encoded, so any key is one path segment. Each emulator
 * keeps its own sidecar schema and policies: KV's expiry, R2's conditionals,
 * ranges and delimiters.
 */

import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { decodeJsonBase64Url, encodeJsonBase64Url } from '@nimbus-sh/core/_shared/crypto.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';

/** The directory a binding's objects live in, under the project `root`. */
export function objectStoreDir(root: string, kind: 'kv' | 'r2', binding: string): string {
  const project = normalizeVfsPath(root);
  return `${project ? `${project}/` : ''}.nimbus/${kind}/${binding}`;
}

/** The file a key's body is stored in; its sidecar is the same name plus `.meta`. */
export function objectFileName(key: string): string {
  return encodeURIComponent(key);
}

/** Remove a key's body and its sidecar, each where it exists. */
export function removeObjectFiles(vfs: Pick<CredentialedVfs, 'exists' | 'unlink'>, dir: string, fileName: string): void {
  for (const path of [`${dir}/${fileName}`, `${dir}/${fileName}.meta`]) {
    try { if (vfs.exists(path)) vfs.unlink(path); } catch { /* already gone */ }
  }
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
    try { key = decodeURIComponent(entry.name); } catch { key = entry.name; }
    if (key.startsWith(prefix)) objects.push({ key, fileName: entry.name });
  }
  return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * One page of `entries`, from the offset `cursor` names (the first page
 * without one), and the cursor of the page after it while entries remain.
 * A cursor that does not decode starts from the first entry.
 */
export function cursorPage<T>(entries: T[], cursor: string | undefined, limit: number): { page: T[]; next?: string } {
  let start = 0;
  if (cursor) {
    try { start = Number(decodeJsonBase64Url<{ off?: unknown }>(cursor).off) || 0; } catch { start = 0; }
  }
  const page = entries.slice(start, start + limit);
  const end = start + page.length;
  return end < entries.length ? { page, next: encodeJsonBase64Url({ off: end }) } : { page };
}
