#!/usr/bin/env bun
// Behavior test: `curl -D FILE` writes the response headers to FILE (or to
// stdout when FILE is `-`) while the body still goes wherever the body goes.
//
// Production failure this guards against: `curl -s -D /tmp/h -o /dev/null
// https://example.com/` left no file behind because -D was not parsed at all
// — the option fell through as an unknown short flag and the URL argument
// shift silently swallowed it. -sI worked, proving headers were obtainable;
// only the dump target was missing.

import assert from 'node:assert/strict';
import { createCurlCommand } from '../../packages/core/src/substrate/lifo/commands/net/curl.ts';

const URL = 'http://127.0.0.1:8080/';

function makeEnv(args, overrides = {}) {
  const out = [];
  const files = {};
  const kernel = overrides.kernel ?? {
    portRegistry: { get: () => undefined },
    routeLoopback: async () => new Response('body-content', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'x-mark': 'dump-header-test' },
    }),
  };
  const ctx = {
    args,
    env: {},
    cwd: '/home/user',
    vfs: {
      writeFile: overrides.writeFile ?? ((path, data) => { files[path] = data; }),
      readFileString: () => { throw new Error('not expected'); },
    },
    stdout: { write: (s) => out.push(['out', s]) },
    stderr: { write: (s) => out.push(['err', s]) },
    signal: new AbortController().signal,
  };
  return { curl: createCurlCommand(kernel), ctx, out, files };
}

const headerDumpShape = (text, status = 200) => {
  // Canonical format (GNU curl -D file, od-verified): status line and each
  // header CRLF-terminated, closed by the blank CRLF line that terminates
  // an HTTP header section. fetch exposes no wire version, so the shared
  // serializer declares HTTP/1.1; loopback Responses carry no reason
  // phrase, so the status line ends right after the code.
  assert.match(text, new RegExp(`^HTTP\\/1\\.1 ${status}\\r\\n`), 'dump starts with the canonical status line');
  assert.match(text, /x-mark: dump-header-test\r\n/, 'dump carries response headers');
  assert.match(text, /\r\n\r\n$/, 'dump closes with the blank CRLF line');
};

// ── -D FILE with -o /dev/null: header file exists, body discarded ────────────
{
  const { curl, ctx, out, files } = makeEnv(['-s', '-D', '/tmp/h', '-o', '/dev/null', URL]);
  assert.equal(await curl(ctx), 0);
  headerDumpShape(files['/tmp/h']);
  assert.deepEqual(out, [], 'stdout stays silent under -s');
}

// ── -D -: headers land on stdout before the body ─────────────────────────────
{
  const { curl, ctx, out } = makeEnv(['-s', '-D', '-', URL]);
  assert.equal(await curl(ctx), 0);
  assert.ok(out.length >= 2, 'headers and body both reached stdout');
  const [first, second] = out.map(([, s]) => s);
  headerDumpShape(first);
  assert.match(second, /body-content/, 'body follows the header dump');
}

// ── --dump-header FILE long form ─────────────────────────────────────────────
{
  const { curl, ctx, files } = makeEnv(['-s', '--dump-header', '/tmp/h2', '-o', '/dev/null', URL]);
  assert.equal(await curl(ctx), 0);
  headerDumpShape(files['/tmp/h2']);
}

// ── -D FILE alongside a real -o target: each stream keeps its own sink ───────
{
  const { curl, ctx, files } = makeEnv(['-s', '-D', '/tmp/h3', '-o', '/home/user/body.bin', URL]);
  assert.equal(await curl(ctx), 0);
  headerDumpShape(files['/tmp/h3']);
  assert.equal(new TextDecoder().decode(files['/home/user/body.bin']), 'body-content');
}

// ── relative -D path resolves against cwd ────────────────────────────────────
{
  const { curl, ctx, files } = makeEnv(['-s', '-D', 'headers.txt', '-o', '/dev/null', URL]);
  assert.equal(await curl(ctx), 0);
  headerDumpShape(files['/home/user/headers.txt']);
}

