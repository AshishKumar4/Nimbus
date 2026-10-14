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
/** The KV, D1 and R2 bindings an inner Worker's env holds, by name. */
export interface InnerStorageNames {
    kv: readonly string[];
    d1: readonly string[];
    r2: readonly string[];
}
export type KvJson = string | number | boolean | null | KvJson[] | {
    [key: string]: KvJson;
};
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
export type KvCall = {
    method: 'get' | 'getWithMetadata';
    key: string | string[];
    options?: string | KvGetOptions;
} | {
    method: 'put';
    key: string;
    value: KvPutValue;
    options?: KvPutOptions;
} | {
    method: 'delete';
    key: string;
} | {
    method: 'list';
    options?: KvListOptions;
};
/** The binding the loader passes for a KV namespace: KV's API, its options already converted. */
export interface KvBindingRemote {
    get(key: string | string[], options?: string | KvGetOptions): Promise<unknown>;
    getWithMetadata(key: string | string[], options?: string | KvGetOptions): Promise<unknown>;
    put(key: string, value: KvPutValue, options?: KvPutOptions): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: KvListOptions): Promise<unknown>;
}
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
    data: {
        kind: 'raw';
        columns: string[];
        rows: D1Value[][];
    };
}
/**
 * All of a request's queries, in one transaction, and the database's
 * bookmark after them; or the error that rolled them back.
 */
export type D1QueryResponse = {
    success: true;
    results: {
        queryResults: D1QuerySqlResult[];
        bookmark?: string;
    };
} | {
    success: false;
    error: {
        name: string;
        message: string;
    };
};
/** A request by D1's binding contract: its queries, and the bookmark (or constraint) of the session sending them. */
export interface D1QueryRequest {
    queries: D1QuerySql[];
    bookmark?: string;
}
/** The binding the loader passes for a D1 database. */
export interface D1BindingRemote {
    query(request: D1QueryRequest): Promise<D1QueryResponse>;
}
/** One etag of a condition, as R2 compares it (r2-bucket.c++ R2Bucket::Etag). */
export type R2EtagCondition = {
    type: 'wildcard';
} | {
    type: 'strong' | 'weak';
    value: string;
};
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
    range?: {
        offset: number;
        length: number;
    };
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
export type R2Call = {
    method: 'head';
    key: string;
} | {
    method: 'get';
    key: string;
    options: R2WireGetOptions;
} | {
    method: 'put';
    key: string;
    value: R2PutBody;
    options: R2WirePutOptions;
} | {
    method: 'delete';
    keys: string | string[];
} | {
    method: 'list';
    options: R2WireListOptions;
};
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
export declare function innerStorageAdapter(names: InnerStorageNames, env: object): void;
//# sourceMappingURL=inner-storage-env.d.ts.map