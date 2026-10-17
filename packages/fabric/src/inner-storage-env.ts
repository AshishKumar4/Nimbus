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

/** The KV, D1 and R2 bindings an inner Worker's env holds, by name. */
export interface InnerStorageNames {
  kv: readonly string[];
  d1: readonly string[];
  r2: readonly string[];
}

// ── KV, as its binding forwards each call ──────────────────────────────────

export type KvJson = string | number | boolean | null | KvJson[] | { [key: string]: KvJson };

export interface KvGetOptions {
  type?: string;
  cacheTtl?: number;
}

export interface KvPutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: KvJson;
}

export interface KvListOptions {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
}

export type KvPutValue = string | ArrayBuffer | ArrayBufferView | ReadableStream;

/** One call of a KV namespace's API, its arguments as the Worker gave them. */
export type KvCall =
  | { method: 'get' | 'getWithMetadata'; key: string | string[]; options?: string | KvGetOptions }
  | { method: 'put'; key: string; value: KvPutValue; options?: KvPutOptions }
  | { method: 'delete'; key: string }
  | { method: 'list'; options?: KvListOptions };

/** The binding the loader passes for a KV namespace: KV's API, its options already converted. */
export interface KvBindingRemote {
  get(key: string | string[], options?: string | KvGetOptions): Promise<unknown>;
  getWithMetadata(key: string | string[], options?: string | KvGetOptions): Promise<unknown>;
  put(key: string, value: KvPutValue, options?: KvPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KvListOptions): Promise<unknown>;
}

// ── D1's binding contract (workerd d1-api.ts D1BindingService) ─────────────

/** A value as a statement carries it: a blob is its bytes, as numbers. */
export type D1Value = string | number | null | number[];

export interface D1QuerySql {
  sql: string;
  params?: D1Value[];
}

export interface D1QueryMeta {
  served_by: string;
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  size_after: number;
  rows_read: number;
  rows_written: number;
}

export interface D1QuerySqlResult {
  meta: D1QueryMeta;
  data: { kind: 'raw'; columns: string[]; rows: D1Value[][] };
}

/**
 * All of a request's queries, in one transaction, and the database's
 * bookmark after them; or the error that rolled them back.
 */
export type D1QueryResponse =
  | { success: true; results: { queryResults: D1QuerySqlResult[]; bookmark?: string } }
  | { success: false; error: { name: string; message: string } };

/** A request by D1's binding contract: its queries, and the bookmark (or constraint) of the session sending them. */
export interface D1QueryRequest {
  queries: D1QuerySql[];
  bookmark?: string;
}

/** The binding the loader passes for a D1 database. */
export interface D1BindingRemote {
  query(request: D1QueryRequest): Promise<D1QueryResponse>;
}

// ── R2, as the binding takes and answers it ────────────────────────────────

/** One etag of a condition, as R2 compares it (r2-bucket.c++ R2Bucket::Etag). */
export type R2EtagCondition = { type: 'wildcard' } | { type: 'strong' | 'weak'; value: string };

export interface R2WireConditional {
  etagMatches?: R2EtagCondition[];
  etagDoesNotMatch?: R2EtagCondition[];
  uploadedBefore?: Date;
  uploadedAfter?: Date;
  secondsGranularity?: boolean;
}

export interface R2WireHttpMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2WireRange {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2WireGetOptions {
  onlyIf?: R2WireConditional;
  range?: R2WireRange;
  rangeHeader?: string;
}

export type R2HashName = 'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512';

/** Each digest the object has, as lowercase hex. */
export type R2WireChecksums = Partial<Record<R2HashName, string>>;

export interface R2WirePutOptions {
  onlyIf?: R2WireConditional;
  httpMetadata?: R2WireHttpMetadata;
  customMetadata?: Record<string, string>;
  /** The one digest the caller gave, as hex, to be checked against the body. */
  checksums?: R2WireChecksums;
}

export interface R2WireListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  startAfter?: string;
  include?: ('httpMetadata' | 'customMetadata')[];
}

export type R2PutBody = string | ArrayBuffer | ArrayBufferView | ReadableStream | null;