// ── -I combined with -D: dump written, header display unchanged ──────────────
{
  const { curl, ctx, out, files } = makeEnv(['-sI', '-D', '/tmp/h4', URL]);
  assert.equal(await curl(ctx), 0);
  headerDumpShape(files['/tmp/h4']);
  assert.match(out.map(([, s]) => s).join(''), /^HTTP\/1\.1 200\r\n/, 'head mode prints the same canonical header block to stdout');
}

// ── --fail on a 4xx: body suppressed, headers still dumped, exit 22 ──────────
{
  const kernel404 = {
    portRegistry: { get: () => undefined },
    routeLoopback: async () => new Response('missing-body', {
      status: 404,
      headers: { 'x-mark': 'dump-header-test' },
    }),
  };
  const out = [];
  const files = {};
  const ctx = {
    args: ['-sS', '-f', '-D', '-', '-o', '/dev/null', URL],
    env: {},
    cwd: '/home/user',
    vfs: { writeFile: (path, data) => { files[path] = data; } },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => out.push('[err]' + s) },
    signal: new AbortController().signal,
  };
  assert.equal(await createCurlCommand(kernel404)(ctx), 22, 'curl exits 22 under --fail');
  const printed = out.filter((s) => !s.startsWith('[err]')).join('');
  headerDumpShape(printed, 404);
  assert.doesNotMatch(printed, /missing-body/, '--fail still suppresses the document');
  assert.match(out.find((s) => s.startsWith('[err]')) ?? '', /curl: \(22\) The requested URL returned error: 404/, 'show-error pairs the write exit with the offending status');

  // File target variant: the dump file exists despite the failed status.
  const files2 = {};
  const ctx2 = {
    args: ['-sS', '-f', '-D', '/tmp/h5', '-o', '/dev/null', URL],
    env: {},
    cwd: '/home/user',
    vfs: { writeFile: (path, data) => { files2[path] = data; } },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    signal: new AbortController().signal,
  };
  assert.equal(await createCurlCommand(kernel404)(ctx2), 22);
  headerDumpShape(files2['/tmp/h5'], 404);
}

// ── connection failure still leaves the truncated dump file behind ───────────
{
  const { curl, ctx, files } = makeEnv(['-s', '-D', '/tmp/h', '-o', '/dev/null', URL], {
    kernel: {
      portRegistry: { get: () => undefined },
      routeLoopback: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8080'); },
    },
  });
  assert.equal(await curl(ctx), 7);
  assert.ok('/tmp/h' in files, 'the sink initializes before the request');
  assert.equal(files['/tmp/h'], '', 'no response means a truthful empty dump');
}

// ── unwritable dump target: exit 23 names the action and the cause ───────────
{
  const { curl, ctx, out } = makeEnv(['-sS', '-D', '/tmp/h', '-o', '/dev/null', URL], {
    writeFile: () => { throw new Error('EACCES: permission denied'); },
  });
  assert.equal(await curl(ctx), 23);
  const errText = out.filter(([ch]) => ch === 'err').map(([, s]) => s).join('');
  assert.match(errText, /curl: \(23\) Failed create dump-header file '\/tmp\/h': EACCES/);
}

// ── empty -D target: still a real target — attempted up front, exit 23 ────────
{
  // An empty filename resolves to cwd itself; curl must attempt that write
  // and fail the transfer with 23, never silently carry on without a dump.
  const attempts = [];
  const { curl, ctx, out } = makeEnv(['-sS', '-D', '', '-o', '/dev/null', URL], {
    writeFile: (path, data) => {
      attempts.push([path, data]);
      throw new Error('EISDIR: illegal operation on a directory');
    },
  });
  assert.equal(await curl(ctx), 23, 'an empty target is attempted, never silently ignored');
  assert.deepEqual(attempts, [['/home/user', '']], 'the empty path resolves against cwd and opens before any request');
  assert.match(
    out.filter(([ch]) => ch === 'err').map(([, s]) => s).join(''),
    /^curl: \(23\) Failed create dump-header file '': EISDIR/,
    'the failure names the empty target and its cause',
  );
}

