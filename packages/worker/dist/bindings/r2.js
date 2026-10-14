/**
 * r2.ts — the R2 bucket a Worker is given under `nimbus wrangler dev`
 * (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
 * as `wrangler dev` gives it: Cloudflare's local store (Miniflare's R2
 * bucket), its conditionals, ranges, checksums, listing and errors.
 *
 * The session serves it (session/rpc.ts _rpcR2Call) for the Worker's binding
 * (fabric bindings.ts NimbusR2Bucket), which answers each object as its
 * fields; the Worker's env.BUCKET (fabric inner-storage-env.ts) makes the
 * platform's R2Object and R2ObjectBody of them. Backed by SqliteVFS files:
 *
 *   <root>/.nimbus/r2/<binding>/<key>          — body (raw bytes)
 *   <root>/.nimbus/r2/<binding>/<key>.meta     — sidecar JSON:
 *      { etag: string,                       // md5 hex of body
 *        version?: string,                   // random, per put
 *        size: number,
 *        uploaded: number,                   // unix ms
 *        checksums?: { md5?, sha1?, … },     // hex
 *        httpMetadata?: R2HTTPMetadata,
 *        customMetadata?: Record<string,string>,
 *        v: 1 }
 *
 * A sidecar from an older release has a sha256 etag and neither version nor
 * checksums: its etag stands for its version, and it has no checksums.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { bodyStream, coerceBindingBody, ensureBindingDir } from './body.js';
import { cursorAfter, cursorKey, listObjectFiles, objectFileName, objectStoreDir, removeObjectFiles, utf8Order } from './object-store.js';
const HttpMetadataSchema = z.object({
    contentType: z.string().optional(),
    contentLanguage: z.string().optional(),
    contentDisposition: z.string().optional(),
    contentEncoding: z.string().optional(),
    cacheControl: z.string().optional(),
    cacheExpiry: z.coerce.date().optional(),
});
/** An object's sidecar, as the store wrote it. */
const R2SidecarSchema = z.object({
    etag: z.string(),
    version: z.string().optional(),
    size: z.number(),
    uploaded: z.number(),
    checksums: z.partialRecord(z.enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512']), z.string()).optional(),
    httpMetadata: HttpMetadataSchema.optional(),
    customMetadata: z.record(z.string(), z.string()).optional(),
    v: z.literal(1),
});
const MAX_KEY_BYTES = 1024;
const MAX_LIST_KEYS = 1000;
/** The most objects a listing answers that includes metadata. */
const MAX_LIST_KEYS_WITH_METADATA = 100;
/** Each digest an object can carry, as R2 names it in a checksum error. */
const HASHES = [
    { name: 'md5', label: 'MD5' },
    { name: 'sha1', label: 'SHA-1' },
    { name: 'sha256', label: 'SHA-256' },
    { name: 'sha384', label: 'SHA-384' },
    { name: 'sha512', label: 'SHA-512' },
];
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
/** An error of R2's, as workerd's R2 client throws it: the action, the message, R2's code. */
function r2Error(action, message, code) {
    return new Error(`${action}: ${message} (${code})`);
}
function validateKey(action, key) {
    if (new TextEncoder().encode(key).byteLength > MAX_KEY_BYTES)
        throw r2Error(action, 'The specified object name is not valid.', 10020);
}
function includesEtag(conditions, etag, comparison) {
    return conditions.some((c) => c.type === 'wildcard' || (c.value === etag && (c.type === 'strong' || comparison === 'weak')));
}
/** Whether `onlyIf` holds for the object `side` (none when absent), as R2 tests it. */
function conditionHolds(onlyIf, side) {
    if (side === null)
        return onlyIf.etagMatches === undefined && onlyIf.uploadedAfter === undefined;
    const truncate = (ms) => (onlyIf.secondsGranularity ? Math.floor(ms / 1000) * 1000 : ms);
    const ifMatch = onlyIf.etagMatches === undefined || includesEtag(onlyIf.etagMatches, side.etag, 'strong');
    const ifNoneMatch = onlyIf.etagDoesNotMatch === undefined || !includesEtag(onlyIf.etagDoesNotMatch, side.etag, 'weak');
    const uploaded = truncate(side.uploaded);
    const ifModifiedSince = onlyIf.uploadedAfter === undefined || truncate(onlyIf.uploadedAfter.getTime()) < uploaded
        || (onlyIf.etagDoesNotMatch !== undefined && ifNoneMatch);
    const ifUnmodifiedSince = onlyIf.uploadedBefore === undefined || uploaded < truncate(onlyIf.uploadedBefore.getTime())
        || (onlyIf.etagMatches !== undefined && ifMatch);
    return ifMatch && ifNoneMatch && ifModifiedSince && ifUnmodifiedSince;
}
/** A Range header's one range in an object of `size` bytes; none for any other header. */
function headerRange(header, size) {
    const prefix = /^ *bytes *=/i.exec(header);
    if (prefix === null)
        return undefined;
    const ranges = [];
    for (const part of header.slice(prefix[0].length).split(',')) {
        const match = /^ *(\d+)? *- *(\d+)? *$/.exec(part);
        if (match === null)
            return undefined;
        const [, start, end] = match;
        if (start !== undefined && end !== undefined) {
            const from = parseInt(start, 10);
            const to = parseInt(end, 10);
            if (from > to || from >= size)
                return undefined;
            ranges.push({ start: from, end: Math.min(to, size - 1) });
        }
        else if (start !== undefined) {
            const from = parseInt(start, 10);
            if (from >= size)
                return undefined;
            ranges.push({ start: from, end: size - 1 });
        }
        else if (end !== undefined) {
            const suffix = parseInt(end, 10);
            if (suffix >= size)
                return undefined;
            if (suffix !== 0)
                ranges.push({ start: size - suffix, end: size - 1 });
        }
        else {
            return undefined;
        }
    }
    return ranges.length === 1 ? ranges[0] : undefined;
}
/** The bytes a get asks for, or none for the whole object; a range the object cannot satisfy is refused. */
function requestedRange(options, size) {
    if (options.rangeHeader !== undefined)
        return headerRange(options.rangeHeader, size);
    if (options.range === undefined)
        return undefined;
    let { offset, length } = options.range;
    const { suffix } = options.range;
    if (suffix !== undefined) {
        if (suffix <= 0)
            throw r2Error('get', 'The requested range is not satisfiable', 10039);
        offset = size - Math.min(suffix, size);
        length = Math.min(suffix, size);
    }
    offset ??= 0;
    length ??= size - offset;
    if (offset < 0 || offset > size || length <= 0)
        throw r2Error('get', 'The requested range is not satisfiable', 10039);
    return { start: offset, end: offset + Math.min(length, size - offset) - 1 };
}
export class R2Emulator {
    vfs;
    dir;
    constructor(opts) {
        this.vfs = opts.vfs;
        this.dir = objectStoreDir(opts.root, 'r2', opts.binding);
    }
    // ── public API ────────────────────────────────────────────────────────
    async head(key) {
        validateKey('head', key);
        const side = this.#readSide(objectFileName(key));
        return side === null ? null : this.#object(key, side, { offset: 0, length: side.size });
    }
    async get(key, options) {
        validateKey('get', key);
        const fileName = objectFileName(key);
        const side = this.#readSide(fileName);
        if (side === null)
            return null;
        if (options.onlyIf !== undefined && !conditionHolds(options.onlyIf, side)) {
            return { object: this.#object(key, side, { offset: 0, length: side.size }), body: null };
        }
        const range = requestedRange(options, side.size);
        const body = this.vfs.readFile(this.dir + '/' + fileName);
        if (range === undefined)
            return { object: this.#object(key, side, { offset: 0, length: side.size }), body: bodyStream(body) };
        return {
            object: this.#object(key, side, { offset: range.start, length: range.end - range.start + 1 }),
            body: bodyStream(body.slice(range.start, range.end + 1)),
        };
    }
    async put(key, value, options) {
        const body = await coerceBindingBody(value);
        const checksums = { md5: hex(createHash('md5').update(body).digest()) };
        for (const { name, label } of HASHES) {
            const provided = options.checksums?.[name];
            if (provided === undefined)
                continue;
            const computed = hex(createHash(name).update(body).digest());
            if (provided !== computed) {
                throw r2Error('put', [
                    `The ${label} checksum you specified did not match what we received.`,
                    `You provided a ${label} checksum with value: ${provided}`,
                    `Actual ${label} was: ${computed}`,
                ].join('\n'), 10037);
            }
            checksums[name] = computed;
        }
        validateKey('put', key);
        const fileName = objectFileName(key);
        if (options.onlyIf !== undefined && !conditionHolds(options.onlyIf, this.#readSide(fileName)))
            return null;
        const side = {
            etag: checksums.md5 ?? '',
            version: hex(crypto.getRandomValues(new Uint8Array(16))),
            size: body.byteLength,
            uploaded: Date.now(),
            checksums,
            httpMetadata: options.httpMetadata ?? {},
            customMetadata: options.customMetadata ?? {},
            v: 1,
        };
        ensureBindingDir(this.vfs, this.dir);
        this.vfs.writeFile(this.dir + '/' + fileName, body);
        this.vfs.writeFile(this.dir + '/' + fileName + '.meta', JSON.stringify(side));
        return this.#object(key, side, undefined);
    }
    async delete(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list)
            validateKey('delete', key);
        for (const key of list)
            removeObjectFiles(this.vfs, this.dir, objectFileName(key));
    }
    async list(options) {
        let limit = options.limit ?? MAX_LIST_KEYS;
        if (limit < 1 || limit > MAX_LIST_KEYS)
            throw r2Error('list', `MaxKeys params must be positive integer <= ${MAX_LIST_KEYS}.`, 10022);
        const include = options.include ?? [];
        if (include.length > 0)
            limit = Math.min(limit, MAX_LIST_KEYS_WITH_METADATA);
        const prefix = options.prefix ?? '';
        let startAfter = options.startAfter;
        if (options.cursor !== undefined) {
            const after = cursorKey(options.cursor);
            if (startAfter === undefined || utf8Order(after, startAfter) > 0)
                startAfter = after;
        }
        const delimiter = options.delimiter === '' ? undefined : options.delimiter;
        // Each row: an object, or a delimited prefix standing for every key under
        // it, placed (and resumed after) by its last key.
        const rows = [];
        const prefixes = new Map();
        for (const { key, fileName } of listObjectFiles(this.vfs, this.dir, prefix)) {
            if (startAfter !== undefined && utf8Order(key, startAfter) <= 0)
                continue;
            const at = delimiter === undefined ? -1 : key.indexOf(delimiter, prefix.length);
            if (delimiter === undefined || at === -1) {
                rows.push({ lastKey: key, key, fileName });
                continue;
            }
            const delimited = key.slice(0, at + delimiter.length);
            const row = prefixes.get(delimited);
            if (row === undefined) {
                const added = { lastKey: key, prefix: delimited };
                prefixes.set(delimited, added);
                rows.push(added);
            }
            else {
                row.lastKey = key;
            }
        }
        rows.sort((a, b) => utf8Order(a.lastKey, b.lastKey));
        const page = rows.slice(0, limit);
        const objects = [];
        const delimitedPrefixes = [];
        for (const row of page) {
            if (row.prefix !== undefined) {
                delimitedPrefixes.push(row.prefix);
                continue;
            }
            const side = row.fileName === undefined ? null : this.#readSide(row.fileName);
            if (row.key === undefined || side === null)
                continue;
            objects.push(this.#object(row.key, {
                ...side,
                httpMetadata: include.includes('httpMetadata') ? side.httpMetadata : {},
                customMetadata: include.includes('customMetadata') ? side.customMetadata : {},
            }, undefined));
        }
        const truncated = rows.length > limit;
        return {
            objects,
            truncated,
            ...(truncated ? { cursor: cursorAfter(page[page.length - 1].lastKey) } : {}),
            delimitedPrefixes,
        };
    }
    // ── internals ─────────────────────────────────────────────────────────
    /** An object's fields, as R2 answers them. */
    #object(key, side, range) {
        return {
            key,
            version: side.version ?? side.etag,
            size: side.size,
            etag: side.etag,
            uploaded: side.uploaded,
            httpMetadata: side.httpMetadata ?? {},
            customMetadata: side.customMetadata ?? {},
            ...(range === undefined ? {} : { range }),
            checksums: side.checksums ?? {},
            storageClass: '',
        };
    }
    #readSide(fileName) {
        const path = this.dir + '/' + fileName + '.meta';
        if (!this.vfs.exists(path))
            return null;
        try {
            return R2SidecarSchema.parse(JSON.parse(this.vfs.readFileString(path)));
        }
        catch {
            return null; // a torn sidecar reads as no object
        }
    }
}
/** One call of the R2 API (fabric bindings.ts NimbusR2Bucket), served by `r2`. */
export function serveR2Call(r2, call) {
    switch (call.method) {
        case 'head': return r2.head(String(call.key));
        case 'get': return r2.get(String(call.key), call.options);
        case 'put': return r2.put(String(call.key), call.value, call.options);
        case 'delete': return r2.delete(Array.isArray(call.keys) ? call.keys.map(String) : String(call.keys));
        case 'list': return r2.list(call.options);
    }
}
