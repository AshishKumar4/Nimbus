/**
 * inner-storage-env.ts — D1 and R2 bindings inside an inner Worker.
 *
 * `nimbus wrangler dev` gives the user's Worker each D1 and R2 binding as an
 * entrypoint of the session's isolate (bindings.ts NimbusD1Binding and
 * NimbusR2Bucket): a Worker Loader env carries nothing else that reaches
 * the session. Neither is the platform's API as it stands. A D1 statement
 * is prepared and bound synchronously, and a batch takes statements made
 * locally, where an RPC stub answers RpcPromises, which cannot travel as
 * arguments; an R2 object is a value with methods (text(), json(),
 * writeHttpMetadata), which cannot cross RPC at all.
 *
 * So the module that adapts the isolate's env before any of the Worker's
 * code runs (inner-env.ts innerWorkerModules) replaces each with a local
 * object of the platform's shape: a D1Database as workerd's own
 * (cloudflare-internal:d1-api, without the experimental d1_binding_jsrpc
 * flag) over the binding's `query`, which is D1's binding contract; and an
 * R2Bucket as workerd's (r2-bucket.c++), whose objects it makes from the
 * fields the binding answers. Each checks its arguments, and throws, as
 * workerd does before it sends a request. A KV binding's calls and answers
 * cross RPC as they are, streams included; its env.KV converts only the
 * options, as workerd's KV client does before it sends them: an int by
 * ToNumber (jsg-int.ts), which an object's valueOf answers, and whose
 * function would not cross RPC as one.
 *
 * Self-contained: compiled with its dependencies into an expression at
 * build time, which runs in the inner isolate.
 */
import { jsgInt } from './jsg-int.js';
import { bytesToHex } from '@nimbus-sh/platform/hex.js';
/**
 * The adapter, as it runs in the inner isolate: it replaces each of `names`
 * in `env` that holds the binding the loader passes with the platform's
 * local object over it.
 */
export function innerStorageAdapter(names, env) {
    for (const name of names.kv) {
        const remote = Reflect.get(env, name);
        if (isRemote(remote, ['get', 'getWithMetadata', 'put', 'delete', 'list']))
            Reflect.set(env, name, new KVNamespace(remote));
    }
    for (const name of names.d1) {
        const remote = Reflect.get(env, name);
        if (isRemote(remote, ['query']))
            Reflect.set(env, name, new D1Database(remote));
    }
    for (const name of names.r2) {
        const remote = Reflect.get(env, name);
        if (isRemote(remote, ['head', 'get', 'put', 'delete', 'list']))
            Reflect.set(env, name, new R2Bucket(remote));
    }
}
/** Whether `value` is the binding the loader passes, with each of `methods` (an RPC stub's methods are its properties). */
function isRemote(value, methods) {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
        && methods.every((method) => typeof Reflect.get(value, method) === 'function');
}
/** Observable platform type names, which the compiled adapter would otherwise minify. */
function named(type, name) {
    return Object.defineProperty(type, 'name', { value: name, configurable: true });
}
function kvGetOptions(options) {
    if (options === undefined)
        return undefined;
    if (typeof options !== 'object')
        return String(options);
    const out = {};
    if (options.type !== undefined)
        out.type = String(options.type);
    const cacheTtl = jsgInt(options.cacheTtl);
    if (cacheTtl !== undefined)
        out.cacheTtl = cacheTtl;
    return out;
}
/**
 * env.KV: the namespace's calls, their options converted as workerd's
 * client converts them. A conversion that fails rejects the call's promise,
 * as an argument workerd cannot convert does for a method that answers one.
 */