// ── mid-transfer dump failure: exit 23, already-received blocks stay ──────────
{
  const writes = [];
  const log = [];
  const files = {};
  const { curl, ctx, out } = makeEnv(['-sS', '-L', '-D', '/tmp/h', '-o', '/dev/null', `${URL}first`], {
    kernel: twoHopKernel(log),
    writeFile: (_path, data) => {
      writes.push(data);
      if (writes.length === 3) throw new Error('simulated ENOSPC');
      files['/tmp/h'] = data;
    },
  });
  assert.equal(await curl(ctx), 23);
  const errText = out.filter(([ch]) => ch === 'err').map(([, s]) => s).join('');
  assert.match(errText, /curl: \(23\) Failed write dump-header file '\/tmp\/h': simulated ENOSPC/);
  assert.deepEqual(log, ['/first', '/second'], 'both hops were attempted once');
  assert.equal(writes.length, 3, 'open init plus one rewrite per received block');
  assert.match(files['/tmp/h'], /^HTTP\/1\.1 302 Found\r\n/, 'the arrived hop survives the failed rewrite');
}

// ── virtual redirect: every hop dumped exactly once, in arrival order ─────────
{
  const log = [];
  const { curl, ctx, files } = makeEnv(['-s', '-L', '-D', '/tmp/h', '-o', '/dev/null', `${URL}first`], {
    kernel: twoHopKernel(log),
  });
  assert.equal(await curl(ctx), 0);
  assert.deepEqual(log, ['/first', '/second']);
  assert.equal(
    files['/tmp/h'],
    'HTTP/1.1 302 Found\r\n'
    + 'location: http://127.0.0.1:8080/second\r\n'
    + '\r\n'
    + 'HTTP/1.1 200 OK\r\n'
    + 'x-mark: final-hop\r\n'
    + '\r\n',
    'each hop appears once, ordered by arrival',
  );
}

// ── header-before-body: the dump lands before the body is drained ─────────────
{
  const order = [];
  const { curl, ctx, files } = makeEnv(['-s', '-D', '/tmp/h', '-o', '/tmp/body.bin', URL], {
    kernel: {
      portRegistry: { get: () => undefined },
      routeLoopback: async () => {
        // Record the explicit drain, not transport-side stream production:
        // a Response may pull eagerly, but Nimbus alone decides when to
        // call arrayBuffer().
        const response = new Response('late-body', {
          status: 200,
          headers: { 'x-mark': 'order-test' },
        });
        const drain = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          order.push('body-drain');
          return drain();
        };
        return response;
      },
    },
    writeFile: (path, data) => {
      if (path === '/tmp/h' && data !== '') order.push('dump-write');
      files[path] = data;
    },
  });
  assert.equal(await curl(ctx), 0);
  assert.deepEqual(order, ['dump-write', 'body-drain'],
    'headers persist before the body is drained');
  assert.equal(new TextDecoder().decode(files['/tmp/body.bin']), 'late-body',
    'the drained body still lands in the output file');
  assert.ok(files['/tmp/h'].endsWith('\r\n\r\n'), 'dump closes with the header terminator');
}

// ── repeated Set-Cookie fields survive as separate ordered lines ──────────────
{
  const cookies = new Headers([
    ['set-cookie', 'sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT'],
    ['set-cookie', 'theme=dark'],
  ]);
  const { curl, ctx, files } = makeEnv(['-s', '-D', '/tmp/h', '-o', '/dev/null', URL], {
    kernel: {
      portRegistry: { get: () => undefined },
      routeLoopback: async () => new Response('cookie-body', { status: 200, headers: cookies }),
    },
  });
  assert.equal(await curl(ctx), 0);
  const cookieLines = files['/tmp/h'].split('\r\n').filter((line) => line.startsWith('set-cookie:'));
  assert.deepEqual(cookieLines, [
    'set-cookie: sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    'set-cookie: theme=dark',
  ], 'both fields kept whole and in arrival order — the comma never splits a field');
}

// ── manual redirect walk (-L with -D): node-style method/body semantics ───────
const START = 'http://ext.test/start';

