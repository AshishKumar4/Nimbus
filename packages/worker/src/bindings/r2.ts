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
 *
 * A body is streamed to a file beside its key's as it arrives, hashed as it
 * goes, and replaces the key's once whole and checked: one past R2's
 * per-upload limit is refused as it passes it, its stream cancelled, and
 * one that fails its checksum or condition leaves the object it would have
 * replaced. A get streams its body from the file a piece at a time.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type {
  R2Call, R2EtagCondition, R2HashName, R2PutBody, R2WireChecksums, R2WireConditional, R2WireGetOptions, R2WireGetResult,
  R2WireListOptions, R2WireObject, R2WireObjects, R2WirePutOptions,
} from '@nimbus-sh/fabric/inner-storage-env.js';
import { ensureBindingDir, fileStream, writeBody } from './body.js';
import { cursorAfter, cursorKey, listObjectFiles, objectFileName, objectStoreDir, removeObjectFiles, uploadFileName, utf8Order } from './object-store.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { bytesToHex } from '@nimbus-sh/platform/hex.js';

/** R2's limit on one upload (a put): 5 GiB less 5 MiB. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;

export interface R2EmulatorOptions {
  vfs: CredentialedVfs;
  root: string;
  binding: string;
  /** The most one put may store; R2's limit unless a test lowers it. */
  maxUploadBytes?: number;
}

const HttpMetadataSchema = z.object({
  contentType: z.string().optional(),
  contentLanguage: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentEncoding: z.string().optional(),
  cacheControl: z.string().optional(),
  cacheExpiry: z.coerce.date().optional(),
});