/** An object's fields, as workerd's R2 client reads them off R2's answer. */
export interface R2WireObject {
  key: string;
  version: string;
  size: number;
  etag: string;
  /** Milliseconds since the epoch. */
  uploaded: number;
  httpMetadata?: R2WireHttpMetadata;
  customMetadata?: Record<string, string>;
  range?: { offset: number; length: number };
  checksums: R2WireChecksums;
  storageClass: string;
}

/** What a get answers: the object, and its body unless a condition failed. */
export interface R2WireGetResult {
  object: R2WireObject;
  body: ReadableStream | null;
}

export interface R2WireObjects {
  objects: R2WireObject[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

/** One call of an R2 bucket's API, its options as the adapter sends them. */
export type R2Call =
  | { method: 'head'; key: string }
  | { method: 'get'; key: string; options: R2WireGetOptions }
  | { method: 'put'; key: string; value: R2PutBody; options: R2WirePutOptions }
  | { method: 'delete'; keys: string | string[] }
  | { method: 'list'; options: R2WireListOptions };

/** The binding the loader passes for an R2 bucket. */
export interface R2BucketRemote {
  head(key: string): Promise<R2WireObject | null>;
  get(key: string, options: R2WireGetOptions): Promise<R2WireGetResult | null>;
  put(key: string, value: R2PutBody, options: R2WirePutOptions): Promise<R2WireObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: R2WireListOptions): Promise<R2WireObjects>;
}

/**
 * The adapter, as it runs in the inner isolate: it replaces each of `names`
 * in `env` that holds the binding the loader passes with the platform's
 * local object over it.
 */
export function innerStorageAdapter(names: InnerStorageNames, env: object): void {
  for (const name of names.kv) {
    const remote: unknown = Reflect.get(env, name);
    if (isRemote<KvBindingRemote>(remote, ['get', 'getWithMetadata', 'put', 'delete', 'list'])) Reflect.set(env, name, new KVNamespace(remote));
  }
  for (const name of names.d1) {
    const remote: unknown = Reflect.get(env, name);
    if (isRemote<D1BindingRemote>(remote, ['query'])) Reflect.set(env, name, new D1Database(remote));
  }
  for (const name of names.r2) {
    const remote: unknown = Reflect.get(env, name);
    if (isRemote<R2BucketRemote>(remote, ['head', 'get', 'put', 'delete', 'list'])) Reflect.set(env, name, new R2Bucket(remote));
  }
}

/** Whether `value` is the binding the loader passes, with each of `methods` (an RPC stub's methods are its properties). */
function isRemote<T extends object>(value: unknown, methods: readonly (keyof T & string)[]): value is T {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && methods.every((method) => typeof Reflect.get(value, method) === 'function');
}

/** Observable platform type names, which the compiled adapter would otherwise minify. */
function named<T extends abstract new (...args: never[]) => object>(type: T, name: string): T {
  return Object.defineProperty(type, 'name', { value: name, configurable: true });
}

// ── KV ─────────────────────────────────────────────────────────────────────

/** KV's get options as workerd's client reads them: a type string, or a type and a cacheTtl int. */
type KvGivenGetOptions = string | { type?: string | object; cacheTtl?: number | string | object };

function kvGetOptions(options: KvGivenGetOptions | undefined): string | KvGetOptions | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== 'object') return String(options);
  const out: KvGetOptions = {};
  if (options.type !== undefined) out.type = String(options.type);
  const cacheTtl = jsgInt(options.cacheTtl);
  if (cacheTtl !== undefined) out.cacheTtl = cacheTtl;
  return out;
}

/**
 * env.KV: the namespace's calls, their options converted as workerd's
 * client converts them. A conversion that fails rejects the call's promise,
 * as an argument workerd cannot convert does for a method that answers one.
 */
class KVNamespace {
  readonly #remote: KvBindingRemote;

  constructor(remote: KvBindingRemote) {
    this.#remote = remote;
  }

  async get(key: string | string[], options?: KvGivenGetOptions): Promise<unknown> {
    return await this.#remote.get(key, kvGetOptions(options));
  }

  async getWithMetadata(key: string | string[], options?: KvGivenGetOptions): Promise<unknown> {
    return await this.#remote.getWithMetadata(key, kvGetOptions(options));
  }