class KVNamespace {
    #remote;
    constructor(remote) {
        this.#remote = remote;
    }
    async get(key, options) {
        return await this.#remote.get(key, kvGetOptions(options));
    }
    async getWithMetadata(key, options) {
        return await this.#remote.getWithMetadata(key, kvGetOptions(options));
    }
    async put(key, value, options) {
        if (options === undefined)
            return await this.#remote.put(key, value);
        const out = {};
        const expiration = jsgInt(options.expiration);
        if (expiration !== undefined)
            out.expiration = expiration;
        const expirationTtl = jsgInt(options.expirationTtl);
        if (expirationTtl !== undefined)
            out.expirationTtl = expirationTtl;
        if (options.metadata !== undefined)
            out.metadata = options.metadata;
        return await this.#remote.put(key, value, out);
    }
    async delete(key) {
        return await this.#remote.delete(key);
    }
    async list(options) {
        if (options === undefined)
            return await this.#remote.list();
        const out = {};
        const limit = jsgInt(options.limit);
        if (limit !== undefined)
            out.limit = limit;
        if (options.prefix !== undefined && options.prefix !== null)
            out.prefix = String(options.prefix);
        if (options.cursor !== undefined && options.cursor !== null)
            out.cursor = String(options.cursor);
        return await this.#remote.list(out);
    }
}
named(KVNamespace, 'KvNamespace');
const D1_SESSION_CONSTRAINT_FIRST_PRIMARY = 'first-primary';
const D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED = 'first-unconstrained';
/** Thrown as d1-api throws: `<code>: <message>`, its cause the bare message unless it names another. */
function d1Error(code, message, cause = message) {
    return new Error(`${code}: ${message}`, { cause: new Error(cause) });
}
/** d1-api toArrayOfObjects: each row an object of its columns, a later column of a name winning. */
function rowsAsObjects(answer) {
    const { columns, rows } = answer.results;
    return { ...answer, results: rows.map((row) => Object.fromEntries(row.map((cell, i) => [columns[i], cell]))) };
}
/** `queries` sent as `session` sends them: off the session's own surface. */
let sendD1;
/**
 * The session a statement runs in (d1-api D1DatabaseSession): it sends its
 * bookmark (or constraint) with each request, and keeps the latest bookmark
 * the database answers. The database's own session goes to the primary, and
 * sends and keeps none.
 */