/** The options of a call, as a Worker's binding sends them; anything else is refused before it is stored. */
const EtagSchema = z.union([
  z.object({ type: z.literal('wildcard') }),
  z.object({ type: z.enum(['strong', 'weak']), value: z.string() }),
]);
const ConditionalSchema = z.object({
  etagMatches: z.array(EtagSchema).optional(),
  etagDoesNotMatch: z.array(EtagSchema).optional(),
  uploadedBefore: z.date().optional(),
  uploadedAfter: z.date().optional(),
  secondsGranularity: z.boolean().optional(),
});
const GetOptionsSchema = z.object({
  onlyIf: ConditionalSchema.optional(),
  range: z.object({ offset: z.number().optional(), length: z.number().optional(), suffix: z.number().optional() }).optional(),
  rangeHeader: z.string().optional(),
});
const PutOptionsSchema = z.object({
  onlyIf: ConditionalSchema.optional(),
  httpMetadata: z.object({
    contentType: z.string().optional(),
    contentLanguage: z.string().optional(),
    contentDisposition: z.string().optional(),
    contentEncoding: z.string().optional(),
    cacheControl: z.string().optional(),
    cacheExpiry: z.date().optional(),
  }).optional(),
  customMetadata: z.record(z.string(), z.string()).optional(),
  checksums: z.partialRecord(z.enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512']), z.string().regex(/^[0-9a-f]+$/)).optional(),
});
const ListOptionsSchema = z.object({
  limit: z.number().int().optional(),
  prefix: z.string().optional(),
  cursor: z.string().optional(),
  delimiter: z.string().optional(),
  startAfter: z.string().optional(),
  include: z.array(z.enum(['httpMetadata', 'customMetadata'])).optional(),
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
type R2Sidecar = z.infer<typeof R2SidecarSchema>;

const MAX_KEY_BYTES = 1024;
/** The most a put's custom metadata may be, each key and value counted as serialisedLength counts it. */
const MAX_METADATA_BYTES = 2048;

/** A metadata string's length as R2 counts it: double when any character is past U+00FF. */
function serialisedLength(text: string): number {
  return [...text].some((char) => char.charCodeAt(0) >= 256) ? text.length * 2 : text.length;
}
const MAX_LIST_KEYS = 1000;
/** The most objects a listing answers that includes metadata. */
const MAX_LIST_KEYS_WITH_METADATA = 100;

/** Each digest an object can carry, as R2 names it in a checksum error. */
const HASHES: readonly { name: R2HashName; label: string }[] = [
  { name: 'md5', label: 'MD5' },
  { name: 'sha1', label: 'SHA-1' },
  { name: 'sha256', label: 'SHA-256' },
  { name: 'sha384', label: 'SHA-384' },
  { name: 'sha512', label: 'SHA-512' },
];


/** An error of R2's, as workerd's R2 client throws it: the action, the message, R2's code. */
function r2Error(action: string, message: string, code: number): Error {
  return new Error(`${action}: ${message} (${code})`);
}

function validateKey(action: string, key: string): void {
  if (utf8Length(key) > MAX_KEY_BYTES) throw r2Error(action, 'The specified object name is not valid.', 10020);
}

function includesEtag(conditions: readonly R2EtagCondition[], etag: string, comparison: 'strong' | 'weak'): boolean {
  return conditions.some((c) => c.type === 'wildcard' || (c.value === etag && (c.type === 'strong' || comparison === 'weak')));
}

/** Whether `onlyIf` holds for the object `side` (none when absent), as R2 tests it. */
function conditionHolds(onlyIf: R2WireConditional, side: R2Sidecar | null): boolean {
  if (side === null) return onlyIf.etagMatches === undefined && onlyIf.uploadedAfter === undefined;
  const truncate = (ms: number) => (onlyIf.secondsGranularity ? Math.floor(ms / 1000) * 1000 : ms);
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
function headerRange(header: string, size: number): { start: number; end: number } | undefined {
  const prefix = /^ *bytes *=/i.exec(header);
  if (prefix === null) return undefined;
  const ranges: { start: number; end: number }[] = [];
  for (const part of header.slice(prefix[0].length).split(',')) {
    const match = /^ *(\d+)? *- *(\d+)? *$/.exec(part);
    if (match === null) return undefined;
    const [, start, end] = match;
    if (start !== undefined && end !== undefined) {
      const from = parseInt(start, 10);
      const to = parseInt(end, 10);
      if (from > to || from >= size) return undefined;
      ranges.push({ start: from, end: Math.min(to, size - 1) });
    } else if (start !== undefined) {
      const from = parseInt(start, 10);
      if (from >= size) return undefined;
      ranges.push({ start: from, end: size - 1 });
    } else if (end !== undefined) {
      const suffix = parseInt(end, 10);
      if (suffix >= size) return undefined;
      if (suffix !== 0) ranges.push({ start: size - suffix, end: size - 1 });
    } else {
      return undefined;
    }
  }
  return ranges.length === 1 ? ranges[0] : undefined;
}

/** The bytes a get asks for, or none for the whole object; a range the object cannot satisfy is refused. */
function requestedRange(options: R2WireGetOptions, size: number): { start: number; end: number } | undefined {
  if (options.rangeHeader !== undefined) return headerRange(options.rangeHeader, size);
  if (options.range === undefined) return undefined;
  let { offset, length } = options.range;
  const { suffix } = options.range;
  if (suffix !== undefined) {
    if (suffix <= 0) throw r2Error('get', 'The requested range is not satisfiable', 10039);
    offset = size - Math.min(suffix, size);
    length = Math.min(suffix, size);
  }
  offset ??= 0;
  length ??= size - offset;
  if (offset < 0 || offset > size || length <= 0) throw r2Error('get', 'The requested range is not satisfiable', 10039);
  return { start: offset, end: offset + Math.min(length, size - offset) - 1 };
}

export class R2Emulator {
  private vfs: CredentialedVfs;
  private dir: string;
  private maxUploadBytes: number;

  constructor(opts: R2EmulatorOptions) {
    this.vfs = opts.vfs;
    this.dir = objectStoreDir(opts.root, 'r2', opts.binding);
    this.maxUploadBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  }

  // ── public API ────────────────────────────────────────────────────────

  async head(key: string): Promise<R2WireObject | null> {
    validateKey('head', key);
    const side = this.#readSide(objectFileName(key));
    return side === null ? null : this.#object(key, side, { offset: 0, length: side.size });
  }

  async get(key: string, options: R2WireGetOptions): Promise<R2WireGetResult | null> {
    validateKey('get', key);
    const fileName = objectFileName(key);
    const side = this.#readSide(fileName);
    if (side === null) return null;
    if (options.onlyIf !== undefined && !conditionHolds(options.onlyIf, side)) {
      return { object: this.#object(key, side, { offset: 0, length: side.size }), body: null };
    }
    const range = requestedRange(options, side.size);
    const path = this.dir + '/' + fileName;
    if (range === undefined) return { object: this.#object(key, side, { offset: 0, length: side.size }), body: fileStream(this.vfs, path, 0, side.size) };
    const length = range.end - range.start + 1;
    return { object: this.#object(key, side, { offset: range.start, length }), body: fileStream(this.vfs, path, range.start, length) };
  }

  async put(key: string, value: R2PutBody, options: R2WirePutOptions): Promise<R2WireObject | null> {
    validateKey('put', key);
    // MD5 always (the etag), and the one digest the caller gave to check.
    const digests = HASHES.filter(({ name }) => name === 'md5' || options.checksums?.[name] !== undefined)
      .map((hash) => ({ ...hash, digest: createHash(hash.name) }));
    ensureBindingDir(this.vfs, this.dir);
    const upload = this.dir + '/' + uploadFileName();
    const size = await writeBody(this.vfs, upload, value, this.maxUploadBytes,
      () => r2Error('put', 'Your proposed upload exceeds the maximum allowed object size.', 100100),
      (piece) => { for (const { digest } of digests) digest.update(piece); });
    try {
      let metadataBytes = 0;
      for (const [name, field] of Object.entries(options.customMetadata ?? {})) metadataBytes += serialisedLength(name) + serialisedLength(field);
      if (metadataBytes > MAX_METADATA_BYTES) throw r2Error('put', 'Your metadata headers exceed the maximum allowed metadata size.', 10012);
      const checksums: R2WireChecksums = {};
      for (const { name, label, digest } of digests) {
        const computed = digest.digest('hex');
        const provided = options.checksums?.[name];
        if (provided !== undefined && provided !== computed) {
          throw r2Error('put', [
            `The ${label} checksum you specified did not match what we received.`,
            `You provided a ${label} checksum with value: ${provided}`,
            `Actual ${label} was: ${computed}`,
          ].join('\n'), 10037);
        }
        checksums[name] = computed;
      }
      const fileName = objectFileName(key);
      if (options.onlyIf !== undefined && !conditionHolds(options.onlyIf, this.#readSide(fileName))) {
        this.vfs.unlink(upload);
        return null;
      }
      const side: R2Sidecar = {
        etag: checksums.md5 ?? '',
        version: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
        size,
        uploaded: Date.now(),
        checksums,
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
        v: 1,
      };
      this.vfs.rename(upload, this.dir + '/' + fileName);
      this.vfs.writeFile(this.dir + '/' + fileName + '.meta', JSON.stringify(side));
      return this.#object(key, side, undefined);
    } catch (error) {
      if (this.vfs.exists(upload)) this.vfs.unlink(upload);
      throw error;
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) validateKey('delete', key);
    for (const key of list) removeObjectFiles(this.vfs, this.dir, objectFileName(key));
  }

  async list(options: R2WireListOptions): Promise<R2WireObjects> {
    let limit = options.limit ?? MAX_LIST_KEYS;
    if (limit < 1 || limit > MAX_LIST_KEYS) throw r2Error('list', `MaxKeys params must be positive integer <= ${MAX_LIST_KEYS}.`, 10022);
    const include = options.include ?? [];
    if (include.length > 0) limit = Math.min(limit, MAX_LIST_KEYS_WITH_METADATA);
    const prefix = options.prefix ?? '';
    let startAfter = options.startAfter;
    if (options.cursor !== undefined) {
      const after = cursorKey(options.cursor);
      if (startAfter === undefined || utf8Order(after, startAfter) > 0) startAfter = after;
    }
    const delimiter = options.delimiter === '' ? undefined : options.delimiter;

    // Each row: an object, or a delimited prefix standing for every key under
    // it, placed (and resumed after) by its last key.
    const rows: { lastKey: string; prefix?: string; key?: string; fileName?: string }[] = [];
    const prefixes = new Map<string, { lastKey: string; prefix?: string }>();
    for (const { key, fileName } of listObjectFiles(this.vfs, this.dir, prefix)) {
      if (startAfter !== undefined && utf8Order(key, startAfter) <= 0) continue;
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
      } else {
        row.lastKey = key;
      }
    }
    rows.sort((a, b) => utf8Order(a.lastKey, b.lastKey));

    const page = rows.slice(0, limit);
    const objects: R2WireObject[] = [];
    const delimitedPrefixes: string[] = [];
    for (const row of page) {
      if (row.prefix !== undefined) {
        delimitedPrefixes.push(row.prefix);
        continue;
      }
      const side = row.fileName === undefined ? null : this.#readSide(row.fileName);
      if (row.key === undefined || side === null) continue;
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
  #object(key: string, side: R2Sidecar, range: { offset: number; length: number } | undefined): R2WireObject {
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

  #readSide(fileName: string): R2Sidecar | null {
    const path = this.dir + '/' + fileName + '.meta';
    if (!this.vfs.exists(path)) return null;
    try {
      return R2SidecarSchema.parse(JSON.parse(this.vfs.readFileString(path)));
    } catch {
      return null; // a torn sidecar reads as no object
    }
  }
}

/** One call of the R2 API (fabric bindings.ts NimbusR2Bucket), served by `r2`. */
export async function serveR2Call(r2: R2Emulator, call: R2Call): Promise<R2WireObject | R2WireGetResult | R2WireObjects | null | void> {
  switch (call.method) {
    case 'head': return r2.head(String(call.key));
    case 'get': return r2.get(String(call.key), GetOptionsSchema.parse(call.options ?? {}));
    case 'put': return r2.put(String(call.key), call.value, PutOptionsSchema.parse(call.options ?? {}));
    case 'delete': return r2.delete(Array.isArray(call.keys) ? call.keys.map(String) : String(call.keys));
    case 'list': return r2.list(ListOptionsSchema.parse(call.options ?? {}));
    default:
      call satisfies never;
      throw new TypeError('R2 has no such method');
  }
}