  async put(key: string, value: KvPutValue, options?: { expiration?: number | string | object; expirationTtl?: number | string | object; metadata?: KvJson }): Promise<void> {
    if (options === undefined) return await this.#remote.put(key, value);
    const out: KvPutOptions = {};
    const expiration = jsgInt(options.expiration);
    if (expiration !== undefined) out.expiration = expiration;
    const expirationTtl = jsgInt(options.expirationTtl);
    if (expirationTtl !== undefined) out.expirationTtl = expirationTtl;
    if (options.metadata !== undefined) out.metadata = options.metadata;
    return await this.#remote.put(key, value, out);
  }

  async delete(key: string): Promise<void> {
    return await this.#remote.delete(key);
  }

  async list(options?: { prefix?: string | null; limit?: number | string | object; cursor?: string | null }): Promise<unknown> {
    if (options === undefined) return await this.#remote.list();
    const out: KvListOptions = {};
    const limit = jsgInt(options.limit);
    if (limit !== undefined) out.limit = limit;
    if (options.prefix !== undefined && options.prefix !== null) out.prefix = String(options.prefix);
    if (options.cursor !== undefined && options.cursor !== null) out.cursor = String(options.cursor);
    return await this.#remote.list(out);
  }
}

named(KVNamespace, 'KvNamespace');

// ── D1 ─────────────────────────────────────────────────────────────────────

/** A query's answer in D1's rows-and-columns shape (d1-api mapQueryResult). */
interface D1RowsAndColumns {
  success: true;
  meta: D1QueryMeta;
  results: { columns: string[]; rows: D1Value[][] };
}

type D1Row = Record<string, D1Value>;

interface D1Result {
  success: true;
  meta: D1QueryMeta;
  results: D1Row[];
}

const D1_SESSION_CONSTRAINT_FIRST_PRIMARY = 'first-primary';
const D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED = 'first-unconstrained';

/** Thrown as d1-api throws: `<code>: <message>`, its cause the bare message unless it names another. */
function d1Error(code: string, message: string, cause = message): Error {
  return new Error(`${code}: ${message}`, { cause: new Error(cause) });
}

/** d1-api toArrayOfObjects: each row an object of its columns, a later column of a name winning. */
function rowsAsObjects(answer: D1RowsAndColumns): D1Result {
  const { columns, rows } = answer.results;
  return { ...answer, results: rows.map((row) => Object.fromEntries(row.map((cell, i) => [columns[i], cell]))) };
}

/** `queries` sent as `session` sends them: off the session's own surface. */
let sendD1: (session: D1DatabaseSession, queries: D1QuerySql[], code: string) => Promise<D1RowsAndColumns[]>;

/**
 * The session a statement runs in (d1-api D1DatabaseSession): it sends its
 * bookmark (or constraint) with each request, and keeps the latest bookmark
 * the database answers. The database's own session goes to the primary, and
 * sends and keeps none.
 */
class D1DatabaseSession {
  readonly #remote: D1BindingRemote;
  readonly #keepsBookmark: boolean;
  #bookmark: string | null;

  static {
    sendD1 = (session, queries, code) => session.#send(queries, code);
  }

