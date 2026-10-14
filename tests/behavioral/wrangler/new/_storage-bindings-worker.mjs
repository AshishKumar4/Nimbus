// The Worker both storage-binding checks run under `wrangler dev` (the
// local-workerd unit test and the live behavioral probe), and what it answers
// on Cloudflare. tests/unit/wrangler-dev-storage-bindings-workerd.mjs runs the
// same source with real local KV, D1 and R2 bindings (Miniflare, which is
// what `wrangler dev` gives a Worker on a workstation) and checks it answers
// exactly these, so they are Cloudflare's answers, not ones written down.

export const WRANGLER_CONFIG = {
  name: 'storage-bindings',
  main: 'src/index.js',
  compatibility_date: '2026-09-26',
  kv_namespaces: [{ binding: 'KV', id: 'kv-local' }],
  d1_databases: [{ binding: 'DB', database_name: 'db', database_id: 'db-local' }],
  r2_buckets: [{ binding: 'BUCKET', bucket_name: 'bucket' }],
};

/**
 * Step 1 calls each API's main methods on empty stores; step 2, a later
 * request, reads what step 1 left. Every answer is a value or an error's
 * name, message and cause; what differs from run to run (a duration, an
 * upload time, an R2 version, a D1 bookmark) is answered as its shape. A
 * stream past KV's limit is refused with the length read so far, which a
 * store that drains it (Miniflare) and one that cancels it once past the
 * limit (Nimbus) read to different points, so that length is answered as
 * whether it is past the limit.
 */
