#!/usr/bin/env bun
// inner-storage-env — a `wrangler dev` Worker's env.DB and env.BUCKET are
// local objects of the platform's shape over the bindings the loader
// passes, as the build-time expression the adapter module runs makes them:
//
//   - a name whose binding is absent is left alone, and env.KV is not touched;
//   - D1: prepare and bind answer at once; bind converts a value as workerd's
//     D1 client does or throws its D1_TYPE_ERROR; first, all, run and raw
//     shape the binding's rows and columns; batch sends its statements as
//     one request; exec sends each line as a statement and names the first
//     line when one fails; a failure is D1_ERROR with the bare message its
//     cause; query is refused as without d1_binding_jsrpc;
//   - D1: a session sends its bookmark with each query and keeps the latest
//     bookmark the database answers, a later one only (as d1-api's
//     _updateBookmark); the database's own statements keep none;
//   - R2: an object's fields are its own, read-only, in workerd's order, its
//     class workerd's; a body reads once; a condition and a range are sent
//     as R2's client sends them, metadata values as strings (workerd's
//     Dict<kj::String>), a list limit as the int workerd converts it to, and
//     a range, etag or include it refuses is refused before the binding is
//     asked.
//
// The live differential is wrangler-dev-storage-bindings-workerd.

import assert from 'node:assert/strict';

const { INNER_STORAGE_ADAPTER_SOURCE } = await import('../../packages/fabric/src/compiled-bodies.generated.ts');
const { innerStorageAdapter } = (0, eval)(INNER_STORAGE_ADAPTER_SOURCE);

const meta = { served_by: 'test', duration: 1, changes: 0, last_row_id: 0, changed_db: false, size_after: 4096, rows_read: 1, rows_written: 0 };
const sent = [];
// The bookmark the database answers next.
let bookmark = '00000002-00000000-00000000-aa';
const d1Remote = {
  async query(request) {
    sent.push(request);
    if (request.queries.some((q) => q.sql.includes('missing'))) return { success: false, error: { name: 'Error', message: 'no such table: missing: SQLITE_ERROR' } };
    return { success: true, results: { bookmark, queryResults: request.queries.map(() => ({ meta, data: { kind: 'raw', columns: ['x', 'y', 'x'], rows: [[1, 'a', 2], [3, 'b', 4]] } })) } };
  },
};
const asked = [];
const object = { key: 'k', version: 'v'.repeat(32), size: 5, etag: 'e1', uploaded: 1_000, httpMetadata: { contentType: 'text/plain' }, customMetadata: {}, range: { offset: 0, length: 5 }, checksums: { md5: '00ff' }, storageClass: '' };
const r2Remote = {
  async head(key) { asked.push(['head', key]); return object; },
  async get(key, options) { asked.push(['get', key, options]); return { object, body: new Response('hello').body }; },
  async put(key, value, options) { asked.push(['put', key, value, options]); return { ...object, range: undefined }; },
  async delete(keys) { asked.push(['delete', keys]); },
  async list(options) { asked.push(['list', options]); return { objects: [object], truncated: false, delimitedPrefixes: [] }; },
};
const kv = { get() {} };
const env = { DB: d1Remote, BUCKET: r2Remote, KV: kv };
innerStorageAdapter({ d1: ['DB', 'ABSENT'], r2: ['BUCKET'] }, env);
assert.equal(env.KV, kv, 'a KV binding is the binding');
assert.equal('ABSENT' in env, false, 'a name the env has no binding for is left alone');
assert.equal(env.DB.constructor.name, 'D1Database');
assert.equal(env.BUCKET.constructor.name, 'R2Bucket');