  constructor(remote: D1BindingRemote, bookmarkOrConstraint: string | null) {
    this.#remote = remote;
    this.#keepsBookmark = bookmarkOrConstraint !== null;
    if (bookmarkOrConstraint === null) {
      this.#bookmark = null;
    } else {
      this.#bookmark = bookmarkOrConstraint.trim();
      if (!this.#bookmark) throw new Error('D1_SESSION_ERROR: invalid bookmark or constraint');
    }
  }

  /**
   * `queries` run in one transaction: each answer, or the failure rolling
   * them back thrown as `<code>: <message>`. A bookmark answered replaces
   * the session's only when it is later (d1-api _updateBookmark).
   */
  async #send(queries: D1QuerySql[], code: string): Promise<D1RowsAndColumns[]> {
    const response = await this.#remote.query(this.#bookmark === null ? { queries } : { queries, bookmark: this.#bookmark });
    if (!response.success) throw d1Error(code, response.error.message);
    const answered = response.results.bookmark?.trim();
    const current = this.getBookmark();
    if (this.#keepsBookmark && answered && (current === null || current.localeCompare(answered) < 0)) this.#bookmark = answered;
    return response.results.queryResults.map(({ meta, data }) => ({ success: true, meta, results: { columns: data.columns, rows: data.rows } }));
  }

  prepare(sql: string): D1PreparedStatement {
    return new D1PreparedStatement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const answers = await this.#send(statements.map(statementQuery), 'D1_ERROR');
    return answers.map(rowsAsObjects);
  }

  /** The latest bookmark the session saw; a constraint is none. The database answers none. */
  getBookmark(): string | null {
    switch (this.#bookmark) {
      case D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED:
      case D1_SESSION_CONSTRAINT_FIRST_PRIMARY:
        return null;
      default:
        return this.#bookmark;
    }
  }
}

function statementQuery(statement: D1PreparedStatement): D1QuerySql {
  return { sql: statement.statement, params: statement.params };
}

/** d1-api D1PreparedStatement.bind: what a value is sent as, or the type error it throws. */
function d1Param(value: unknown): D1Value {
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') {
    if (value === null) return null;
    if (Array.isArray(value) && value.every((b) => typeof b === 'number' && b >= 0 && b < 256)) return value;
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw d1Error('D1_TYPE_ERROR', `Type '${typeof value}' not supported for value '${String(value)}'`);
}

class D1PreparedStatement {
  readonly #session: D1DatabaseSession;
  readonly statement: string;
  readonly params: D1Value[];