function twoHopKernel(log) {
  return {
    portRegistry: { get: () => (req, res) => {
      log.push(req.url);
      if (req.url === '/first') {
        res.statusCode = 302;
        res.headers.location = `${URL}second`;
      } else {
        res.statusCode = 200;
        res.headers['x-mark'] = 'final-hop';
        res.body = 'landing';
      }
    } },
  };
}

function withMockFetch(script) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: typeof input === 'string' ? input : input.url ?? String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? null,
      body: init?.body,
    });
    const step = script.shift();
    if (!step) throw new Error(`unexpected extra fetch: ${calls.at(-1).url}`);
    const res = new Response(step.body ?? '', { status: step.status ?? 200, headers: step.headers ?? {} });
    if (step.url) Object.defineProperty(res, 'url', { value: step.url });
    return res;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const postedArgs = (extra = []) => [
  '-s', '-L', '-D', '/tmp/h', '-o', '/dev/null',
  '--data', 'a=1', ...extra, START,
];

{
  // 301/302 collapse only POST; credentials survive a same-origin hop.
  const mock = withMockFetch([
    { status: 302, headers: { location: '/landed' } },
    { status: 200, body: 'ok' },
  ]);
  try {
    const { curl, ctx, files } = makeEnv(
      postedArgs(['-H', 'authorization: Bearer t', '-H', 'content-type: application/json']),
      { kernel: {} },
    );
    assert.equal(await curl(ctx), 0);
    assert.equal(mock.calls[0].method, 'POST');
    assert.equal(mock.calls[1].method, 'GET', '302 rewrites POST to GET');
    assert.equal(mock.calls[1].body, undefined, 'the form body does not follow a GET rewrite');
    const sent = new Headers(mock.calls[1].headers);
    assert.equal(sent.get('authorization'), 'Bearer t', 'same-origin keeps credentials');
    assert.equal(sent.get('content-type'), null, 'content headers leave with the body');
    assert.match(files['/tmp/h'], /HTTP\/1\.1 302\r\n[\s\S]*HTTP\/1\.1 200\r\n/, 'every hop dumped in order');
  } finally { mock.restore(); }
}

{
  // 303 collapses everything except HEAD.
  const mock = withMockFetch([
    { status: 303, headers: { location: '/see-other' } },
    { status: 200, body: 'ok' },
  ]);
  try {
    const { curl, ctx } = makeEnv(postedArgs(), { kernel: {} });
    assert.equal(await curl(ctx), 0);
    assert.equal(mock.calls[1].method, 'GET', '303 rewrites POST to GET');
    assert.equal(mock.calls[1].body, undefined, '303 drops the body');
  } finally { mock.restore(); }
}

{
  // HEAD survives a 303 untouched.
  const mock = withMockFetch([
    { status: 303, headers: { location: '/keep-head' } },
    { status: 200, body: '' },
  ]);
  try {
    const { curl, ctx } = makeEnv(['-sI', '-L', '-D', '/tmp/h', '-o', '/dev/null', START], { kernel: {} });
    assert.equal(await curl(ctx), 0);
    assert.equal(mock.calls[0].method, 'HEAD');
    assert.equal(mock.calls[1].method, 'HEAD', '303 never rewrites HEAD');
  } finally { mock.restore(); }
}

{
  // 301 rewrites only POST — a PUT keeps its method, body, and content headers.
  const mock = withMockFetch([
    { status: 301, headers: { location: '/moved' } },
    { status: 200, body: 'ok' },
  ]);
  try {
    const { curl, ctx, files } = makeEnv(
      ['-s', '-L', '-D', '/tmp/h', '-X', 'PUT', '--data', 'a=1', '-H', 'content-type: text/plain', '-o', '/dev/null', START],
      { kernel: {} },
    );
    assert.equal(await curl(ctx), 0);
    assert.equal(mock.calls[1].method, 'PUT', '301 leaves non-POST methods alone');
    assert.equal(mock.calls[1].body, 'a=1', 'the PUT body survives');
    const sent = new Headers(mock.calls[1].headers);
    assert.equal(sent.get('content-type'), 'text/plain', 'content headers stay while the body stays');
    assert.match(files['/tmp/h'], /HTTP\/1\.1 301\r\n[\s\S]*HTTP\/1\.1 200\r\n/,
      'every hop dumped in order');
  } finally { mock.restore(); }
}