// ── D1 ─────────────────────────────────────────────────────────────────────
const DB = env.DB;
const statement = DB.prepare('SELECT ?').bind(true, false, null, 'a', 2, new Uint8Array([1, 2]), new Uint8Array([3]).buffer, [4, 5]);
assert.equal(statement.constructor.name, 'D1PreparedStatement');
assert.deepEqual([statement.statement, statement.params], ['SELECT ?', [1, 0, null, 'a', 2, [1, 2], [3], [4, 5]]]);
for (const [value, type] of [[undefined, 'undefined'], [{}, 'object'], [1n, 'bigint'], [[256], 'object']]) {
  assert.throws(() => DB.prepare('SELECT ?').bind(value), (error) => error.message === `D1_TYPE_ERROR: Type '${type}' not supported for value '${String(value)}'`
    && error.cause.message === `Type '${type}' not supported for value '${String(value)}'`);
}
assert.deepEqual(await DB.prepare('SELECT 1').first(), { x: 2, y: 'a' }, 'a later column of a name wins');
assert.equal(await DB.prepare('SELECT 1').first('y'), 'a');
await assert.rejects(DB.prepare('SELECT 1').first('z'), (error) => error.message === 'D1_COLUMN_NOTFOUND: Column not found (z)' && error.cause.message === 'Column not found');
assert.deepEqual(await DB.prepare('SELECT 1').all(), { success: true, meta, results: [{ x: 2, y: 'a' }, { x: 4, y: 'b' }] });
assert.deepEqual(await DB.prepare('SELECT 1').run(), { success: true, meta, results: [{ x: 2, y: 'a' }, { x: 4, y: 'b' }] });
assert.deepEqual(await DB.prepare('SELECT 1').raw(), [[1, 'a', 2], [3, 'b', 4]]);
assert.deepEqual(await DB.prepare('SELECT 1').raw({ columnNames: true }), [['x', 'y', 'x'], [1, 'a', 2], [3, 'b', 4]]);
await assert.rejects(DB.prepare('SELECT * FROM missing').all(), (error) => error.message === 'D1_ERROR: no such table: missing: SQLITE_ERROR'
  && error.cause.message === 'no such table: missing: SQLITE_ERROR');
sent.length = 0;
assert.equal((await DB.batch([DB.prepare('A').bind(1), DB.prepare('B')])).length, 2);
assert.deepEqual(sent, [{ queries: [{ sql: 'A', params: [1] }, { sql: 'B', params: [] }] }], 'a batch is one request');
sent.length = 0;
assert.deepEqual(await DB.exec('  CREATE TABLE t (x);\nINSERT INTO t VALUES (1)\n'), { count: 2, duration: 2 });
assert.deepEqual(sent, [{ queries: [{ sql: 'CREATE TABLE t (x);' }, { sql: 'INSERT INTO t VALUES (1)' }] }], 'exec sends each line of the trimmed query');
await assert.rejects(DB.exec('INSERT INTO t VALUES (2)\nSELECT * FROM missing'), {
  message: 'D1_EXEC_ERROR: Error in line 1: INSERT INTO t VALUES (2): no such table: missing: SQLITE_ERROR',
});
await assert.rejects(DB.query({ queries: [] }), { message: /^D1_ERROR: D1Database\.query\(\) requires the d1_binding_jsrpc compatibility flag/ });
const session = DB.withSession('first-primary');
assert.equal(session.getBookmark(), null);
sent.length = 0;
assert.deepEqual(await session.prepare('SELECT 1').first(), { x: 2, y: 'a' });
assert.equal(sent[0].bookmark, 'first-primary', 'a session sends its constraint');
assert.equal(session.getBookmark(), '00000002-00000000-00000000-aa', 'and keeps the bookmark the database answered');
bookmark = '00000001-00000000-00000000-ff';
await session.batch([session.prepare('SELECT 1')]);
assert.equal(session.getBookmark(), '00000002-00000000-00000000-aa', 'an earlier bookmark does not replace it');
bookmark = '00000003-00000000-00000000-00';
await session.prepare('SELECT 1').run();
assert.equal(sent.at(-1).bookmark, '00000002-00000000-00000000-aa', 'its bookmark rides each later query');
assert.equal(session.getBookmark(), '00000003-00000000-00000000-00', 'a later one does');
assert.equal(DB.withSession('00000009-x').getBookmark(), '00000009-x', 'a session begun at a bookmark has it');
await DB.prepare('SELECT 1').first();
assert.equal(sent.at(-1).bookmark, undefined, "the database's own statements send none");

// ── R2 ─────────────────────────────────────────────────────────────────────
const BUCKET = env.BUCKET;
const head = await BUCKET.head('k');
assert.equal(head.constructor.name, 'HeadResult');
assert.deepEqual(Object.keys(head), ['ssecKeyMd5', 'storageClass', 'range', 'customMetadata', 'httpMetadata', 'uploaded', 'checksums', 'httpEtag', 'etag', 'size', 'version', 'key']);
assert.equal(head.httpEtag, '"e1"');
assert.equal(head.uploaded.getTime(), 1_000);
assert.deepEqual(head.checksums.toJSON(), { md5: '00ff' });
assert.deepEqual([...new Uint8Array(head.checksums.md5)], [0, 255]);
assert.equal('body' in head, false);
assert.throws(() => { head.key = 'other'; }, TypeError, 'a field is read-only');
const headers = new Headers();
head.writeHttpMetadata(headers);
assert.deepEqual([...headers], [['content-type', 'text/plain']]);