class D1DatabaseSession {
    #remote;
    #keepsBookmark;
    #bookmark;
    static {
        sendD1 = (session, queries, code) => session.#send(queries, code);
    }
    constructor(remote, bookmarkOrConstraint) {
        this.#remote = remote;
        this.#keepsBookmark = bookmarkOrConstraint !== null;
        if (bookmarkOrConstraint === null) {
            this.#bookmark = null;
        }
        else {
            this.#bookmark = bookmarkOrConstraint.trim();
            if (!this.#bookmark)
                throw new Error('D1_SESSION_ERROR: invalid bookmark or constraint');
        }
    }
    /**
     * `queries` run in one transaction: each answer, or the failure rolling
     * them back thrown as `<code>: <message>`. A bookmark answered replaces
     * the session's only when it is later (d1-api _updateBookmark).
     */
    async #send(queries, code) {
        const response = await this.#remote.query(this.#bookmark === null ? { queries } : { queries, bookmark: this.#bookmark });
        if (!response.success)
            throw d1Error(code, response.error.message);
        const answered = response.results.bookmark?.trim();
        const current = this.getBookmark();
        if (this.#keepsBookmark && answered && (current === null || current.localeCompare(answered) < 0))
            this.#bookmark = answered;
        return response.results.queryResults.map(({ meta, data }) => ({ success: true, meta, results: { columns: data.columns, rows: data.rows } }));
    }
    prepare(sql) {
        return new D1PreparedStatement(this, sql);
    }
    async batch(statements) {
        const answers = await this.#send(statements.map(statementQuery), 'D1_ERROR');
        return answers.map(rowsAsObjects);
    }
    /** The latest bookmark the session saw; a constraint is none. The database answers none. */
    getBookmark() {
        switch (this.#bookmark) {
            case D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED:
            case D1_SESSION_CONSTRAINT_FIRST_PRIMARY:
                return null;
            default:
                return this.#bookmark;
        }
    }
}
function statementQuery(statement) {
    return { sql: statement.statement, params: statement.params };
}
/** d1-api D1PreparedStatement.bind: what a value is sent as, or the type error it throws. */
function d1Param(value) {
    if (typeof value === 'number' || typeof value === 'string')
        return value;
    if (typeof value === 'boolean')
        return value ? 1 : 0;
    if (typeof value === 'object') {
        if (value === null)
            return null;
        if (Array.isArray(value) && value.every((b) => typeof b === 'number' && b >= 0 && b < 256))
            return value;
        if (value instanceof ArrayBuffer)
            return Array.from(new Uint8Array(value));
        if (ArrayBuffer.isView(value))
            return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    throw d1Error('D1_TYPE_ERROR', `Type '${typeof value}' not supported for value '${String(value)}'`);
}
class D1PreparedStatement {
    #session;
    statement;
    params;
    constructor(session, statement, params = []) {
        this.#session = session;
        this.statement = statement;
        this.params = params;
    }
    bind(...values) {
        return new D1PreparedStatement(this.#session, this.statement, values.map(d1Param));
    }
    async first(column) {
        const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
        const row = rowsAsObjects(answer).results[0];
        if (row === undefined)
            return null;
        if (column === undefined)
            return row;
        if (row[column] === undefined)
            throw d1Error('D1_COLUMN_NOTFOUND', `Column not found (${column})`, 'Column not found');
        return row[column];
    }
    async run() {
        const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
        return rowsAsObjects(answer);
    }
    async all() {
        const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
        return rowsAsObjects(answer);
    }
    async raw(options) {
        const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
        const { columns, rows } = answer.results;
        return options?.columnNames ? [columns, ...rows] : rows;
    }
}
/** env.DB: the database, whose own statements go to the primary (d1-api D1Database). */
class D1Database {
    #remote;
    #primary;
    constructor(remote) {
        this.#remote = remote;
        this.#primary = new D1DatabaseSession(remote, null);
    }
    prepare(query) {
        return new D1PreparedStatement(this.#primary, query);
    }
    batch(statements) {
        return this.#primary.batch(statements);
    }
    /**
     * d1-api's exec: each line of `query` a statement, all in one transaction;
     * a failure names the first line, as D1 does.
     */
    async exec(query) {
        const lines = query.trim().split('\n');
        const response = await this.#remote.query({ queries: lines.map((sql) => ({ sql })) });
        if (!response.success) {
            throw d1Error('D1_EXEC_ERROR', `Error in line 1: ${lines[0]}: ${response.error.message}`);
        }
        const results = response.results.queryResults;
        return { count: results.length, duration: results.reduce((total, result) => total + result.meta.duration, 0) };
    }
    withSession(constraintOrBookmark) {
        const given = constraintOrBookmark?.trim();
        return new D1DatabaseSession(this.#remote, given ? given : D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED);
    }
    /** D1's raw query API, which the platform serves only behind an experimental flag no Worker Loader guest can set. */
    async query() {
        throw new Error('D1_ERROR: D1Database.query() requires the d1_binding_jsrpc compatibility flag. Enable d1_binding_jsrpc before calling query().');
    }
    async dump() {
        throw new Error('D1_DUMP_ERROR: dump() is not supported');
    }
}
named(D1Database, 'D1Database');
named(D1DatabaseSession, 'D1DatabaseSession');
named(D1PreparedStatement, 'D1PreparedStatement');
// ── R2 ─────────────────────────────────────────────────────────────────────
const HASHES = [
    { name: 'md5', label: 'MD5', bytes: 16 },
    { name: 'sha1', label: 'SHA-1', bytes: 20 },
    { name: 'sha256', label: 'SHA-256', bytes: 32 },
    { name: 'sha384', label: 'SHA-384', bytes: 48 },
    { name: 'sha512', label: 'SHA-512', bytes: 64 },
];
function fromHex(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out.buffer;
}
/** R2Checksums: each digest the object has, as bytes, and as hex in its JSON. */
class Checksums {
    #hex;
    constructor(hex) {
        this.#hex = hex;
        for (const { name } of [...HASHES].reverse()) {
            const digest = hex[name];
            Object.defineProperty(this, name, { value: digest === undefined ? undefined : fromHex(digest), enumerable: true });
        }
    }
    toJSON() {
        const out = {};
        for (const { name } of HASHES) {
            const digest = this.#hex[name];
            if (digest !== undefined)
                out[name] = digest;
        }
        return out;
    }
}
/** The headers an object's HTTP metadata writes, as R2's writeHttpMetadata sets them. */
function writeMetadata(key, metadata, headers) {
    if (metadata === undefined) {
        throw new TypeError(`HTTP metadata unknown for key \`${key}\`. Did you forget to add 'httpMetadata' to \`include\` when listing?`);
    }
    if (metadata.contentType !== undefined)
        headers.set('content-type', metadata.contentType);
    if (metadata.contentLanguage !== undefined)
        headers.set('content-language', metadata.contentLanguage);
    if (metadata.contentDisposition !== undefined)
        headers.set('content-disposition', metadata.contentDisposition);
    if (metadata.contentEncoding !== undefined)
        headers.set('content-encoding', metadata.contentEncoding);
    if (metadata.cacheControl !== undefined)
        headers.set('cache-control', metadata.cacheControl);
    if (metadata.cacheExpiry !== undefined)
        headers.set('expires', metadata.cacheExpiry.toUTCString());
}
/**
 * R2Object (workerd's HeadResult): its fields are its own, read-only,
 * enumerable, in the order workerd defines them.
 */
class HeadResult {
    constructor(object) {
        const fields = [
            ['ssecKeyMd5', undefined],
            ['storageClass', object.storageClass],
            ['range', object.range],
            ['customMetadata', object.customMetadata],
            ['httpMetadata', object.httpMetadata],
            ['uploaded', new Date(object.uploaded)],
            ['checksums', new Checksums(object.checksums)],
            ['httpEtag', `"${object.etag}"`],
            ['etag', object.etag],
            ['size', object.size],
            ['version', object.version],
            ['key', object.key],
        ];
        for (const [name, value] of fields)
            Object.defineProperty(this, name, { value, enumerable: true });
    }
    writeHttpMetadata(headers) {
        writeMetadata(this.key, this.httpMetadata, headers);
    }
}
/** R2ObjectBody (workerd's GetResult): the object and its one-shot body. */
class GetResult extends HeadResult {
    #body;
    constructor(object, body) {
        super(object);
        this.#body = new Response(body);
    }
    get body() { return this.#body.body; }
    get bodyUsed() { return this.#body.bodyUsed; }
    arrayBuffer() { return this.#body.arrayBuffer(); }
    bytes() { return this.#body.bytes(); }
    text() { return this.#body.text(); }
    json() { return this.#body.json(); }
    blob() { return this.#body.blob(); }
}
named(Checksums, 'Checksums');
named(HeadResult, 'HeadResult');
named(GetResult, 'GetResult');
/** An If-Match / If-None-Match header's etags (r2-bucket.c++ parseConditionalEtagHeader). */
function parseEtagHeader(header) {
    const etags = [];
    let rest = header;
    let commaRequired = false;
    for (;;) {
        rest = rest.replace(/^[ \t]+/, '');
        if (rest === '')
            return etags;
        const first = rest[0];
        if (first === ',') {
            rest = rest.slice(1);
            commaRequired = false;
        }
        else if (first === '*') {
            if (commaRequired)
                throw new Error("Comma was expected to separate etags. Encountered a wildcard character '*' instead.");
            return [{ type: 'wildcard' }];
        }
        else if (first === 'W') {
            if (commaRequired) {
                throw new Error("Comma was expected to separate etags. Encountered a weak quotation character 'W' instead. This would otherwise indicate the start of a new weak etag.");
            }
            if (!rest.startsWith('W/"'))
                throw new Error('Weak etags must start with W/ and their value must be quoted');
            rest = rest.slice(3);
            const close = rest.indexOf('"');
            if (close === -1)
                throw new Error('Unclosed double quote for Etag');
            etags.push({ type: 'weak', value: rest.slice(0, close) });
            rest = rest.slice(close + 1);
            commaRequired = true;
        }
        else if (first === '"') {
            if (commaRequired) {
                throw new Error('Comma was expected to separate etags. Encountered a double quote character \'"\' instead. This would otherwise indicate the start of a new strong etag.');
            }
            rest = rest.slice(1);
            const close = rest.indexOf('"');
            if (close === -1)
                throw new Error('Unclosed double quote for Etag');
            etags.push({ type: 'strong', value: rest.slice(0, close) });
            rest = rest.slice(close + 1);
            commaRequired = true;
        }
        else {
            return etags;
        }
    }
}
function singleEtag(value) {
    if (value.startsWith('"') && value.endsWith('"')) {
        throw new TypeError(`Conditional ETag should not be wrapped in quotes (${value}).`);
    }
    return value === '*' ? [{ type: 'wildcard' }] : [{ type: 'strong', value }];
}
/** An HTTP date header, as workerd parses one for R2. */
function headerDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        throw new TypeError(`Invalid date: ${value}`);
    return date;
}
/** A conditional or its headers, as R2's client sends it (r2-bucket.c++ UnwrappedConditional). */
function wireConditional(onlyIf) {
    if (onlyIf instanceof Headers) {
        const out = { secondsGranularity: true };
        const ifMatch = onlyIf.get('if-match');
        if (ifMatch !== null) {
            out.etagMatches = parseEtagHeader(ifMatch);
            if (out.etagMatches.length === 0)
                throw new Error('Invalid ETag in if-match header');
        }
        const ifNoneMatch = onlyIf.get('if-none-match');
        if (ifNoneMatch !== null) {
            out.etagDoesNotMatch = parseEtagHeader(ifNoneMatch);
            if (out.etagDoesNotMatch.length === 0)
                throw new Error('Invalid ETag in if-none-match header');
        }
        const modifiedSince = onlyIf.get('if-modified-since');
        if (modifiedSince !== null)
            out.uploadedAfter = headerDate(modifiedSince);
        const unmodifiedSince = onlyIf.get('if-unmodified-since');
        if (unmodifiedSince !== null)
            out.uploadedBefore = headerDate(unmodifiedSince);
        return out;
    }
    const out = { secondsGranularity: onlyIf.secondsGranularity ?? false };
    if (onlyIf.etagMatches !== undefined)
        out.etagMatches = singleEtag(onlyIf.etagMatches);
    if (onlyIf.etagDoesNotMatch !== undefined)
        out.etagDoesNotMatch = singleEtag(onlyIf.etagDoesNotMatch);
    if (onlyIf.uploadedAfter !== undefined)
        out.uploadedAfter = onlyIf.uploadedAfter;
    if (onlyIf.uploadedBefore !== undefined)
        out.uploadedBefore = onlyIf.uploadedBefore;
    return out;
}
/** A range's numbers, checked as R2's client checks them before sending. */
function wireRange(range) {
    const out = {};
    if (range.offset !== undefined) {
        if (!(range.offset >= 0))
            throw new RangeError(`Invalid range. Starting offset (${range.offset}) must be greater than or equal to 0.`);
        if (!Number.isInteger(range.offset))
            throw new RangeError(`Invalid range. Starting offset (${range.offset}) must be an integer, not floating point.`);
        out.offset = range.offset;
    }
    if (range.length !== undefined) {
        if (!(range.length >= 0))
            throw new RangeError(`Invalid range. Length (${range.length}) must be greater than or equal to 0.`);
        if (!Number.isInteger(range.length))
            throw new RangeError(`Invalid range. Length (${range.length}) must be an integer, not floating point.`);
        out.length = range.length;
    }
    if (range.suffix !== undefined) {
        if (range.offset !== undefined)
            throw new TypeError('Suffix is incompatible with offset.');
        if (range.length !== undefined)
            throw new TypeError('Suffix is incompatible with length.');
        if (!(range.suffix >= 0))
            throw new RangeError(`Invalid suffix. Suffix (${range.suffix}) must be greater than or equal to 0.`);
        if (!Number.isInteger(range.suffix))
            throw new RangeError(`Invalid range. Suffix (${range.suffix}) must be an integer, not floating point.`);
        out.suffix = range.suffix;
    }
    return out;
}
/** HTTP metadata from request headers (r2-bucket.c++ HttpMetadata::fromRequestHeaders). */
function metadataFromHeaders(headers) {
    const out = {};
    const contentType = headers.get('content-type');
    if (contentType !== null)
        out.contentType = contentType;
    const contentEncoding = headers.get('content-encoding');
    if (contentEncoding !== null)
        out.contentEncoding = contentEncoding;
    const contentDisposition = headers.get('content-disposition');
    if (contentDisposition !== null)
        out.contentDisposition = contentDisposition;
    const contentLanguage = headers.get('content-language');
    if (contentLanguage !== null)
        out.contentLanguage = contentLanguage;
    const cacheControl = headers.get('cache-control');
    if (cacheControl !== null)
        out.cacheControl = cacheControl;
    const expires = headers.get('expires');
    if (expires !== null)
        out.cacheExpiry = headerDate(expires);
    return out;
}
/** The one digest `options` gives, as hex, checked as R2's client checks it. */
function wireChecksums(options) {
    let checksums;
    for (const { name, label, bytes } of HASHES) {
        const digest = options[name];
        if (digest === undefined)
            continue;
        if (checksums !== undefined)
            throw new TypeError('You cannot specify multiple hashing algorithms.');
        if (typeof digest === 'string') {
            if (digest.length !== bytes * 2)
                throw new TypeError(`${label} is ${bytes * 2} hex characters, not ${digest.length}`);
            if (!/^[0-9a-fA-F]*$/.test(digest))
                throw new TypeError(`Provided ${label} wasn't a valid hex string`);
            checksums = { [name]: digest.toLowerCase() };
        }
        else {
            const view = digest instanceof ArrayBuffer ? new Uint8Array(digest) : new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
            if (view.byteLength !== bytes)
                throw new TypeError(`${label} is ${bytes} bytes, not ${view.byteLength}`);
            checksums = { [name]: bytesToHex(view) };
        }
    }
    return checksums;
}
/** env.BUCKET: the bucket, whose objects it makes from what the binding answers. */
class R2Bucket {
    #remote;
    constructor(remote) {
        this.#remote = remote;
    }
    async head(key) {
        const object = await this.#remote.head(String(key));
        return object === null ? null : new HeadResult(object);
    }
    async get(key, options) {
        const wire = {};
        if (options?.onlyIf !== undefined)
            wire.onlyIf = wireConditional(options.onlyIf);
        if (options?.range instanceof Headers) {
            const header = options.range.get('range');
            if (header !== null)
                wire.rangeHeader = header;
        }
        else if (options?.range !== undefined) {
            wire.range = wireRange(options.range);
        }
        const answer = await this.#remote.get(String(key), wire);
        if (answer === null)
            return null;
        return answer.body === null ? new HeadResult(answer.object) : new GetResult(answer.object, answer.body);
    }
    async put(key, value, options) {
        const wire = {};
        // Each metadata value is a string, as workerd's Dict<kj::String> and HttpMetadata coerce them.
        if (options?.customMetadata !== undefined) {
            wire.customMetadata = Object.fromEntries(Object.entries(options.customMetadata).map(([name, field]) => [name, String(field)]));
        }
        if (options?.httpMetadata instanceof Headers) {
            wire.httpMetadata = metadataFromHeaders(options.httpMetadata);
        }
        else if (options?.httpMetadata !== undefined) {
            const given = options.httpMetadata;
            const metadata = {};
            for (const field of ['contentType', 'contentLanguage', 'contentDisposition', 'contentEncoding', 'cacheControl']) {
                if (given[field] !== undefined)
                    metadata[field] = String(given[field]);
            }
            if (given.cacheExpiry !== undefined)
                metadata.cacheExpiry = new Date(given.cacheExpiry);
            wire.httpMetadata = metadata;
        }
        if (options !== undefined) {
            const checksums = wireChecksums(options);
            if (checksums !== undefined)
                wire.checksums = checksums;
        }
        if (options?.onlyIf !== undefined)
            wire.onlyIf = wireConditional(options.onlyIf);
        // A Blob crosses as its bytes.
        const object = await this.#remote.put(String(key), value instanceof Blob ? await value.arrayBuffer() : value, wire);
        return object === null ? null : new HeadResult(object);
    }
    delete(keys) {
        return this.#remote.delete(Array.isArray(keys) ? keys.map(String) : String(keys));
    }
    async list(options) {
        const { include: given, limit: givenLimit, ...others } = options ?? {};
        // ListOptions.limit is an int to workerd.
        const limit = jsgInt(givenLimit);
        const rest = limit === undefined ? others : { ...others, limit };
        const include = [];
        for (const field of given ?? []) {
            if (field !== 'httpMetadata' && field !== 'customMetadata')
                throw new RangeError(`Unsupported include value ${field}`);
            include.push(field);
        }
        const listed = await this.#remote.list(given === undefined ? rest : { ...rest, include });
        // In the order of workerd's R2Objects struct.
        return {
            objects: listed.objects.map((object) => new HeadResult(object)),
            truncated: listed.truncated,
            ...(listed.cursor === undefined ? {} : { cursor: listed.cursor }),
            delimitedPrefixes: listed.delimitedPrefixes,
        };
    }
    async createMultipartUpload() {
        throw new Error('R2 multipart uploads are not supported under nimbus wrangler dev');
    }
    resumeMultipartUpload() {
        throw new Error('R2 multipart uploads are not supported under nimbus wrangler dev');
    }
}
named(R2Bucket, 'R2Bucket');