{
  // 307 preserves both.
  const mock = withMockFetch([
    { status: 307, headers: { location: '/temporary' } },
    { status: 200, body: 'ok' },
  ]);
  try {
    const { curl, ctx } = makeEnv(postedArgs(), { kernel: {} });
    assert.equal(await curl(ctx), 0);
    assert.equal(mock.calls[1].method, 'POST', '307 preserves the method');
    assert.equal(mock.calls[1].body, 'a=1', '307 preserves the body');
  } finally { mock.restore(); }
}

{
  // Cross-origin hops drop credential and content headers together.
  const mock = withMockFetch([
    { status: 301, headers: { location: 'http://other.test/land' } },
    { status: 200, body: 'ok' },
  ]);
  try {
    const { curl, ctx } = makeEnv(
      postedArgs(['-H', 'authorization: Bearer t', '-H', 'cookie: k=v']),
      { kernel: {} },
    );
    assert.equal(await curl(ctx), 0);
    // Full stripping leaves no request headers, so the walk sends `undefined`
    // and Bun 1.4's Headers(undefined) throws — normalize the recorded null.
    const sent = new Headers(mock.calls[1].headers ?? {});
    assert.equal(new globalThis.URL(mock.calls[1].url).host, 'other.test', 'the walk crossed origins');
    assert.equal(sent.get('authorization'), null, 'credentials never cross origins');
    assert.equal(sent.get('cookie'), null, 'cookies never cross origins');
    assert.equal(sent.get('content-type'), null, 'body dropped on the GET rewrite');
  } finally { mock.restore(); }
}

{
  // Cap exceeded: curl's own error, not a hang or a silent stop.
  const mock = withMockFetch(
    Array.from({ length: 21 }, (_, i) => ({ status: 302, headers: { location: `/r${i}` } })),
  );
  try {
    const { curl, ctx, out } = makeEnv(['-s', '-L', '-D', '-', '-o', '/dev/null', START], { kernel: {} });
    assert.equal(await curl(ctx), 47);
    assert.equal(mock.calls.length, 21, 'the walk stops at the 20-follow cap');
    assert.match(
      out.filter(([ch]) => ch === 'err').map(([, s]) => s).join(''),
      /curl: \(47\) Maximum \(20\) redirects followed/,
    );
  } finally { mock.restore(); }
}

// ── native follow (no -D): %{url_effective} names the landed URL ──────────────
{
  // Real fetch hands back only the final response, carrying the post-redirect
  // URL in response.url; the native path must surface it, not the typed URL.
  const mock = withMockFetch([{ status: 200, body: 'ok', url: `${START}landed` }]);
  try {
    const { curl, ctx, out } = makeEnv(
      ['-s', '-L', '-o', '/dev/null', '-w', '%{url_effective}', `${START}gone`],
      { kernel: {} },
    );
    assert.equal(await curl(ctx), 0);
    assert.equal(mock.calls[0].url, `${START}gone`);
    assert.equal(
      out.filter(([ch]) => ch === 'out').map(([, s]) => s).join(''),
      `${START}landed`,
      '%{url_effective} follows response.url past the typed URL',
    );
  } finally { mock.restore(); }
}

{
  // Without response.url the effective URL falls back to what was requested.
  const mock = withMockFetch([{ status: 200, body: 'ok' }]);
  try {
    const { curl, ctx, out } = makeEnv(['-s', '-o', '/dev/null', '-w', '%{url_effective}', START], { kernel: {} });
    assert.equal(await curl(ctx), 0);
    assert.equal(
      out.filter(([ch]) => ch === 'out').map(([, s]) => s).join(''),
      START,
      'an unreported response URL falls back to the request URL',
    );
  } finally { mock.restore(); }
}

console.log('ok - curl-dump-header');