const body = await BUCKET.get('k', { range: { offset: 1, length: 2 }, onlyIf: { etagMatches: 'e1', uploadedBefore: new Date(5_000) } });
assert.equal(body.constructor.name, 'GetResult');
assert.equal(body.bodyUsed, false);
assert.equal(await body.text(), 'hello');
assert.equal(body.bodyUsed, true);
await assert.rejects(body.text(), TypeError, 'a body reads once');
assert.deepEqual(asked.at(-1), ['get', 'k', {
  onlyIf: { secondsGranularity: false, etagMatches: [{ type: 'strong', value: 'e1' }], uploadedBefore: new Date(5_000) },
  range: { offset: 1, length: 2 },
}]);
await BUCKET.get('k', { onlyIf: new Headers({ 'if-none-match': 'W/"a", "b"', 'if-match': '*' }), range: new Headers({ range: 'bytes=0-1' }) });
assert.deepEqual(asked.at(-1)[2], {
  onlyIf: { secondsGranularity: true, etagMatches: [{ type: 'wildcard' }], etagDoesNotMatch: [{ type: 'weak', value: 'a' }, { type: 'strong', value: 'b' }] },
  rangeHeader: 'bytes=0-1',
});
const refusedBefore = asked.length;
await assert.rejects(BUCKET.get('k', { range: { offset: -1 } }), { name: 'RangeError', message: 'Invalid range. Starting offset (-1) must be greater than or equal to 0.' });
await assert.rejects(BUCKET.get('k', { range: { suffix: 1, length: 1 } }), { name: 'TypeError', message: 'Suffix is incompatible with length.' });
await assert.rejects(BUCKET.get('k', { onlyIf: { etagMatches: '"e1"' } }), { name: 'TypeError', message: 'Conditional ETag should not be wrapped in quotes ("e1").' });
await assert.rejects(BUCKET.put('k', 'v', { md5: 'abc' }), { name: 'TypeError', message: 'MD5 is 32 hex characters, not 3' });
await assert.rejects(BUCKET.put('k', 'v', { md5: new Uint8Array(16), sha1: new Uint8Array(20) }), { message: 'You cannot specify multiple hashing algorithms.' });
assert.equal(asked.length, refusedBefore, 'what the client refuses never reaches the binding');

await BUCKET.put('k', 'v', { customMetadata: { count: 1, flag: true }, httpMetadata: { contentType: 1, cacheExpiry: new Date(5_000) } });
assert.deepEqual(asked.at(-1)[3], { customMetadata: { count: '1', flag: 'true' }, httpMetadata: { contentType: '1', cacheExpiry: new Date(5_000) } },
  'metadata values cross as strings, as workerd coerces them');
for (const [limit, sent] of [[1.5, 1], ['2', 2], [NaN, 0], [undefined, undefined]]) {
  await BUCKET.list(limit === undefined ? {} : { limit });
  assert.equal(asked.at(-1)[1].limit, sent, `a list limit of ${String(limit)} is sent as workerd's int (${String(sent)})`);
}
await assert.rejects(BUCKET.list({ limit: 2 ** 31 }), { name: 'TypeError', message: 'Value out of range. Must be between -2147483648 and 2147483647 (inclusive).' });
const bogus = asked.length;
await assert.rejects(BUCKET.list({ include: ['bogus'] }), { name: 'RangeError', message: 'Unsupported include value bogus' });
assert.equal(asked.length, bogus, 'an include R2 does not have is refused before the binding is asked');
const put = await BUCKET.put('k', new Blob(['blob']), { md5: new Uint8Array(16).fill(255), httpMetadata: new Headers({ 'content-type': 'text/html', expires: 'Thu, 01 Jan 1970 00:00:10 GMT' }) });
assert.equal(put.range, undefined);
const [, , value, options] = asked.at(-1);
assert.ok(value instanceof ArrayBuffer, 'a Blob crosses as its bytes');
assert.deepEqual(options, { httpMetadata: { contentType: 'text/html', cacheExpiry: new Date(10_000) }, checksums: { md5: 'ff'.repeat(16) } });
const listed = await BUCKET.list({ prefix: 'k' });
assert.deepEqual(Object.keys(listed), ['objects', 'truncated', 'delimitedPrefixes'], 'no cursor when the listing is complete');
assert.equal(listed.objects[0].constructor.name, 'HeadResult');
await BUCKET.delete(['a', 'b']);
assert.deepEqual(asked.at(-1), ['delete', ['a', 'b']]);
await assert.rejects(BUCKET.createMultipartUpload('k'), /not supported/);

console.log('inner-storage-env: env.DB and env.BUCKET are the platform\'s API over the bindings');