export const WORKER = String.raw`
const enc = new TextEncoder();
const bytes = (buffer) => Array.from(new Uint8Array(buffer));
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const text = (stream) => new Response(stream).text();
/** A stream of \`count\` pieces of 64 KiB, made as they are asked for. */
function pieces(count) {
  let made = 0;
  return new ReadableStream({
    pull(controller) {
      if (made === count) { controller.close(); return; }
      controller.enqueue(new Uint8Array(65536).fill(made++ & 255));
    },
  }, { highWaterMark: 0 });
}

function failure(error) {
  const out = { name: error && error.name, message: error && error.message };
  if (error && error.cause instanceof Error) out.cause = error.cause.message;
  return out;
}
async function attempt(run) {
  try { return { value: await run() }; } catch (error) { return { error: failure(error) }; }
}

// ── KV ──────────────────────────────────────────────────────────────────
async function kv(KV) {
  const out = {};
  out.putGet = await attempt(async () => { await KV.put('a', 'alpha'); return await KV.get('a'); });
  out.missing = await attempt(() => KV.get('missing'));
  out.json = await attempt(async () => {
    await KV.put('json', JSON.stringify({ x: 1, y: [true, null] }));
    return [await KV.get('json', 'json'), await KV.get('json', { type: 'json' }), await KV.get('json', { type: 'text' })];
  });
  out.arrayBuffer = await attempt(async () => {
    await KV.put('bin', new Uint8Array([0, 1, 255]));
    const value = await KV.get('bin', 'arrayBuffer');
    return [value instanceof ArrayBuffer, bytes(value)];
  });
  out.stream = await attempt(async () => {
    const value = await KV.get('a', { type: 'stream' });
    return [value instanceof ReadableStream, await text(value)];
  });
  out.putStream = await attempt(async () => { await KV.put('streamed', new Response('from a stream').body); return await KV.get('streamed'); });
  out.putBuffer = await attempt(async () => { await KV.put('buffer', enc.encode('buffer').buffer); return await KV.get('buffer'); });
  out.metadata = await attempt(async () => {
    await KV.put('meta', 'with metadata', { metadata: { m: 1, s: 'x' }, expiration: 2000000000 });
    return await KV.getWithMetadata('meta');
  });
  out.metadataJson = await attempt(() => KV.getWithMetadata('json', 'json'));
  out.metadataNone = await attempt(() => KV.getWithMetadata('a'));
  out.metadataMissing = await attempt(() => KV.getWithMetadata('missing'));
  out.overwrite = await attempt(async () => {
    await KV.put('meta2', 'v', { metadata: { k: 1 } });
    await KV.put('meta2', 'w');
    return await KV.getWithMetadata('meta2');
  });
  out.ttl = await attempt(async () => {
    await KV.put('ttl', 'expiring', { expirationTtl: 3600 });
    const listed = (await KV.list({ prefix: 'ttl' })).keys;
    const answer = [await KV.get('ttl'), listed.length, Math.abs(listed[0].expiration - (Math.floor(Date.now() / 1000) + 3600)) <= 5];
    await KV.delete('ttl');
    return answer;
  });
  for (const key of ['p/1', 'p/2', 'p/3']) await KV.put(key, key, { metadata: { key } });
  out.list = await attempt(() => KV.list());
  out.listPages = await attempt(async () => {
    const first = await KV.list({ prefix: 'p/', limit: 2 });
    return [first, await KV.list({ prefix: 'p/', cursor: first.cursor })];
  });
  out.bulk = await attempt(async () => {
    const values = await KV.get(['a', 'json', 'missing']);
    return [values instanceof Map, Array.from(values)];
  });
  out.bulkJson = await attempt(async () => Array.from(await KV.get(['json', 'missing'], 'json')));
  out.bulkMetadata = await attempt(async () => Array.from(await KV.getWithMetadata(['meta', 'a'])));
  out.delete = await attempt(async () => [await KV.delete('a'), await KV.get('a'), await KV.delete('never-stored')]);
  out.bulkJsonNull = await attempt(async () => {
    await KV.put('jnull', 'null', { metadata: { m: 1 } });
    return Array.from(await KV.getWithMetadata(['jnull', 'missing'], 'json'));
  });
  out.limitsCoerced = await attempt(async () => [
    (await KV.list({ prefix: 'p/', limit: '2' })).keys.length,
    (await KV.list({ prefix: 'p/', limit: 1.9 })).keys.length,
    (await KV.list({ prefix: 'p/', limit: NaN })).keys.length,
  ]);
  out.ttlNaN = await attempt(() => KV.put('t3', 'x', { expirationTtl: NaN }));
  out.limitBigInt = {
    direct: await attempt(() => KV.list({ prefix: 'p/', limit: 1n })),
    valueOf: await attempt(() => KV.list({ prefix: 'p/', limit: { valueOf: () => 1n } })),
    numberValueOf: await attempt(async () => (await KV.list({ prefix: 'p/', limit: { valueOf: () => 2 } })).keys.length),
  };
  out.listLimitNotPositive = await attempt(async () => [(await KV.list({ prefix: 'p/', limit: 0 })).keys.length, (await KV.list({ prefix: 'p/', limit: -1 })).keys.length]);
  out.bigStream = await attempt(async () => {
    const refused = await attempt(() => KV.put('big', pieces(1024)));
    const length = Number(/length of (\d+)/.exec(refused.error?.message ?? '')?.[1]);
    return {
      name: refused.error?.name,
      message: refused.error?.message.replace(/length of \d+/, 'length of N'),
      pastLimit: length > 26214400,
      stored: await KV.get('big'),
    };
  });
  out.errors = {
    emptyKey: await attempt(() => KV.get('')),
    dotKey: await attempt(() => KV.put('..', 'x')),
    longKey: await attempt(() => KV.get('k'.repeat(513))),
    shortTtl: await attempt(() => KV.put('t', 'x', { expirationTtl: 30 })),
    pastExpiration: await attempt(() => KV.put('t', 'x', { expiration: 1000 })),
    int32Expiration: await attempt(() => KV.put('t', 'x', { expiration: 4102444800 })),
    shortCacheTtl: await attempt(() => KV.get('json', { cacheTtl: 10 })),
    bulkType: await attempt(() => KV.get(['json'], 'arrayBuffer')),
    bulkNotJson: await attempt(() => KV.get(['streamed'], 'json')),
    listLimit: await attempt(() => KV.list({ limit: 1001 })),
    numberValue: await attempt(async () => { await KV.put('t', 123); return await KV.get('t'); }),
    objectValue: await attempt(() => KV.put('t2', { a: 1 })),
    missingBadType: await attempt(() => KV.get('missing', 'nonsense')),
    badType: await attempt(() => KV.get('json', 'nonsense')),
    notJson: await attempt(() => KV.get('streamed', 'json')),
  };
  return out;
}

// ── D1 ──────────────────────────────────────────────────────────────────
async function d1(DB) {
  const servedBy = new Set();
  const meta = (m) => {
    servedBy.add(m.served_by);
    const shaped = { ...m, duration: typeof m.duration, size_after: typeof m.size_after };
    delete shaped.served_by;
    return { keys: Object.keys(m).sort(), ...shaped };
  };
  const result = (r) => ({ ...r, meta: meta(r.meta) });
  const out = {};
  out.execCreate = await attempt(async () => {
    const r = await DB.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, active INTEGER, data BLOB)');
    return { count: r.count, duration: typeof r.duration };
  });
  out.execLines = await attempt(async () => (await DB.exec("CREATE TABLE tags (name TEXT);\nINSERT INTO tags VALUES ('a');\n\n  INSERT INTO tags VALUES ('b');\n")).count);
  out.runInsert = await attempt(async () => result(await DB.prepare('INSERT INTO people (name, score, active, data) VALUES (?, ?, ?, ?)').bind('alice', 1.5, true, new Uint8Array([1, 2, 3])).run()));
  out.runInsertBuffer = await attempt(async () => result(await DB.prepare('INSERT INTO people (name, score, active, data) VALUES (?, ?, ?, ?)').bind('bob', null, false, new Uint8Array([9]).buffer).run()));
  out.runInsertArray = await attempt(async () => result(await DB.prepare('INSERT INTO people (name, data) VALUES (?, ?)').bind('carol', [7, 8]).run()));
  out.all = await attempt(async () => result(await DB.prepare('SELECT * FROM people ORDER BY id').all()));
  out.runSelect = await attempt(async () => result(await DB.prepare('SELECT name FROM people ORDER BY id').run()));
  out.update = await attempt(async () => result(await DB.prepare('UPDATE people SET score = score + 1 WHERE score IS NOT NULL').run()));
  out.first = await attempt(() => DB.prepare('SELECT name, score FROM people WHERE id = ?').bind(1).first());
  out.firstColumn = await attempt(() => DB.prepare('SELECT name FROM people WHERE id = ?1').bind(2).first('name'));
  out.firstMissingColumn = await attempt(() => DB.prepare('SELECT name FROM people').first('nope'));
  out.firstNone = await attempt(() => DB.prepare('SELECT * FROM people WHERE id = 99').first());
  out.raw = await attempt(() => DB.prepare('SELECT id, name, data FROM people ORDER BY id').raw());
  out.rawColumns = await attempt(() => DB.prepare('SELECT id, name FROM people ORDER BY id').raw({ columnNames: true }));
  out.rawNone = await attempt(() => DB.prepare('SELECT id FROM people WHERE id = 99').raw({ columnNames: true }));
  out.duplicateColumns = await attempt(async () => [
    await DB.prepare('SELECT 1 AS x, 2 AS x').first(),
    await DB.prepare('SELECT 1 AS x, 2 AS x').raw({ columnNames: true }),
  ]);
  out.numbered = await attempt(() => DB.prepare('SELECT ?2 AS b, ?1 AS a').bind('x', 'y').first());
  out.types = await attempt(() => DB.prepare('SELECT typeof(?) AS i, typeof(?) AS r, typeof(?) AS t, typeof(?) AS n, typeof(?) AS b, ? AS big').bind(1, 1.5, 's', null, new Uint8Array([0]), 2 ** 53).first());
  out.batch = await attempt(async () => (await DB.batch([
    DB.prepare('INSERT INTO tags VALUES (?)').bind('c'),
    DB.prepare('UPDATE tags SET name = upper(name) WHERE name = ?').bind('a'),
    DB.prepare('SELECT name FROM tags ORDER BY name'),
  ])).map(result));
  out.batchRollback = await attempt(async () => {
    const before = await DB.prepare('SELECT count(*) AS n FROM tags').first('n');
    const error = await attempt(() => DB.batch([DB.prepare("INSERT INTO tags VALUES ('d')"), DB.prepare('INSERT INTO missing VALUES (1)')]));
    return { before, error, after: await DB.prepare('SELECT count(*) AS n FROM tags').first('n') };
  });
  out.statement = await attempt(() => {
    const statement = DB.prepare('SELECT ?, ?').bind(true, new Uint8Array([4]));
    return { statement: statement.statement, params: statement.params };
  });
  out.session = await attempt(async () => {
    const session = DB.withSession('first-primary');
    const before = session.getBookmark();
    const row = await session.prepare('SELECT 1 AS one').first();
    const first = session.getBookmark();
    const batch = (await session.batch([session.prepare('SELECT 2 AS two')])).map((r) => r.results);
    const second = session.getBookmark();
    return { before, row, batch, bookmark: String(first).replace(/[0-9a-f]/g, 'x'), later: typeof second === 'string' && second.localeCompare(first) >= 0 };
  });
  out.errors = {
    noTable: await attempt(() => DB.prepare('SELECT * FROM missing').all()),
    syntax: await attempt(() => DB.prepare('SELEC 1').run()),
    constraint: await attempt(() => DB.prepare('INSERT INTO people (name) VALUES (NULL)').run()),
    rawNoTable: await attempt(() => DB.prepare('SELECT * FROM missing').raw()),
    firstNoTable: await attempt(() => DB.prepare('SELECT * FROM missing').first()),
    bindUndefined: await attempt(() => DB.prepare('SELECT ?').bind(undefined)),
    bindObject: await attempt(() => DB.prepare('SELECT ?').bind({ a: 1 })),
    bindBigint: await attempt(() => DB.prepare('SELECT ?').bind(1n)),
    empty: await attempt(() => DB.prepare('').all()),
    comment: await attempt(() => DB.prepare('  -- nothing').all()),
    twoStatements: await attempt(async () => result(await DB.prepare('SELECT 1; SELECT 2').all())),
    exec: await attempt(() => DB.exec('SELECT * FROM missing')),
    execSecondLine: await attempt(() => DB.exec("INSERT INTO tags VALUES ('e')\nINSERT INTO missing VALUES (1)")),
    execMultiline: await attempt(() => DB.exec('CREATE TABLE broken (\n  x INTEGER\n)')),
    query: await attempt(() => DB.query({ queries: [{ sql: 'SELECT 1' }] })),
  };
  out.afterErrors = await attempt(() => DB.prepare("SELECT count(*) AS n FROM tags WHERE name = 'e'").first('n'));
  out.servedBy = Array.from(servedBy);
  return out;
}

// ── R2 ──────────────────────────────────────────────────────────────────
function object(o) {
  if (o === null || o === undefined) return o;
  return {
    class: o.constructor && o.constructor.name,
    keys: Object.keys(o),
    key: o.key,
    size: o.size,
    etag: o.etag,
    httpEtag: o.httpEtag,
    version: typeof o.version === 'string' && /^[0-9a-f]{32}$/.test(o.version),
    uploaded: o.uploaded instanceof Date && Math.abs(Date.now() - o.uploaded.getTime()) < 600000,
    httpMetadata: o.httpMetadata,
    customMetadata: o.customMetadata,
    range: o.range,
    checksums: o.checksums && o.checksums.toJSON(),
    md5: o.checksums && o.checksums.md5 instanceof ArrayBuffer ? hex(o.checksums.md5) : null,
    storageClass: o.storageClass,
    ssecKeyMd5: o.ssecKeyMd5,
    body: 'body' in o,
    writeHttpMetadata: typeof o.writeHttpMetadata,
  };
}

async function r2(BUCKET) {
  const out = {};
  out.put = await attempt(async () => object(await BUCKET.put('hello.txt', 'Hello, R2', {
    httpMetadata: { contentType: 'text/plain', cacheControl: 'no-cache' },
    customMetadata: { owner: 'test' },
  })));
  out.head = await attempt(async () => object(await BUCKET.head('hello.txt')));
  out.headMissing = await attempt(() => BUCKET.head('missing'));
  out.get = await attempt(async () => {
    const o = await BUCKET.get('hello.txt');
    const before = o.bodyUsed;
    const stream = o.body instanceof ReadableStream;
    return { ...object(o), before, stream, text: await o.text(), after: o.bodyUsed };
  });
  out.getMissing = await attempt(() => BUCKET.get('missing'));
  out.bodies = await attempt(async () => {
    await BUCKET.put('data.json', JSON.stringify({ a: [1, 2] }));
    const fresh = () => BUCKET.get('data.json');
    const blob = await (await fresh()).blob();
    const view = await (await fresh()).bytes();
    return {
      json: await (await fresh()).json(),
      arrayBuffer: bytes(await (await fresh()).arrayBuffer()),
      bytes: [view instanceof Uint8Array, view.length],
      blob: [blob instanceof Blob, blob.size, await blob.text()],
      stream: await text((await fresh()).body),
      twice: await attempt(async () => { const o = await fresh(); await o.text(); return await o.text(); }),
    };
  });
  out.writeHttpMetadata = await attempt(async () => {
    const headers = new Headers();
    (await BUCKET.head('hello.txt')).writeHttpMetadata(headers);
    return Array.from(headers);
  });
  out.ranges = await attempt(async () => {
    const read = async (range) => { const o = await BUCKET.get('hello.txt', { range }); return [o.range, await o.text()]; };
    return {
      offsetLength: await read({ offset: 1, length: 4 }),
      offset: await read({ offset: 7 }),
      length: await read({ length: 5 }),
      suffix: await read({ suffix: 2 }),
      longSuffix: await read({ suffix: 100 }),
      header: await read(new Headers({ range: 'bytes=0-4' })),
    };
  });
  out.rangeErrors = {
    negative: await attempt(() => BUCKET.get('hello.txt', { range: { offset: -1 } })),
    fraction: await attempt(() => BUCKET.get('hello.txt', { range: { offset: 1.5 } })),
    suffixAndOffset: await attempt(() => BUCKET.get('hello.txt', { range: { offset: 1, suffix: 1 } })),
    beyond: await attempt(() => BUCKET.get('hello.txt', { range: { offset: 100 } })),
  };
  out.conditionals = await attempt(async () => {
    const { etag, uploaded } = await BUCKET.head('hello.txt');
    const read = async (onlyIf) => {
      const o = await BUCKET.get('hello.txt', { onlyIf });
      return o === null ? null : { class: o.constructor.name, body: 'body' in o, range: o.range };
    };
    return {
      matches: await read({ etagMatches: etag }),
      doesNotMatch: await read({ etagDoesNotMatch: etag }),
      wrongMatch: await read({ etagMatches: 'nope' }),
      wildcard: await read({ etagMatches: '*' }),
      uploadedBefore: await read({ uploadedBefore: new Date(uploaded.getTime() - 60000) }),
      uploadedAfter: await read({ uploadedAfter: new Date(uploaded.getTime() - 60000) }),
      headers: await read(new Headers({ 'if-none-match': '"' + etag + '"' })),
      quoted: await attempt(() => BUCKET.get('hello.txt', { onlyIf: { etagMatches: '"' + etag + '"' } })),
      putFails: await BUCKET.put('hello.txt', 'replaced', { onlyIf: { etagMatches: 'nope' } }),
      putIfAbsent: object(await BUCKET.put('new.txt', 'new', { onlyIf: { etagDoesNotMatch: '*' } })),
      putIfAbsentAgain: await BUCKET.put('new.txt', 'newer', { onlyIf: { etagDoesNotMatch: '*' } }),
      unchanged: await (await BUCKET.get('hello.txt')).text(),
    };
  });
  out.checksums = await attempt(async () => {
    const md5 = await crypto.subtle.digest('MD5', enc.encode('checked'));
    const sha256 = await crypto.subtle.digest('SHA-256', enc.encode('checked'));
    return {
      md5: object(await BUCKET.put('checked', 'checked', { md5 })),
      md5Hex: object(await BUCKET.put('checked', 'checked', { md5: hex(md5) })),
      sha256: object(await BUCKET.put('checked', 'checked', { sha256 })),
      wrong: await attempt(() => BUCKET.put('checked', 'checked', { md5: '00000000000000000000000000000000' })),
    };
  });
  out.values = await attempt(async () => {
    await BUCKET.put('v/string', 'string');
    await BUCKET.put('v/buffer', enc.encode('buffer').buffer);
    await BUCKET.put('v/view', enc.encode('view'));
    await BUCKET.put('v/blob', new Blob(['blob']));
    await BUCKET.put('v/null', null);
    const read = async (key) => { const o = await BUCKET.get(key); return [o.size, await o.text()]; };
    return [await read('v/string'), await read('v/buffer'), await read('v/view'), await read('v/blob'), await read('v/null')];
  });
  out.putStream = await attempt(async () => { await BUCKET.put('v/stream', new Response('stream').body); return await (await BUCKET.get('v/stream')).text(); });
  out.httpHeaders = await attempt(async () => object(await BUCKET.put('headers.txt', 'h', { httpMetadata: new Headers({ 'content-type': 'text/html', 'content-language': 'en', 'cache-control': 'max-age=60' }) })));
  out.list = await attempt(async () => {
    const listed = await BUCKET.list();
    return { ...listed, objects: listed.objects.map((o) => o.key) };
  });
  out.listObjects = await attempt(async () => {
    const listed = await BUCKET.list({ prefix: 'hello' });
    return { ...listed, objects: listed.objects.map(object) };
  });
  out.listInclude = await attempt(async () => (await BUCKET.list({ prefix: 'hello', include: ['httpMetadata', 'customMetadata'] })).objects.map(object));
  out.listDelimiter = await attempt(async () => {
    for (const key of ['dir/a', 'dir/sub/b', 'dir/sub/c', 'dir/z']) await BUCKET.put(key, key);
    const listed = await BUCKET.list({ prefix: 'dir/', delimiter: '/' });
    return { ...listed, objects: listed.objects.map((o) => o.key) };
  });
  out.listPages = await attempt(async () => {
    const first = await BUCKET.list({ prefix: 'v/', limit: 2 });
    const second = await BUCKET.list({ prefix: 'v/', limit: 2, cursor: first.cursor });
    return [first, second].map((page) => ({ ...page, objects: page.objects.map((o) => o.key) }));
  });
  out.listStartAfter = await attempt(async () => (await BUCKET.list({ prefix: 'v/', startAfter: 'v/buffer' })).objects.map((o) => o.key));
  out.listLimit = await attempt(() => BUCKET.list({ limit: 0 }));
  out.listLimitCoerced = await attempt(async () => [
    (await BUCKET.list({ prefix: 'v/', limit: 1.5 })).objects.map((o) => o.key),
    (await BUCKET.list({ prefix: 'v/', limit: '2' })).objects.map((o) => o.key),
    (await BUCKET.list({ prefix: 'v/', limit: 2.9 })).truncated,
  ]);
  out.listLimitNaN = await attempt(() => BUCKET.list({ limit: NaN }));
  out.listLimitBigInt = {
    direct: await attempt(() => BUCKET.list({ limit: 1n })),
    valueOf: await attempt(() => BUCKET.list({ limit: { valueOf: () => 1n } })),
    numberValueOf: await attempt(async () => (await BUCKET.list({ prefix: 'v/', limit: { valueOf: () => 2 } })).objects.map((o) => o.key)),
  };
  out.delete = await attempt(async () => {
    const one = await BUCKET.delete('hello.txt');
    const many = await BUCKET.delete(['v/string', 'v/buffer', 'never-stored']);
    return [one, many, await BUCKET.head('hello.txt'), (await BUCKET.list({ prefix: 'v/' })).objects.map((o) => o.key)];
  });
  out.longKey = await attempt(() => BUCKET.put('k'.repeat(1025), 'x'));
  out.metadataCoerced = await attempt(async () => {
    const put = object(await BUCKET.put('meta.txt', 'm', { customMetadata: { count: 1, flag: true }, httpMetadata: { contentType: 1 } }));
    const got = await BUCKET.get('meta.txt');
    return { put, head: object(await BUCKET.head('meta.txt')), get: object(got), text: await got.text() };
  });
  out.listIncludeBogus = await attempt(() => BUCKET.list({ include: ['bogus'] }));
  out.bigStream = await attempt(async () => {
    const size = 640 * 65536;
    const { readable, writable } = new FixedLengthStream(size);
    const writing = pieces(640).pipeTo(writable);
    const put = await BUCKET.put('big.bin', readable);
    await writing;
    const digest = new crypto.DigestStream('MD5');
    await (await BUCKET.get('big.bin')).body.pipeTo(digest);
    const answer = { size: put.size, head: (await BUCKET.head('big.bin')).size, md5: hex(await digest.digest) === put.etag };
    await BUCKET.delete('big.bin');
    return answer;
  });
  out.unknownLength = await attempt(async () => {
    try {
      return object(await BUCKET.put('plain', new ReadableStream({ start(c) { c.enqueue(enc.encode('plain')); c.close(); } })));
    } finally {
      await BUCKET.delete('plain');
    }
  });
  return out;
}

async function step2(env) {
  return {
    kv: await attempt(async () => [await env.KV.get('json', 'json'), (await env.KV.list()).keys.map((k) => k.name)]),
    d1: await attempt(() => env.DB.prepare('SELECT name FROM people ORDER BY id').raw()),
    r2: await attempt(async () => [await (await env.BUCKET.get('data.json')).text(), (await env.BUCKET.list()).objects.map((o) => o.key)]),
  };
}

export default {
  async fetch(request, env) {
    const step = new URL(request.url).searchParams.get('step');
    if (step === '2') return Response.json({ step: 2, ...(await step2(env)) });
    return Response.json({ step: 1, kv: await kv(env.KV), d1: await d1(env.DB), r2: await r2(env.BUCKET) });
  },
};
`;

