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
import { decodeJsonBase64Url, encodeJsonBase64Url } from '@nimbus-sh/core/_shared/crypto.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
/** The directory a binding's objects live in, under the project `root`. */
export function objectStoreDir(root, kind, binding) {
    const project = normalizeVfsPath(root);
    return `${project ? `${project}/` : ''}.nimbus/${kind}/${binding}`;
}
/** The file a key's body is stored in; its sidecar is the same name plus `.meta`. */
export function objectFileName(key) {
    return encodeURIComponent(key);
}
/** Remove a key's body and its sidecar, each where it exists. */
export function removeObjectFiles(vfs, dir, fileName) {
    for (const path of [`${dir}/${fileName}`, `${dir}/${fileName}.meta`]) {
        try {
            if (vfs.exists(path))
                vfs.unlink(path);
        }
        catch { /* already gone */ }
    }
}
/** The keys under `dir` that start with `prefix`, each with its file name, in key order. */
export function listObjectFiles(vfs, dir, prefix) {
    let entries;
    try {
        entries = vfs.readdir(dir);
    }
    catch {
        return []; // nothing stored yet: no directory, no keys
    }
    const objects = [];
    for (const entry of entries) {
        if (entry.type === 'directory' || entry.name.endsWith('.meta'))
            continue;
        let key;
        try {
            key = decodeURIComponent(entry.name);
        }
        catch {
            key = entry.name;
        }
        if (key.startsWith(prefix))
            objects.push({ key, fileName: entry.name });
    }
    return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/**
 * One page of `entries`, from the offset `cursor` names (the first page
 * without one), and the cursor of the page after it while entries remain.
 * A cursor that does not decode starts from the first entry.
 */
export function cursorPage(entries, cursor, limit) {
    let start = 0;
    if (cursor) {
        try {
            start = Number(decodeJsonBase64Url(cursor).off) || 0;
        }
        catch {
            start = 0;
        }
    }
    const page = entries.slice(start, start + limit);
    const end = start + page.length;
    return end < entries.length ? { page, next: encodeJsonBase64Url({ off: end }) } : { page };
}