  constructor(session: D1DatabaseSession, statement: string, params: D1Value[] = []) {
    this.#session = session;
    this.statement = statement;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1PreparedStatement(this.#session, this.statement, values.map(d1Param));
  }

  async first(column?: string): Promise<D1Row | D1Value | null> {
    const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
    const row = rowsAsObjects(answer).results[0];
    if (row === undefined) return null;
    if (column === undefined) return row;
    if (row[column] === undefined) throw d1Error('D1_COLUMN_NOTFOUND', `Column not found (${column})`, 'Column not found');
    return row[column];
  }

  async run(): Promise<D1Result> {
    const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
    return rowsAsObjects(answer);
  }

  async all(): Promise<D1Result> {
    const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
    return rowsAsObjects(answer);
  }

  async raw(options?: { columnNames?: boolean }): Promise<D1Value[][]> {
    const [answer] = await sendD1(this.#session, [statementQuery(this)], 'D1_ERROR');
    const { columns, rows } = answer.results;
    return options?.columnNames ? [columns, ...rows] : rows;
  }
}

/** env.DB: the database, whose own statements go to the primary (d1-api D1Database). */
class D1Database {
  readonly #remote: D1BindingRemote;
  readonly #primary: D1DatabaseSession;

  constructor(remote: D1BindingRemote) {
    this.#remote = remote;
    this.#primary = new D1DatabaseSession(remote, null);
  }

  prepare(query: string): D1PreparedStatement {
    return new D1PreparedStatement(this.#primary, query);
  }

  batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.#primary.batch(statements);
  }

  /**
   * d1-api's exec: each line of `query` a statement, all in one transaction;
   * a failure names the first line, as D1 does.
   */
  async exec(query: string): Promise<{ count: number; duration: number }> {
    const lines = query.trim().split('\n');
    const response = await this.#remote.query({ queries: lines.map((sql) => ({ sql })) });
    if (!response.success) {
      throw d1Error('D1_EXEC_ERROR', `Error in line 1: ${lines[0]}: ${response.error.message}`);
    }
    const results = response.results.queryResults;
    return { count: results.length, duration: results.reduce((total, result) => total + result.meta.duration, 0) };
  }

  withSession(constraintOrBookmark?: string): D1DatabaseSession {
    const given = constraintOrBookmark?.trim();
    return new D1DatabaseSession(this.#remote, given ? given : D1_SESSION_CONSTRAINT_FIRST_UNCONSTRAINED);
  }

  /** D1's raw query API, which the platform serves only behind an experimental flag no Worker Loader guest can set. */
  async query(): Promise<never> {
    throw new Error('D1_ERROR: D1Database.query() requires the d1_binding_jsrpc compatibility flag. Enable d1_binding_jsrpc before calling query().');
  }

  async dump(): Promise<never> {
    throw new Error('D1_DUMP_ERROR: dump() is not supported');
  }
}

named(D1Database, 'D1Database');
named(D1DatabaseSession, 'D1DatabaseSession');
named(D1PreparedStatement, 'D1PreparedStatement');

// ── R2 ─────────────────────────────────────────────────────────────────────

const HASHES: readonly { name: R2HashName; label: string; bytes: number }[] = [
  { name: 'md5', label: 'MD5', bytes: 16 },
  { name: 'sha1', label: 'SHA-1', bytes: 20 },
  { name: 'sha256', label: 'SHA-256', bytes: 32 },
  { name: 'sha384', label: 'SHA-384', bytes: 48 },
  { name: 'sha512', label: 'SHA-512', bytes: 64 },
];

function fromHex(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

/** R2Checksums: each digest the object has, as bytes, and as hex in its JSON. */
class Checksums {
  declare readonly md5?: ArrayBuffer;
  declare readonly sha1?: ArrayBuffer;
  declare readonly sha256?: ArrayBuffer;
  declare readonly sha384?: ArrayBuffer;
  declare readonly sha512?: ArrayBuffer;
  readonly #hex: R2WireChecksums;

  constructor(hex: R2WireChecksums) {
    this.#hex = hex;
    for (const { name } of [...HASHES].reverse()) {
      const digest = hex[name];
      Object.defineProperty(this, name, { value: digest === undefined ? undefined : fromHex(digest), enumerable: true });
    }
  }

  toJSON(): R2WireChecksums {
    const out: R2WireChecksums = {};
    for (const { name } of HASHES) {
      const digest = this.#hex[name];
      if (digest !== undefined) out[name] = digest;
    }
    return out;
  }
}

/** The headers an object's HTTP metadata writes, as R2's writeHttpMetadata sets them. */
function writeMetadata(key: string, metadata: R2WireHttpMetadata | undefined, headers: Headers): void {
  if (metadata === undefined) {
    throw new TypeError(`HTTP metadata unknown for key \`${key}\`. Did you forget to add 'httpMetadata' to \`include\` when listing?`);
  }
  if (metadata.contentType !== undefined) headers.set('content-type', metadata.contentType);
  if (metadata.contentLanguage !== undefined) headers.set('content-language', metadata.contentLanguage);
  if (metadata.contentDisposition !== undefined) headers.set('content-disposition', metadata.contentDisposition);
  if (metadata.contentEncoding !== undefined) headers.set('content-encoding', metadata.contentEncoding);
  if (metadata.cacheControl !== undefined) headers.set('cache-control', metadata.cacheControl);
  if (metadata.cacheExpiry !== undefined) headers.set('expires', metadata.cacheExpiry.toUTCString());
}

/**
 * R2Object (workerd's HeadResult): its fields are its own, read-only,
 * enumerable, in the order workerd defines them.
 */
class HeadResult {
  declare readonly key: string;
  declare readonly version: string;
  declare readonly size: number;
  declare readonly etag: string;
  declare readonly httpEtag: string;
  declare readonly checksums: Checksums;
  declare readonly uploaded: Date;
  declare readonly httpMetadata?: R2WireHttpMetadata;
  declare readonly customMetadata?: Record<string, string>;
  declare readonly range?: { offset: number; length: number };
  declare readonly storageClass: string;
  declare readonly ssecKeyMd5?: string;

  constructor(object: R2WireObject) {
    const fields: [string, unknown][] = [
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
    for (const [name, value] of fields) Object.defineProperty(this, name, { value, enumerable: true });
  }

  writeHttpMetadata(headers: Headers): void {
    writeMetadata(this.key, this.httpMetadata, headers);
  }
}

/** R2ObjectBody (workerd's GetResult): the object and its one-shot body. */
class GetResult extends HeadResult {
  readonly #body: Response;

  constructor(object: R2WireObject, body: ReadableStream) {
    super(object);
    this.#body = new Response(body);
  }

  get body(): ReadableStream | null { return this.#body.body; }
  get bodyUsed(): boolean { return this.#body.bodyUsed; }
  arrayBuffer(): Promise<ArrayBuffer> { return this.#body.arrayBuffer(); }
  bytes(): Promise<Uint8Array> { return this.#body.bytes(); }
  text(): Promise<string> { return this.#body.text(); }
  json(): Promise<unknown> { return this.#body.json(); }
  blob(): Promise<Blob> { return this.#body.blob(); }
}

named(Checksums, 'Checksums');
named(HeadResult, 'HeadResult');
named(GetResult, 'GetResult');

interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
  secondsGranularity?: boolean;
}

/** An If-Match / If-None-Match header's etags (r2-bucket.c++ parseConditionalEtagHeader). */
function parseEtagHeader(header: string): R2EtagCondition[] {
  const etags: R2EtagCondition[] = [];
  let rest = header;
  let commaRequired = false;
  for (;;) {
    rest = rest.replace(/^[ \t]+/, '');
    if (rest === '') return etags;
    const first = rest[0];
    if (first === ',') {
      rest = rest.slice(1);
      commaRequired = false;
    } else if (first === '*') {
      if (commaRequired) throw new Error("Comma was expected to separate etags. Encountered a wildcard character '*' instead.");
      return [{ type: 'wildcard' }];
    } else if (first === 'W') {
      if (commaRequired) {
        throw new Error("Comma was expected to separate etags. Encountered a weak quotation character 'W' instead. This would otherwise indicate the start of a new weak etag.");
      }
      if (!rest.startsWith('W/"')) throw new Error('Weak etags must start with W/ and their value must be quoted');
      rest = rest.slice(3);
      const close = rest.indexOf('"');
      if (close === -1) throw new Error('Unclosed double quote for Etag');
      etags.push({ type: 'weak', value: rest.slice(0, close) });
      rest = rest.slice(close + 1);
      commaRequired = true;
    } else if (first === '"') {
      if (commaRequired) {
        throw new Error('Comma was expected to separate etags. Encountered a double quote character \'"\' instead. This would otherwise indicate the start of a new strong etag.');
      }
      rest = rest.slice(1);
      const close = rest.indexOf('"');
      if (close === -1) throw new Error('Unclosed double quote for Etag');
      etags.push({ type: 'strong', value: rest.slice(0, close) });
      rest = rest.slice(close + 1);
      commaRequired = true;
    } else {
      return etags;
    }
  }
}

function singleEtag(value: string): R2EtagCondition[] {
  if (value.startsWith('"') && value.endsWith('"')) {
    throw new TypeError(`Conditional ETag should not be wrapped in quotes (${value}).`);
  }
  return value === '*' ? [{ type: 'wildcard' }] : [{ type: 'strong', value }];
}

/** An HTTP date header, as workerd parses one for R2. */
function headerDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${value}`);
  return date;
}

/** A conditional or its headers, as R2's client sends it (r2-bucket.c++ UnwrappedConditional). */
function wireConditional(onlyIf: R2Conditional | Headers): R2WireConditional {
  if (onlyIf instanceof Headers) {
    const out: R2WireConditional = { secondsGranularity: true };
    const ifMatch = onlyIf.get('if-match');
    if (ifMatch !== null) {
      out.etagMatches = parseEtagHeader(ifMatch);
      if (out.etagMatches.length === 0) throw new Error('Invalid ETag in if-match header');
    }
    const ifNoneMatch = onlyIf.get('if-none-match');
    if (ifNoneMatch !== null) {
      out.etagDoesNotMatch = parseEtagHeader(ifNoneMatch);
      if (out.etagDoesNotMatch.length === 0) throw new Error('Invalid ETag in if-none-match header');
    }
    const modifiedSince = onlyIf.get('if-modified-since');
    if (modifiedSince !== null) out.uploadedAfter = headerDate(modifiedSince);
    const unmodifiedSince = onlyIf.get('if-unmodified-since');
    if (unmodifiedSince !== null) out.uploadedBefore = headerDate(unmodifiedSince);
    return out;
  }
  const out: R2WireConditional = { secondsGranularity: onlyIf.secondsGranularity ?? false };
  if (onlyIf.etagMatches !== undefined) out.etagMatches = singleEtag(onlyIf.etagMatches);
  if (onlyIf.etagDoesNotMatch !== undefined) out.etagDoesNotMatch = singleEtag(onlyIf.etagDoesNotMatch);
  if (onlyIf.uploadedAfter !== undefined) out.uploadedAfter = onlyIf.uploadedAfter;
  if (onlyIf.uploadedBefore !== undefined) out.uploadedBefore = onlyIf.uploadedBefore;
  return out;
}

/** A range's numbers, checked as R2's client checks them before sending. */
function wireRange(range: R2WireRange): R2WireRange {
  const out: R2WireRange = {};
  if (range.offset !== undefined) {
    if (!(range.offset >= 0)) throw new RangeError(`Invalid range. Starting offset (${range.offset}) must be greater than or equal to 0.`);
    if (!Number.isInteger(range.offset)) throw new RangeError(`Invalid range. Starting offset (${range.offset}) must be an integer, not floating point.`);
    out.offset = range.offset;
  }
  if (range.length !== undefined) {
    if (!(range.length >= 0)) throw new RangeError(`Invalid range. Length (${range.length}) must be greater than or equal to 0.`);
    if (!Number.isInteger(range.length)) throw new RangeError(`Invalid range. Length (${range.length}) must be an integer, not floating point.`);
    out.length = range.length;
  }
  if (range.suffix !== undefined) {
    if (range.offset !== undefined) throw new TypeError('Suffix is incompatible with offset.');
    if (range.length !== undefined) throw new TypeError('Suffix is incompatible with length.');
    if (!(range.suffix >= 0)) throw new RangeError(`Invalid suffix. Suffix (${range.suffix}) must be greater than or equal to 0.`);
    if (!Number.isInteger(range.suffix)) throw new RangeError(`Invalid range. Suffix (${range.suffix}) must be an integer, not floating point.`);
    out.suffix = range.suffix;
  }
  return out;
}

/** HTTP metadata from request headers (r2-bucket.c++ HttpMetadata::fromRequestHeaders). */
function metadataFromHeaders(headers: Headers): R2WireHttpMetadata {
  const out: R2WireHttpMetadata = {};
  const contentType = headers.get('content-type');
  if (contentType !== null) out.contentType = contentType;
  const contentEncoding = headers.get('content-encoding');
  if (contentEncoding !== null) out.contentEncoding = contentEncoding;
  const contentDisposition = headers.get('content-disposition');
  if (contentDisposition !== null) out.contentDisposition = contentDisposition;
  const contentLanguage = headers.get('content-language');
  if (contentLanguage !== null) out.contentLanguage = contentLanguage;
  const cacheControl = headers.get('cache-control');
  if (cacheControl !== null) out.cacheControl = cacheControl;
  const expires = headers.get('expires');
  if (expires !== null) out.cacheExpiry = headerDate(expires);
  return out;
}

type R2Digest = ArrayBuffer | ArrayBufferView | string;

interface R2PutOptions {
  onlyIf?: R2Conditional | Headers;
  httpMetadata?: R2WireHttpMetadata | Headers;
  customMetadata?: Record<string, string>;
  md5?: R2Digest;
  sha1?: R2Digest;
  sha256?: R2Digest;
  sha384?: R2Digest;
  sha512?: R2Digest;
  storageClass?: string;
}

/** The one digest `options` gives, as hex, checked as R2's client checks it. */
function wireChecksums(options: R2PutOptions): R2WireChecksums | undefined {
  let checksums: R2WireChecksums | undefined;
  for (const { name, label, bytes } of HASHES) {
    const digest = options[name];
    if (digest === undefined) continue;
    if (checksums !== undefined) throw new TypeError('You cannot specify multiple hashing algorithms.');
    if (typeof digest === 'string') {
      if (digest.length !== bytes * 2) throw new TypeError(`${label} is ${bytes * 2} hex characters, not ${digest.length}`);
      if (!/^[0-9a-fA-F]*$/.test(digest)) throw new TypeError(`Provided ${label} wasn't a valid hex string`);
      checksums = { [name]: digest.toLowerCase() };
    } else {
      const view = digest instanceof ArrayBuffer ? new Uint8Array(digest) : new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
      if (view.byteLength !== bytes) throw new TypeError(`${label} is ${bytes} bytes, not ${view.byteLength}`);
      checksums = { [name]: bytesToHex(view) };
    }
  }
  return checksums;
}

/** env.BUCKET: the bucket, whose objects it makes from what the binding answers. */
class R2Bucket {
  readonly #remote: R2BucketRemote;

  constructor(remote: R2BucketRemote) {
    this.#remote = remote;
  }

  async head(key: string): Promise<HeadResult | null> {
    const object = await this.#remote.head(String(key));
    return object === null ? null : new HeadResult(object);
  }

  async get(key: string, options?: { onlyIf?: R2Conditional | Headers; range?: R2WireRange | Headers }): Promise<GetResult | HeadResult | null> {
    const wire: R2WireGetOptions = {};
    if (options?.onlyIf !== undefined) wire.onlyIf = wireConditional(options.onlyIf);
    if (options?.range instanceof Headers) {
      const header = options.range.get('range');
      if (header !== null) wire.rangeHeader = header;
    } else if (options?.range !== undefined) {
      wire.range = wireRange(options.range);
    }
    const answer = await this.#remote.get(String(key), wire);
    if (answer === null) return null;
    return answer.body === null ? new HeadResult(answer.object) : new GetResult(answer.object, answer.body);
  }

  async put(key: string, value: R2PutBody | Blob, options?: R2PutOptions): Promise<HeadResult | null> {
    const wire: R2WirePutOptions = {};
    // Each metadata value is a string, as workerd's Dict<kj::String> and HttpMetadata coerce them.
    if (options?.customMetadata !== undefined) {
      wire.customMetadata = Object.fromEntries(Object.entries(options.customMetadata).map(([name, field]) => [name, String(field)]));
    }
    if (options?.httpMetadata instanceof Headers) {
      wire.httpMetadata = metadataFromHeaders(options.httpMetadata);
    } else if (options?.httpMetadata !== undefined) {
      const given = options.httpMetadata;
      const metadata: R2WireHttpMetadata = {};
      for (const field of ['contentType', 'contentLanguage', 'contentDisposition', 'contentEncoding', 'cacheControl'] as const) {
        if (given[field] !== undefined) metadata[field] = String(given[field]);
      }
      if (given.cacheExpiry !== undefined) metadata.cacheExpiry = new Date(given.cacheExpiry);
      wire.httpMetadata = metadata;
    }
    if (options !== undefined) {
      const checksums = wireChecksums(options);
      if (checksums !== undefined) wire.checksums = checksums;
    }
    if (options?.onlyIf !== undefined) wire.onlyIf = wireConditional(options.onlyIf);
    // A Blob crosses as its bytes.
    const object = await this.#remote.put(String(key), value instanceof Blob ? await value.arrayBuffer() : value, wire);
    return object === null ? null : new HeadResult(object);
  }

  delete(keys: string | string[]): Promise<void> {
    return this.#remote.delete(Array.isArray(keys) ? keys.map(String) : String(keys));
  }

  async list(options?: Omit<R2WireListOptions, 'include' | 'limit'> & { include?: string[]; limit?: number | string }): Promise<{ objects: HeadResult[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[] }> {
    const { include: given, limit: givenLimit, ...others } = options ?? {};
    // ListOptions.limit is an int to workerd.
    const limit = jsgInt(givenLimit);
    const rest: R2WireListOptions = limit === undefined ? others : { ...others, limit };
    const include: NonNullable<R2WireListOptions['include']> = [];
    for (const field of given ?? []) {
      if (field !== 'httpMetadata' && field !== 'customMetadata') throw new RangeError(`Unsupported include value ${field}`);
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

  async createMultipartUpload(): Promise<never> {
    throw new Error('R2 multipart uploads are not supported under nimbus wrangler dev');
  }

  resumeMultipartUpload(): never {
    throw new Error('R2 multipart uploads are not supported under nimbus wrangler dev');
  }
}

named(R2Bucket, 'R2Bucket');