/** What the Worker answers on Cloudflare at `step`. */
export function expectedAnswer(step) {
  return EXPECTED[step];
}

/**
 * What Nimbus answers where Cloudflare answers `answer` (step 1's), and why
 * it differs:
 *
 * - a D1 result's meta.served_by names the database that ran the statement,
 *   and Nimbus's is its own (wrangler dev's says miniflare.db, Cloudflare's
 *   a D1 server's);
 * - workerd refuses an R2 put of a stream whose length it does not know,
 *   before it sends it. A stream's length is not visible to JavaScript, and
 *   crossing to the binding does not keep it, so Nimbus stores the stream,
 *   counting it against R2's per-upload limit as it arrives.
 */
export function nimbusAnswer(answer) {
  if (answer.step !== 1) return answer;
  const etag = 'ac7938d40cfc2307e2bf325d28e7884e';
  const unknownLength = {
    class: 'HeadResult',
    keys: ['ssecKeyMd5', 'storageClass', 'range', 'customMetadata', 'httpMetadata', 'uploaded', 'checksums', 'httpEtag', 'etag', 'size', 'version', 'key'],
    key: 'plain', size: 5, etag, httpEtag: `"${etag}"`, version: true, uploaded: true, httpMetadata: {}, customMetadata: {},
    checksums: { md5: etag }, md5: etag, storageClass: '', body: false, writeHttpMetadata: 'function',
  };
  return {
    ...answer,
    d1: { ...answer.d1, servedBy: ['nimbus-d1-emu'] },
    r2: { ...answer.r2, unknownLength: { value: unknownLength } },
  };
}

