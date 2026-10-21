// The same HTTP server and undici.request program run under Node's bundled
// undici and a Nimbus process. The destination, not a fetch spy, records what
// arrived. The live behavioral probe uses these fixtures too.
export const REDIRECT_SERVER = String.raw`
const http = require('http');
const servers = [];
const origins = [];
let listening;
const redirectReady = new Promise((resolve) => { listening = resolve; });
// Called by /handshake on the first part of a request body: a streamed upload's producer waits for it.
let handshakeSeen = () => {};
const observe = async (req, origin) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const names = ['authorization', 'cookie', 'proxy-authorization', 'content-type',
    'content-length', 'content-language', 'content-encoding', 'content-location', 'content-probe'];
  return {
    method: req.method, body,
    host: req.headers.host === new URL(origin).host ? 'destination' : (req.headers.host ?? '-'),
    headers: Object.fromEntries(names.map((name) => [name, req.headers[name] ?? '-'])),
  };
};
for (let index = 0; index < 2; index++) {
  const server = http.createServer(async (req, res) => {
    if (new URL(req.url, origins[index]).pathname === '/handshake') {
      let body = '';
      for await (const chunk of req) { body += chunk; handshakeSeen(); }
      res.writeHead(200);
      res.end('received ' + body);
      return;
    }
    const record = await observe(req, origins[index]);
    const url = new URL(req.url, origins[index]);
    if (url.pathname === '/chain') {
      const hop = Number(url.searchParams.get('hop') || 0);
      const stop = Number(url.searchParams.get('stop') || 99);
      const first = Number(url.searchParams.get('first') || 302);
      res.writeHead(hop === stop ? 200 : hop === 0 ? first : 302, {
        'x-hop': String(hop), location: '/chain?hop=' + (hop + 1) + '&stop=' + stop,
      });
      res.end('hop:' + hop);
      return;
    }
    if (url.pathname === '/hop') {
      const status = Number(url.searchParams.get('status'));
      const target = url.searchParams.get('target');
      const location = target === 'cross' ? origins[1] + '/landed'
        : target === 'roundtrip' ? origins[1] + '/return' : '/landed';
      res.writeHead(status, { location, 'x-observed': JSON.stringify(record) });
      res.end('redirect');
      return;
    }
    if (url.pathname === '/return') {
      res.writeHead(307, { location: origins[0] + '/landed' });
      res.end('return');
      return;
    }
    res.writeHead(200, { 'x-observed': JSON.stringify(record) });
    res.end('landed');
  });
  servers.push(server);
  server.listen(Number(process.argv[index + 2] || 0), '127.0.0.1', () => {
    origins[index] = 'http://127.0.0.1:' + server.address().port;
    if (origins[0] && origins[1]) {
      console.log('REDIRECT_ORIGINS ' + JSON.stringify(origins));
      listening(origins);
    }
  });
}
`.trim();

/**
 * A request body of each kind undici.request takes, 'payload' in each:
 * a string (undefined), a Buffer, a Node Readable, an async generator, a Web
 * ReadableStream, a sync generator, an array of Buffers, a Blob.
 * @typedef {'bytes' | 'readable' | 'async' | 'web' | 'generator' | 'array' | 'blob'} BodyKind
 */
/** @type {{ status: number, target: string, method: string, kind?: BodyKind, flat?: boolean }[]} */
export const REDIRECT_CASES = [
  ...[300, 301, 302, 303, 307, 308].flatMap((status) => ['cross', 'same'].map((target) => ({ status, target, method: 'POST' }))),
  ...['PUT', 'DELETE', 'GET', 'HEAD'].map((method) => ({ status: 303, target: 'cross', method })),
  ...[301, 302, 307, 308].map((status) => ({ status, target: 'cross', method: 'PUT', kind: 'bytes' })),
  ...[304, 305, 306, 309].map((status) => ({ status, target: 'cross', method: 'GET' })),
  { status: 307, target: 'roundtrip', method: 'POST', flat: true },
  { status: 308, target: 'same', method: 'POST', flat: true },
  ...[303, 307, 308].map((status) => ({ status, target: 'cross', method: 'POST', kind: 'readable' })),
  ...['async', 'web', 'generator', 'array', 'blob'].flatMap((kind) => [301, 303, 307].map((status) => ({ status, target: 'cross', method: 'POST', kind }))),
];

/**
 * How undici 6's RedirectHandler sends each kind again (lib/handler/
 * redirect-handler.js). A Node stream is marked used once read, so a
 * redirect after it was sent is not followed. Any other iterable but a
 * string or a byte view is sent as itself first, then iterated again for a
 * hop that keeps the body (BodyAsyncIterable): an array gives its bytes
 * again, a spent generator or stream nothing, which a Content-Length then
 * refuses. A Blob, a string and a Buffer are the same bytes every hop.
 */
