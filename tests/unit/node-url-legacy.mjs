#!/usr/bin/env bun
// The guest's `url` module answers Node's legacy API as Node does.
//
// Every HTTP server receives a path-only `req.url` ("/hello.txt") and parses
// it with url.parse. The guest's url module imitated the legacy API over
// WHATWG `new URL()`, which throws for a path-only URL, so url.parse returned
// `{ href }` with no pathname. node-static did
// `decodeURI(url.parse(req.url).pathname)`, got "undefined", stat'ed
// "<root>/undefined" and answered 404 for every file it serves. The legacy
// API is now Node's own (workerd's node:url in a facet); these are the calls
// static servers and their frameworks make.
import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

const factory = new Function('__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__pendingIO', 'stdin',
  'let stdout="",stderr="";' + SHIMS_STORE_PRELUDE + generateShimsCode() + ';return builtins;');
const builtins = factory({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/server.js', '/home/user', [], '');
const url = builtins.url;
assert.equal(builtins['node:url'] ?? url, url);

// ── a request's path-only URL ─────────────────────────────────────────────
{
  const parsed = url.parse('/hello.txt');
  assert.equal(parsed.pathname, '/hello.txt', 'the path of a request URL');
  assert.equal(parsed.path, '/hello.txt');
  assert.equal(parsed.search, null);
  assert.equal(decodeURI(url.parse('/sub/Gr%C3%BC%C3%9Fe.txt').pathname), '/sub/Grüße.txt', 'node-static\'s decodeURI(pathname)');
  const query = url.parse('/list?dir=a&n=2#top', true);
  assert.equal(query.pathname, '/list');
  assert.deepEqual({ ...query.query }, { dir: 'a', n: '2' }, 'parseQueryString');
  assert.equal(query.hash, '#top');
  assert.equal(url.parse('/list?dir=a').query, 'dir=a', 'the raw query without parseQueryString');
}

// ── absolute URLs keep every legacy field ───────────────────────────────────
{
  const parsed = url.parse('http://user:pw@example.com:8080/p/a/t/h?query=string#hash');
  assert.equal(parsed.protocol, 'http:');
  assert.equal(parsed.auth, 'user:pw');
  assert.equal(parsed.host, 'example.com:8080');
  assert.equal(parsed.hostname, 'example.com');
  assert.equal(parsed.port, '8080');
  assert.equal(parsed.pathname, '/p/a/t/h');
  assert.equal(parsed.path, '/p/a/t/h?query=string');
  assert.equal(url.parse('//cdn.example.com/x.js', false, true).host, 'cdn.example.com', 'slashesDenoteHost');
  assert.ok(parsed instanceof url.Url, 'a legacy Url');
}

// ── format and resolve are the legacy ones too ──────────────────────────────
{
  assert.equal(url.format({ pathname: '/a b', query: { x: '1' } }), '/a b?x=1', 'a relative object stays relative');
  assert.equal(url.format({ pathname: '/a?b#c' }), '/a%3Fb%23c', 'legacy format escapes only ? and # in a pathname');
  assert.equal(url.format({ protocol: 'https', hostname: 'example.com', pathname: '/x' }), 'https://example.com/x');
  assert.equal(url.format(url.parse('/hello.txt')), '/hello.txt');
  assert.equal(url.resolve('/one/two/three', 'four'), '/one/two/four', 'a path-only base');
  assert.equal(url.resolve('http://example.com/one', '/two'), 'http://example.com/two');
  assert.equal(typeof url.resolveObject, 'function');
}

// ── the guest's own file-URL helpers are kept ───────────────────────────────
assert.equal(url.pathToFileURL('rel/x.js').href, 'file:///home/user/rel/x.js', 'relative to the guest cwd');
assert.equal(url.fileURLToPath('file:///home/user/x.js'), '/home/user/x.js');
assert.equal(url.URL, globalThis.URL);

console.log('node-url-legacy: ok');
