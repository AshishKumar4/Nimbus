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
 * upload time, an R2 version) is answered as its shape.
 */
export const WORKER = String.raw`
const enc = new TextEncoder();
const bytes = (buffer) => Array.from(new Uint8Array(buffer));
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const text = (stream) => new Response(stream).text();

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
    return { before: session.getBookmark(), row: await session.prepare('SELECT 1 AS one').first(), batch: (await session.batch([session.prepare('SELECT 2 AS two')])).map((r) => r.results) };
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
  out.delete = await attempt(async () => {
    const one = await BUCKET.delete('hello.txt');
    const many = await BUCKET.delete(['v/string', 'v/buffer', 'never-stored']);
    return [one, many, await BUCKET.head('hello.txt'), (await BUCKET.list({ prefix: 'v/' })).objects.map((o) => o.key)];
  });
  out.longKey = await attempt(() => BUCKET.put('k'.repeat(1025), 'x'));
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

/** What the Worker answers on Cloudflare at `step`; null until recorded. */
export function expectedAnswer(step) {
  return EXPECTED[step] ?? null;
}

const EXPECTED = {};

/**
 * Where Nimbus answers otherwise, and why: D1 meta's served_by names the
 * database that ran the statement, and Nimbus's is its own.
 */
export const NIMBUS_DIFFERS = {};