const SENT_ONCE = ['readable'];
const SPENT_ONCE_ITERATED = ['async', 'web', 'generator'];
const SPENT = { error: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', message: 'Request body length does not match content-length header' };
/** The body kinds sent along a redirect chain (/chain?stop=2, its first hop a 302 or a 303). */
const CHAIN_KINDS = ['string', 'bytes', 'blob', 'array', 'async', 'web', 'generator', 'readable'];
/**
 * Where undici 6 stops a chain of redirects with each body kind: the
 * handler's wrapper is marked used once a hop sends it, and any redirect
 * after that is not followed, a 303 included, until a followed 303 drops the
 * body (lib/handler/redirect-handler.js onHeaders).
 */
const chainExpected = (kind, first) => {
  if (kind === 'readable') return { statusCode: first, hop: 0 };
  if (first === 303) return { statusCode: 200, hop: 2 };
  if (kind === 'array') return { statusCode: 302, hop: 1 };
  if (SPENT_ONCE_ITERATED.includes(kind)) return SPENT;
  return { statusCode: 200, hop: 2 };
};

export const REDIRECT_CLIENT = String.raw`
const { request } = require('undici');
const { Readable } = require('stream');
const cases = ${JSON.stringify(REDIRECT_CASES)};
const chainKinds = ${JSON.stringify(CHAIN_KINDS)};
const bodyOf = (kind, text) => {
  switch (kind) {
    case 'bytes': return Buffer.from(text);
    case 'readable': return Readable.from([text]);
    case 'async': return (async function* () { yield Buffer.from(text); })();
    case 'web': return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    case 'generator': return (function* () { yield Buffer.from(text); })();
    case 'array': return [Buffer.from(text)];
    case 'blob': return new Blob([text]);
    default: return text;
  }
};
const run = async (origin = process.argv[2]) => {
  const results = [];
  for (const entry of cases) {
    const body = entry.method === 'GET' || entry.method === 'HEAD' ? undefined : 'payload';
    const headers = {
      AuThOrIzAtIoN: 'Bearer private', CoOkIe: 'session=private',
      'PrOxY-AuThOrIzAtIoN': 'Basic private', Host: 'original.invalid',
      'Content-Type': 'application/private', 'Content-Language': 'en',
      'Content-Encoding': 'identity', 'Content-Location': '/private', 'Content-Probe': 'private',
      ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
    };
    const input = entry.flat ? Object.entries(headers).flat() : headers;
    const before = JSON.stringify(input);
    try {
      const response = await request(origin + '/hop?status=' + entry.status + '&target=' + entry.target, {
        method: entry.method, headers: input,
        body: body === undefined ? undefined : bodyOf(entry.kind, body),
        maxRedirections: 3,
      });
      const received = JSON.parse(response.headers['x-observed']);
      await response.body.dump();
      results.push({ ...entry, statusCode: response.statusCode, received, unchanged: JSON.stringify(input) === before });
    } catch (error) {
      results.push({ ...entry, error: error.code ?? error.name, message: error.message });
    }
  }
  const limits = [];
  for (const options of [{}, { maxRedirections: 0, throwOnMaxRedirect: true },
    { maxRedirections: 2 }, { maxRedirections: 2, stop: 2 },
    { maxRedirections: 2, throwOnMaxRedirect: true },
    { maxRedirections: 2, throwOnMaxRedirect: true, stop: 2 }]) {
    try {
      const response = await request(origin + '/chain?stop=' + (options.stop ?? 99), options);
      limits.push({ options, statusCode: response.statusCode, hop: Number(response.headers['x-hop']), body: await response.body.text() });
    } catch (error) {
      limits.push({ options, error: error.message, name: error.name });
    }
  }
  const chains = [];
  for (const first of [302, 303]) for (const kind of chainKinds) {
    try {
      const response = await request(origin + '/chain?stop=2&first=' + first, {
        method: 'POST', headers: { 'content-length': '7' }, body: bodyOf(kind, 'payload'), maxRedirections: 3,
      });
      await response.body.dump();
      chains.push({ kind, first, statusCode: response.statusCode, hop: Number(response.headers['x-hop']) });
    } catch (error) {
      chains.push({ kind, first, error: error.code ?? error.name, message: error.message });
    }
  }
  // A Web stream upload is sent as it is produced: its producer waits for the server to have the first part.
  const handshakes = [];
  for (const maxRedirections of [0, 3]) {
    const seen = new Promise((resolve) => { handshakeSeen = resolve; });
    let part = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (part++ === 0) { controller.enqueue(new TextEncoder().encode('first,')); return; }
        const ready = await Promise.race([seen.then(() => true), new Promise((resolve) => setTimeout(resolve, 5000, false))]);
        if (!ready) { controller.error(new Error('the server never saw the first part')); return; }
        controller.enqueue(new TextEncoder().encode('second'));
        controller.close();
      },
    });
    try {
      const response = await request(origin + '/handshake', { method: 'POST', body, maxRedirections });
      handshakes.push({ maxRedirections, statusCode: response.statusCode, body: await response.body.text() });
    } catch (error) {
      handshakes.push({ maxRedirections, error: error.code ?? error.name, message: error.message });
    }
  }
  const invalid = [];
  for (const maxRedirections of [-1, 1.5, '2']) {
    try {
      const response = await request(origin + '/landed', { maxRedirections });
      await response.body.dump();
      invalid.push({ maxRedirections, accepted: true });
    } catch (error) {
      invalid.push({ maxRedirections, message: error.message, code: error.code });
    }
  }
  const report = JSON.stringify({ results, limits, chains, handshakes, invalid });
  require('fs').writeFileSync('undici-redirect-result.json', report);
  console.log('UNDICI_REDIRECT ' + report);
};
(typeof redirectReady === 'undefined' ? run() : redirectReady.then((origins) => run(origins[0])))
  .then(() => typeof servers === 'undefined' ? undefined : Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))))
  .catch((error) => { console.error(error.stack); process.exitCode = 1; });
`.trim();

// Keeping the client and listeners in one *real* process exercises the own-HTTP
// transport, not the external-preview sanitizer (which intentionally removes
// Nimbus bearer credentials before handing a public request to user code).
export const REDIRECT_PROGRAM = `${REDIRECT_SERVER}\n${REDIRECT_CLIENT}`;

/** Expected receiver-visible behavior of Node 22.23.4's undici 6.29.1. */
export function redirectFailures(report) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  };
  check('number of redirect cases', report.results.length, REDIRECT_CASES.length);
  for (let i = 0; i < REDIRECT_CASES.length; i++) {
    const entry = REDIRECT_CASES[i];
    const result = report.results[i];
    if (!result) continue;
    const label = `${entry.status} ${entry.method} ${entry.target}${entry.flat ? ' flat headers' : ''}${entry.kind ? ` ${entry.kind} body` : ''}`;
    const followed = [300, 301, 302, 303, 307, 308].includes(entry.status) && !SENT_ONCE.includes(entry.kind);
    const rewrite = followed && entry.status === 303 && entry.method !== 'HEAD';
    if (followed && !rewrite && SPENT_ONCE_ITERATED.includes(entry.kind)) {
      check(`${label} sends its spent body again`, { error: result.error, message: result.message }, SPENT);
      continue;
    }
    if (result.error) { failures.push(`${label}: ${result.error} ${result.message}`); continue; }
    const cross = followed && entry.target !== 'same';
    check(`${label} status`, result.statusCode, followed ? 200 : entry.status);
    check(`${label} method`, result.received.method, rewrite ? 'GET' : entry.method);
    check(`${label} body`, result.received.body, rewrite || entry.method === 'GET' || entry.method === 'HEAD' ? '' : 'payload');
    check(`${label} host`, result.received.host, followed ? 'destination' : 'original.invalid');
    for (const [name, value] of Object.entries({ authorization: 'Bearer private', cookie: 'session=private', 'proxy-authorization': 'Basic private' })) {
      check(`${label} ${name}`, result.received.headers[name], cross ? '-' : value);
    }
    for (const [name, value] of Object.entries({ 'content-type': 'application/private', 'content-language': 'en', 'content-encoding': 'identity', 'content-location': '/private', 'content-probe': 'private' })) {
      check(`${label} ${name}`, result.received.headers[name], followed && entry.status === 303 ? '-' : value);
    }
    check(`${label} content-length`, result.received.headers['content-length'],
      rewrite || entry.method === 'GET' || entry.method === 'HEAD' ? '-' : '7');
    check(`${label} caller headers not mutated`, result.unchanged, true);
  }
  check('default redirect cap', report.limits[0], { options: {}, statusCode: 302, hop: 0, body: 'hop:0' });
  check('zero disables the redirect handler', report.limits[1], { options: { maxRedirections: 0, throwOnMaxRedirect: true }, statusCode: 302, hop: 0, body: 'hop:0' });
  check('cap returns the last redirect', report.limits[2], { options: { maxRedirections: 2 }, statusCode: 302, hop: 2, body: 'hop:2' });
  check('exactly two redirects reaches the final response', report.limits[3], { options: { maxRedirections: 2, stop: 2 }, statusCode: 200, hop: 2, body: 'hop:2' });
  check('throwOnMaxRedirect rejects at the cap', report.limits[4], { options: { maxRedirections: 2, throwOnMaxRedirect: true }, error: 'max redirects', name: 'Error' });
  check('throwOnMaxRedirect rejects even a final 200 at the cap', report.limits[5], { options: { maxRedirections: 2, throwOnMaxRedirect: true, stop: 2 }, error: 'max redirects', name: 'Error' });
  check('number of chains', report.chains.length, 2 * CHAIN_KINDS.length);
  for (const result of report.chains) {
    const { kind, first, ...got } = result;
    check(`chain of redirects after a ${first}, ${kind} body`, got, chainExpected(kind, first));
  }
  check('a streamed upload is sent as it is produced', report.handshakes,
    [0, 3].map((maxRedirections) => ({ maxRedirections, statusCode: 200, body: 'received first,second' })));
  check('invalid redirect counts', report.invalid, [-1, 1.5, '2'].map((maxRedirections) => ({ maxRedirections, message: 'maxRedirections must be a positive number', code: 'UND_ERR_INVALID_ARG' })));
  return failures;
}