const EXPECTED = {
  1: {
    "step": 1,
    kv: {
      "putGet": {"value": "alpha"},
      "missing": {"value": null},
      "json": {"value": [{"x": 1, "y": [true, null]}, {"x": 1, "y": [true, null]}, "{\"x\":1,\"y\":[true,null]}"]},
      "arrayBuffer": {"value": [true, [0, 1, 255]]},
      "stream": {"value": [true, "alpha"]},
      "putStream": {"value": "from a stream"},
      "putBuffer": {"value": "buffer"},
      "metadata": {"value": {"value": "with metadata", "metadata": {"m": 1, "s": "x"}, "cacheStatus": null}},
      "metadataJson": {"value": {"value": {"x": 1, "y": [true, null]}, "metadata": null, "cacheStatus": null}},
      "metadataNone": {"value": {"value": "alpha", "metadata": null, "cacheStatus": null}},
      "metadataMissing": {"value": {"value": null, "metadata": null, "cacheStatus": null}},
      "overwrite": {"value": {"value": "w", "metadata": null, "cacheStatus": null}},
      "ttl": {"value": ["expiring", 1, true]},
      "list": {"value": {"keys": [{"name": "a"}, {"name": "bin"}, {"name": "buffer"}, {"name": "json"}, {"name": "meta", "expiration": 2000000000, "metadata": {"m": 1, "s": "x"}}, {"name": "meta2"}, {"name": "p/1", "metadata": {"key": "p/1"}}, {"name": "p/2", "metadata": {"key": "p/2"}}, {"name": "p/3", "metadata": {"key": "p/3"}}, {"name": "streamed"}], "list_complete": true, "cacheStatus": null}},
      "listPages": {"value": [{"keys": [{"name": "p/1", "metadata": {"key": "p/1"}}, {"name": "p/2", "metadata": {"key": "p/2"}}], "list_complete": false, "cursor": "cC8y", "cacheStatus": null}, {"keys": [{"name": "p/3", "metadata": {"key": "p/3"}}], "list_complete": true, "cacheStatus": null}]},
      "bulk": {"value": [true, [["a", "alpha"], ["json", "{\"x\":1,\"y\":[true,null]}"], ["missing", null]]]},
      "bulkJson": {"value": [["json", {"x": 1, "y": [true, null]}], ["missing", null]]},
      "bulkMetadata": {"value": [["meta", {"value": "with metadata", "metadata": {"m": 1, "s": "x"}}], ["a", {"value": "alpha", "metadata": null}]]},
      "delete": {"value": [null, null, null]},
      "bulkJsonNull": {"value": [["jnull", null], ["missing", null]]},
      "limitsCoerced": {"value": [2, 1, 3]},
      "ttlNaN": {"error": {"name": "Error", "message": "KV PUT failed: 400 Invalid expiration_ttl of 0. Please specify integer greater than 0."}},
      "limitBigInt": {"direct": {"error": {"name": "TypeError", "message": "Cannot convert a BigInt value to a number"}}, "valueOf": {"error": {"name": "TypeError", "message": "Cannot convert a BigInt value to a number"}}, "numberValueOf": {"value": 2}},
      "listLimitNotPositive": {"value": [3, 3]},
      "bigStream": {"value": {"name": "Error", "message": "KV PUT failed: 413 Value length of N exceeds limit of 26214400.", "pastLimit": true, "stored": null}},
      errors: {
        "emptyKey": {"error": {"name": "TypeError", "message": "Key name cannot be empty."}},
        "dotKey": {"error": {"name": "TypeError", "message": "\"..\" is not allowed as a key name."}},
        "longKey": {"error": {"name": "Error", "message": "KV GET failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512."}},
        "shortTtl": {"error": {"name": "Error", "message": "KV PUT failed: 400 Invalid expiration_ttl of 30. Expiration TTL must be at least 60."}},
        "pastExpiration": {"error": {"name": "Error", "message": "KV PUT failed: 400 Invalid expiration of 1000. Please specify integer greater than the current number of seconds since the UNIX epoch."}},
        "int32Expiration": {"error": {"name": "TypeError", "message": "Value out of range. Must be between -2147483648 and 2147483647 (inclusive)."}},
        "shortCacheTtl": {"error": {"name": "Error", "message": "KV GET failed: 400 Invalid cache_ttl of 10. Cache TTL must be at least 30."}},
        "bulkType": {"error": {"name": "Error", "message": "KV GET_BULK failed: 400 \"arrayBuffer\" is not a valid type. Use \"json\" or \"text\""}},
        "bulkNotJson": {"error": {"name": "Error", "message": "KV GET_BULK failed: 400 At least one of the requested keys corresponds to a non-json value"}},
        "listLimit": {"error": {"name": "Error", "message": "KV GET failed: 400 Invalid key_count_limit of 1001. Please specify an integer less than 1000."}},
        "numberValue": {"value": "123"},
        "objectValue": {"error": {"name": "TypeError", "message": "KV put() accepts only strings, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values."}},
        "missingBadType": {"value": null},
        "badType": {"error": {"name": "TypeError", "message": "Unknown response type. Possible types are \"text\", \"arrayBuffer\", \"json\", and \"stream\"."}},
        "notJson": {"error": {"name": "SyntaxError", "message": "Unexpected token 'r', \"from a stream\" is not valid JSON"}},
      },
    },
    d1: {
      "execCreate": {"value": {"count": 1, "duration": "number"}},
      "execLines": {"value": 3},
      "runInsert": {"value": {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 1, "last_row_id": 1, "changed_db": true, "size_after": "number", "rows_read": 0, "rows_written": 1}, "results": []}},
      "runInsertBuffer": {"value": {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 1, "last_row_id": 2, "changed_db": true, "size_after": "number", "rows_read": 0, "rows_written": 1}, "results": []}},
      "runInsertArray": {"value": {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 1, "last_row_id": 3, "changed_db": true, "size_after": "number", "rows_read": 0, "rows_written": 1}, "results": []}},
      "all": {"value": {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 0, "last_row_id": 3, "changed_db": false, "size_after": "number", "rows_read": 3, "rows_written": 0}, "results": [{"id": 1, "name": "alice", "score": 1.5, "active": 1, "data": [1, 2, 3]}, {"id": 2, "name": "bob", "score": null, "active": 0, "data": [9]}, {"id": 3, "name": "carol", "score": null, "active": null, "data": [7, 8]}]}},
      "runSelect": {"value": {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 0, "last_row_id": 3, "changed_db": false, "size_after": "number", "rows_read": 3, "rows_written": 0}, "results": [{"name": "alice"}, {"name": "bob"}, {"name": "carol"}]}},
      "update": {"value": {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 1, "last_row_id": 3, "changed_db": true, "size_after": "number", "rows_read": 3, "rows_written": 1}, "results": []}},
      "first": {"value": {"name": "alice", "score": 2.5}},
      "firstColumn": {"value": "bob"},
      "firstMissingColumn": {"error": {"name": "Error", "message": "D1_COLUMN_NOTFOUND: Column not found (nope)", "cause": "Column not found"}},
      "firstNone": {"value": null},
      "raw": {"value": [[1, "alice", [1, 2, 3]], [2, "bob", [9]], [3, "carol", [7, 8]]]},
      "rawColumns": {"value": [["id", "name"], [1, "alice"], [2, "bob"], [3, "carol"]]},
      "rawNone": {"value": [["id"]]},
      "duplicateColumns": {"value": [{"x": 2}, [["x", "x"], [1, 2]]]},
      "numbered": {"value": {"b": "y", "a": "x"}},
      "types": {"value": {"i": "real", "r": "real", "t": "text", "n": "null", "b": "blob", "big": 9007199254740992}},
      "batch": {"value": [{"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 1, "last_row_id": 3, "changed_db": true, "size_after": "number", "rows_read": 0, "rows_written": 1}, "results": []}, {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 1, "last_row_id": 3, "changed_db": true, "size_after": "number", "rows_read": 3, "rows_written": 1}, "results": []}, {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 0, "last_row_id": 3, "changed_db": false, "size_after": "number", "rows_read": 6, "rows_written": 0}, "results": [{"name": "A"}, {"name": "b"}, {"name": "c"}]}]},
      "batchRollback": {"value": {"before": 3, "error": {"error": {"name": "Error", "message": "D1_ERROR: no such table: missing: SQLITE_ERROR", "cause": "no such table: missing: SQLITE_ERROR"}}, "after": 3}},
      "statement": {"value": {"statement": "SELECT ?, ?", "params": [1, [4]]}},
      "session": {"value": {"before": null, "row": {"one": 1}, "batch": [[{"two": 2}]], "bookmark": "xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "later": true}},
      errors: {
        "noTable": {"error": {"name": "Error", "message": "D1_ERROR: no such table: missing: SQLITE_ERROR", "cause": "no such table: missing: SQLITE_ERROR"}},
        "syntax": {"error": {"name": "Error", "message": "D1_ERROR: near \"SELEC\": syntax error at offset 0: SQLITE_ERROR", "cause": "near \"SELEC\": syntax error at offset 0: SQLITE_ERROR"}},
        "constraint": {"error": {"name": "Error", "message": "D1_ERROR: NOT NULL constraint failed: people.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)", "cause": "NOT NULL constraint failed: people.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)"}},
        "rawNoTable": {"error": {"name": "Error", "message": "D1_ERROR: no such table: missing: SQLITE_ERROR", "cause": "no such table: missing: SQLITE_ERROR"}},
        "firstNoTable": {"error": {"name": "Error", "message": "D1_ERROR: no such table: missing: SQLITE_ERROR", "cause": "no such table: missing: SQLITE_ERROR"}},
        "bindUndefined": {"error": {"name": "Error", "message": "D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'", "cause": "Type 'undefined' not supported for value 'undefined'"}},
        "bindObject": {"error": {"name": "Error", "message": "D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'", "cause": "Type 'object' not supported for value '[object Object]'"}},
        "bindBigint": {"error": {"name": "Error", "message": "D1_TYPE_ERROR: Type 'bigint' not supported for value '1'", "cause": "Type 'bigint' not supported for value '1'"}},
        "empty": {"error": {"name": "Error", "message": "D1_ERROR: No SQL statements detected.", "cause": "No SQL statements detected."}},
        "comment": {"error": {"name": "Error", "message": "D1_ERROR: No SQL statements detected.", "cause": "No SQL statements detected."}},
        "twoStatements": {"value": {"success": true, "meta": {"keys": ["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"], "duration": "number", "changes": 0, "last_row_id": 4, "changed_db": false, "size_after": "number", "rows_read": 0, "rows_written": 0}, "results": [{"2": 2}]}},
        "exec": {"error": {"name": "Error", "message": "D1_EXEC_ERROR: Error in line 1: SELECT * FROM missing: no such table: missing: SQLITE_ERROR", "cause": "Error in line 1: SELECT * FROM missing: no such table: missing: SQLITE_ERROR"}},
        "execSecondLine": {"error": {"name": "Error", "message": "D1_EXEC_ERROR: Error in line 1: INSERT INTO tags VALUES ('e'): no such table: missing: SQLITE_ERROR", "cause": "Error in line 1: INSERT INTO tags VALUES ('e'): no such table: missing: SQLITE_ERROR"}},
        "execMultiline": {"error": {"name": "Error", "message": "D1_EXEC_ERROR: Error in line 1: CREATE TABLE broken (: incomplete input: SQLITE_ERROR", "cause": "Error in line 1: CREATE TABLE broken (: incomplete input: SQLITE_ERROR"}},
        "query": {"error": {"name": "Error", "message": "D1_ERROR: D1Database.query() requires the d1_binding_jsrpc compatibility flag. Enable d1_binding_jsrpc before calling query()."}},
      },
      "afterErrors": {"value": 0},
      "servedBy": ["miniflare.db"],
    },
    r2: {
      "put": {"value": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "hello.txt", "size": 9, "etag": "06b9a4a9751dc35d9f0d94b3a6cfea99", "httpEtag": "\"06b9a4a9751dc35d9f0d94b3a6cfea99\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "text/plain", "cacheControl": "no-cache"}, "customMetadata": {"owner": "test"}, "checksums": {"md5": "06b9a4a9751dc35d9f0d94b3a6cfea99"}, "md5": "06b9a4a9751dc35d9f0d94b3a6cfea99", "storageClass": "", "body": false, "writeHttpMetadata": "function"}},
      "head": {"value": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "hello.txt", "size": 9, "etag": "06b9a4a9751dc35d9f0d94b3a6cfea99", "httpEtag": "\"06b9a4a9751dc35d9f0d94b3a6cfea99\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "text/plain", "cacheControl": "no-cache"}, "customMetadata": {"owner": "test"}, "range": {"offset": 0, "length": 9}, "checksums": {"md5": "06b9a4a9751dc35d9f0d94b3a6cfea99"}, "md5": "06b9a4a9751dc35d9f0d94b3a6cfea99", "storageClass": "", "body": false, "writeHttpMetadata": "function"}},
      "headMissing": {"value": null},
      "get": {"value": {"class": "GetResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "hello.txt", "size": 9, "etag": "06b9a4a9751dc35d9f0d94b3a6cfea99", "httpEtag": "\"06b9a4a9751dc35d9f0d94b3a6cfea99\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "text/plain", "cacheControl": "no-cache"}, "customMetadata": {"owner": "test"}, "range": {"offset": 0, "length": 9}, "checksums": {"md5": "06b9a4a9751dc35d9f0d94b3a6cfea99"}, "md5": "06b9a4a9751dc35d9f0d94b3a6cfea99", "storageClass": "", "body": true, "writeHttpMetadata": "function", "before": false, "stream": true, "text": "Hello, R2", "after": true}},
      "getMissing": {"value": null},
      "bodies": {"value": {"json": {"a": [1, 2]}, "arrayBuffer": [123, 34, 97, 34, 58, 91, 49, 44, 50, 93, 125], "bytes": [true, 11], "blob": [true, 11, "{\"a\":[1,2]}"], "stream": "{\"a\":[1,2]}", "twice": {"error": {"name": "TypeError", "message": "Body has already been used. It can only be used once. Use tee() first if you need to read it twice."}}}},
      "writeHttpMetadata": {"value": [["cache-control", "no-cache"], ["content-type", "text/plain"]]},
      "ranges": {"value": {"offsetLength": [{"offset": 1, "length": 4}, "ello"], "offset": [{"offset": 7, "length": 2}, "R2"], "length": [{"offset": 0, "length": 5}, "Hello"], "suffix": [{"offset": 7, "length": 2}, "R2"], "longSuffix": [{"offset": 0, "length": 9}, "Hello, R2"], "header": [{"offset": 0, "length": 5}, "Hello"]}},
      "rangeErrors": {"negative": {"error": {"name": "RangeError", "message": "Invalid range. Starting offset (-1) must be greater than or equal to 0."}}, "fraction": {"error": {"name": "RangeError", "message": "Invalid range. Starting offset (1.5) must be an integer, not floating point."}}, "suffixAndOffset": {"error": {"name": "TypeError", "message": "Suffix is incompatible with offset."}}, "beyond": {"error": {"name": "Error", "message": "get: The requested range is not satisfiable (10039)"}}},
      "conditionals": {"value": {"matches": {"class": "GetResult", "body": true, "range": {"offset": 0, "length": 9}}, "doesNotMatch": {"class": "HeadResult", "body": false, "range": {"offset": 0, "length": 9}}, "wrongMatch": {"class": "HeadResult", "body": false, "range": {"offset": 0, "length": 9}}, "wildcard": {"class": "GetResult", "body": true, "range": {"offset": 0, "length": 9}}, "uploadedBefore": {"class": "HeadResult", "body": false, "range": {"offset": 0, "length": 9}}, "uploadedAfter": {"class": "GetResult", "body": true, "range": {"offset": 0, "length": 9}}, "headers": {"class": "HeadResult", "body": false, "range": {"offset": 0, "length": 9}}, "quoted": {"error": {"name": "TypeError", "message": "Conditional ETag should not be wrapped in quotes (\"06b9a4a9751dc35d9f0d94b3a6cfea99\")."}}, "putFails": null, "putIfAbsent": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "new.txt", "size": 3, "etag": "22af645d1859cb5ca6da0c484f1f37ea", "httpEtag": "\"22af645d1859cb5ca6da0c484f1f37ea\"", "version": true, "uploaded": true, "httpMetadata": {}, "customMetadata": {}, "checksums": {"md5": "22af645d1859cb5ca6da0c484f1f37ea"}, "md5": "22af645d1859cb5ca6da0c484f1f37ea", "storageClass": "", "body": false, "writeHttpMetadata": "function"}, "putIfAbsentAgain": null, "unchanged": "Hello, R2"}},
      "checksums": {"value": {"md5": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "checked", "size": 7, "etag": "3793ea52a7be2d7deafd858fda50775c", "httpEtag": "\"3793ea52a7be2d7deafd858fda50775c\"", "version": true, "uploaded": true, "httpMetadata": {}, "customMetadata": {}, "checksums": {"md5": "3793ea52a7be2d7deafd858fda50775c"}, "md5": "3793ea52a7be2d7deafd858fda50775c", "storageClass": "", "body": false, "writeHttpMetadata": "function"}, "md5Hex": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "checked", "size": 7, "etag": "3793ea52a7be2d7deafd858fda50775c", "httpEtag": "\"3793ea52a7be2d7deafd858fda50775c\"", "version": true, "uploaded": true, "httpMetadata": {}, "customMetadata": {}, "checksums": {"md5": "3793ea52a7be2d7deafd858fda50775c"}, "md5": "3793ea52a7be2d7deafd858fda50775c", "storageClass": "", "body": false, "writeHttpMetadata": "function"}, "sha256": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "checked", "size": 7, "etag": "3793ea52a7be2d7deafd858fda50775c", "httpEtag": "\"3793ea52a7be2d7deafd858fda50775c\"", "version": true, "uploaded": true, "httpMetadata": {}, "customMetadata": {}, "checksums": {"md5": "3793ea52a7be2d7deafd858fda50775c", "sha256": "e61a3d78c65133c7260c43e719d97c46e16bd50c64ee7800536cf14c6407a617"}, "md5": "3793ea52a7be2d7deafd858fda50775c", "storageClass": "", "body": false, "writeHttpMetadata": "function"}, "wrong": {"error": {"name": "Error", "message": "put: The MD5 checksum you specified did not match what we received.\nYou provided a MD5 checksum with value: 00000000000000000000000000000000\nActual MD5 was: 3793ea52a7be2d7deafd858fda50775c (10037)"}}}},
      "values": {"value": [[6, "string"], [6, "buffer"], [4, "view"], [4, "blob"], [0, ""]]},
      "putStream": {"value": "stream"},
      "httpHeaders": {"value": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "headers.txt", "size": 1, "etag": "2510c39011c5be704182423e3a695e91", "httpEtag": "\"2510c39011c5be704182423e3a695e91\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "text/html", "contentLanguage": "en", "cacheControl": "max-age=60"}, "customMetadata": {}, "checksums": {"md5": "2510c39011c5be704182423e3a695e91"}, "md5": "2510c39011c5be704182423e3a695e91", "storageClass": "", "body": false, "writeHttpMetadata": "function"}},
      "list": {"value": {"objects": ["checked", "data.json", "headers.txt", "hello.txt", "new.txt", "v/blob", "v/buffer", "v/null", "v/stream", "v/string", "v/view"], "truncated": false, "delimitedPrefixes": []}},
      "listObjects": {"value": {"objects": [{"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "hello.txt", "size": 9, "etag": "06b9a4a9751dc35d9f0d94b3a6cfea99", "httpEtag": "\"06b9a4a9751dc35d9f0d94b3a6cfea99\"", "version": true, "uploaded": true, "httpMetadata": {}, "customMetadata": {}, "checksums": {"md5": "06b9a4a9751dc35d9f0d94b3a6cfea99"}, "md5": "06b9a4a9751dc35d9f0d94b3a6cfea99", "storageClass": "", "body": false, "writeHttpMetadata": "function"}], "truncated": false, "delimitedPrefixes": []}},
      "listInclude": {"value": [{"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "hello.txt", "size": 9, "etag": "06b9a4a9751dc35d9f0d94b3a6cfea99", "httpEtag": "\"06b9a4a9751dc35d9f0d94b3a6cfea99\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "text/plain", "cacheControl": "no-cache"}, "customMetadata": {"owner": "test"}, "checksums": {"md5": "06b9a4a9751dc35d9f0d94b3a6cfea99"}, "md5": "06b9a4a9751dc35d9f0d94b3a6cfea99", "storageClass": "", "body": false, "writeHttpMetadata": "function"}]},
      "listDelimiter": {"value": {"objects": ["dir/a", "dir/z"], "truncated": false, "delimitedPrefixes": ["dir/sub/"]}},
      "listPages": {"value": [{"objects": ["v/blob", "v/buffer"], "truncated": true, "cursor": "di9idWZmZXI=", "delimitedPrefixes": []}, {"objects": ["v/null", "v/stream"], "truncated": true, "cursor": "di9zdHJlYW0=", "delimitedPrefixes": []}]},
      "listStartAfter": {"value": ["v/null", "v/stream", "v/string", "v/view"]},
      "listLimit": {"error": {"name": "Error", "message": "list: MaxKeys params must be positive integer <= 1000. (10022)"}},
      "listLimitCoerced": {"value": [["v/blob"], ["v/blob", "v/buffer"], true]},
      "listLimitNaN": {"error": {"name": "Error", "message": "list: MaxKeys params must be positive integer <= 1000. (10022)"}},
      "listLimitBigInt": {"direct": {"error": {"name": "TypeError", "message": "Cannot convert a BigInt value to a number"}}, "valueOf": {"error": {"name": "TypeError", "message": "Cannot convert a BigInt value to a number"}}, "numberValueOf": {"value": ["v/blob", "v/buffer"]}},
      "delete": {"value": [null, null, null, ["v/blob", "v/null", "v/stream", "v/view"]]},
      "longKey": {"error": {"name": "Error", "message": "put: The specified object name is not valid. (10020)"}},
      "metadataCoerced": {"value": {"put": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "meta.txt", "size": 1, "etag": "6f8f57715090da2632453988d9a1501b", "httpEtag": "\"6f8f57715090da2632453988d9a1501b\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "1"}, "customMetadata": {"count": "1", "flag": "true"}, "checksums": {"md5": "6f8f57715090da2632453988d9a1501b"}, "md5": "6f8f57715090da2632453988d9a1501b", "storageClass": "", "body": false, "writeHttpMetadata": "function"}, "head": {"class": "HeadResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "meta.txt", "size": 1, "etag": "6f8f57715090da2632453988d9a1501b", "httpEtag": "\"6f8f57715090da2632453988d9a1501b\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "1"}, "customMetadata": {"count": "1", "flag": "true"}, "range": {"offset": 0, "length": 1}, "checksums": {"md5": "6f8f57715090da2632453988d9a1501b"}, "md5": "6f8f57715090da2632453988d9a1501b", "storageClass": "", "body": false, "writeHttpMetadata": "function"}, "get": {"class": "GetResult", "keys": ["ssecKeyMd5", "storageClass", "range", "customMetadata", "httpMetadata", "uploaded", "checksums", "httpEtag", "etag", "size", "version", "key"], "key": "meta.txt", "size": 1, "etag": "6f8f57715090da2632453988d9a1501b", "httpEtag": "\"6f8f57715090da2632453988d9a1501b\"", "version": true, "uploaded": true, "httpMetadata": {"contentType": "1"}, "customMetadata": {"count": "1", "flag": "true"}, "range": {"offset": 0, "length": 1}, "checksums": {"md5": "6f8f57715090da2632453988d9a1501b"}, "md5": "6f8f57715090da2632453988d9a1501b", "storageClass": "", "body": true, "writeHttpMetadata": "function"}, "text": "m"}},
      "listIncludeBogus": {"error": {"name": "RangeError", "message": "Unsupported include value bogus"}},
      "bigStream": {"value": {"size": 41943040, "head": 41943040, "md5": true}},
      "unknownLength": {"error": {"name": "TypeError", "message": "Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)"}},
    },
  },
  2: {
    "step": 2,
    "kv": {"value": [{"x": 1, "y": [true, null]}, ["bin", "buffer", "jnull", "json", "meta", "meta2", "p/1", "p/2", "p/3", "streamed", "t"]]},
    "d1": {"value": [["alice"], ["bob"], ["carol"]]},
    "r2": {"value": ["{\"a\":[1,2]}", ["checked", "data.json", "dir/a", "dir/sub/b", "dir/sub/c", "dir/z", "headers.txt", "meta.txt", "new.txt", "v/blob", "v/null", "v/stream", "v/view"]]},
  },
};
