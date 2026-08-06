#!/usr/bin/env bun
// Behavior test: `undici` resolves to Nimbus's platform-HTTP mapping.
//
// undici is Node's reference fetch implementation and a very common transitive
// dependency. Its own implementation needs raw TCP sockets a facet does not
// have, and `undici.install()` REPLACES globalThis.fetch — which both breaks
// fetch outright ("addAbortListenerNative is not a function") and silently
// drops Nimbus's in-session loopback routing and AI-egress mediation, since
// both live on the patched global fetch.
//
// So `require('undici')` must land on the Nimbus module, install() must leave
// the patched fetch in place, loopback and AI mediation must still fire after
// a program installs undici, and anything Nimbus genuinely cannot do must
// throw with the limitation named rather than answer wrongly.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/worker/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { NIMBUS_AI_GATEWAY_PORT } from '../../packages/worker/src/constants.ts';

const AI_TOKEN = 'sk-nimbus-test-token';

/** Boot a facet's shim scope and hand back its require + the routing spies. */
function bootFacet({ env = {}, origin } = {}) {
  const routed = [];
  const supervisor = {
    routeLoopback: (port, request) => {
      routed.push({ port, url: request.url, method: request.method });
      return new Response('served', { status: 200, headers: { 'X-Served-By': 'loopback' } });
    },
  };
  const originCalls = [];
  const previousFetch = globalThis.fetch;
  const previousInstalled = globalThis.__nimbusFetchUaInstalled;
  // Each boot needs its own patch, so clear the once-only guard.
  globalThis.__nimbusFetchUaInstalled = undefined;
  globalThis.fetch = origin || ((input, init) => {
    originCalls.push({ url: typeof input === 'string' ? input : input.url, init });
    return Promise.resolve(new Response('origin', { status: 299 }));
  });

  const factory = new Function(
    '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() + '\n;return __require;',
  );
  const require = factory(
    {}, {}, {}, {}, supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], env, '/home/user/main.mjs', '/home/user',
  );

  return {
    require,
    routed,
    originCalls,
    patchedFetch: globalThis.fetch,
    restore: () => {
      globalThis.fetch = previousFetch;
      globalThis.__nimbusFetchUaInstalled = previousInstalled;
    },
  };
}

// ── the module resolves, and it is Nimbus's, not undici's ────────────────────
{
  const facet = bootFacet();
  const undici = facet.require('undici');
  assert.equal(typeof undici.fetch, 'function', 'undici.fetch is exported');
  assert.equal(typeof undici.install, 'function', 'undici.install is exported');
  assert.equal(typeof undici.request, 'function', 'undici.request is exported');
  assert.equal(undici.fetch, facet.patchedFetch, "undici.fetch IS the facet's patched fetch");
  assert.equal(undici.default, undici, 'default export self-reference for the ESM interop');
  assert.equal(facet.require('undici'), undici, 'the module is stable across requires');

  // It is an npm package, not node core — module.builtinModules must not lie.
  assert.ok(
    !facet.require('module').builtinModules.includes('undici'),
    'undici must not be reported as a node builtin',
  );
  facet.restore();
}

// ── install() does not clobber the patched fetch ─────────────────────────────
{
  const facet = bootFacet();
  const undici = facet.require('undici');
  const before = globalThis.fetch;
  undici.install();
  assert.equal(globalThis.fetch, before, 'install() left the patched global fetch in place');
  assert.equal(globalThis.fetch, facet.patchedFetch, 'the patched fetch is still Nimbus\'s');
  facet.restore();
}

// ── loopback still routes after install() ────────────────────────────────────
{
  const facet = bootFacet();
  const undici = facet.require('undici');
  undici.install();

  const viaGlobal = await globalThis.fetch('http://127.0.0.1:4096/doc');
  assert.equal(viaGlobal.status, 200, 'global fetch reached the in-session port after install()');
  assert.equal(facet.routed.at(-1).port, 4096);

  const viaUndici = await undici.fetch('http://localhost:5173/app');
  assert.equal(viaUndici.status, 200, 'undici.fetch reached the in-session port');
  assert.equal(facet.routed.at(-1).port, 5173);

  const viaRequest = await undici.request('http://127.0.0.1:4096/api');
  assert.equal(viaRequest.statusCode, 200, 'undici.request reached the in-session port');
  assert.equal(await viaRequest.body.text(), 'served');
  assert.equal(facet.routed.at(-1).port, 4096);
  assert.equal(facet.originCalls.length, 0, 'nothing leaked to the real network');
  facet.restore();
}

// ── AI-egress mediation still fires after install() ──────────────────────────
{
  const facet = bootFacet({ env: { NIMBUS_AI_TOKEN: AI_TOKEN } });
  const undici = facet.require('undici');
  undici.install();

  await undici.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${AI_TOKEN}` },
  });
  assert.equal(
    facet.routed.at(-1).port, NIMBUS_AI_GATEWAY_PORT,
    'a request presenting the session AI token was served by the session gateway',
  );

  const mediated = await undici.request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AI_TOKEN },
  });
  assert.equal(mediated.statusCode, 200, 'undici.request is mediated too');
  assert.equal(facet.routed.at(-1).port, NIMBUS_AI_GATEWAY_PORT);

  // Someone else's key is not ours: it goes to that provider, untouched.
  await undici.fetch('https://api.openai.com/v1/models', {
    headers: { authorization: 'Bearer sk-the-users-own-key' },
  });
  assert.equal(facet.originCalls.length, 1, 'a foreign credential was left alone');
  assert.match(facet.originCalls[0].url, /api\.openai\.com/);
  facet.restore();
}

// ── what cannot work throws, naming the limitation ───────────────────────────
{
  const facet = bootFacet();
  const undici = facet.require('undici');

  const named = (fn, api) => {
    let err = null;
    try { fn(); } catch (thrown) { err = thrown; }
    assert.ok(err instanceof Error, `${api} throws rather than answering wrongly`);
    assert.match(err.message, /^Nimbus: undici\./, `${api} throws a Nimbus-attributed error`);
    assert.ok(err.message.includes(api), `${api} error names the API`);
    assert.ok(err.message.length > 80, `${api} error explains the limitation`);
    return err;
  };

  named(() => new undici.ProxyAgent('http://proxy:8080'), 'ProxyAgent');
  named(() => new undici.MockAgent(), 'MockAgent');
  named(() => undici.connect({ origin: 'https://example.com' }), 'connect');
  named(() => undici.upgrade('https://example.com'), 'upgrade');
  named(() => undici.pipeline('https://example.com', {}, () => {}), 'pipeline');
  named(() => undici.interceptors.retry(), 'interceptors.retry');
  named(() => new undici.Agent().dispatch({}, {}), 'Dispatcher.dispatch()');
  named(() => new undici.Agent().compose(), 'Dispatcher.compose()');

  // A dispatcher Nimbus did not create cannot intercept anything, so accepting
  // it would silently send traffic the caller believes it redirected.
  named(() => undici.setGlobalDispatcher({ dispatch() {} }), 'setGlobalDispatcher()');
  assert.throws(
    () => undici.setGlobalDispatcher({}),
    (err) => err.code === 'UND_ERR_INVALID_ARG',
    'a non-dispatcher is rejected with undici\'s own error code',
  );
  facet.restore();
}

// ── inert dispatchers are accepted: they cannot change the answer ────────────
{
  const facet = bootFacet();
  const undici = facet.require('undici');

  const agent = new undici.Agent({ keepAliveTimeout: 10, connections: 4 });
  undici.setGlobalDispatcher(agent);
  assert.equal(undici.getGlobalDispatcher(), agent, 'the dispatcher round-trips');
  assert.equal(
    new undici.Agent().constructor, undici.Agent,
    'the default dispatcher is exactly an Agent (nuxt identity-checks this)',
  );

  const pool = new undici.Pool('http://127.0.0.1:4096');
  const res = await pool.request({ path: '/pooled', method: 'GET' });
  assert.equal(res.statusCode, 200, 'an origin-bound dispatcher resolves paths against its origin');
  assert.equal(new URL(facet.routed.at(-1).url).pathname, '/pooled');
  await pool.close();
  facet.restore();
}

// ── EnvHttpProxyAgent: inert with no proxy set, loud when one is ─────────────
{
  const facet = bootFacet();
  const undici = facet.require('undici');
  const agent = new undici.EnvHttpProxyAgent({ allowH2: false, bodyTimeout: 300000 });
  assert.ok(agent instanceof undici.Dispatcher, 'with no proxy configured it is a direct dispatcher');
  assert.equal(typeof agent.on, 'function', 'dispatchers are EventEmitters (pi attaches an error listener)');
  facet.restore();
}
{
  const facet = bootFacet({ env: { HTTPS_PROXY: 'http://proxy.internal:3128' } });
  const undici = facet.require('undici');
  let err = null;
  try { new undici.EnvHttpProxyAgent(); } catch (thrown) { err = thrown; }
  assert.ok(err instanceof Error, 'a configured proxy fails loud rather than being bypassed');
  assert.match(err.message, /HTTPS_PROXY/, 'the configured proxy variable is named');
  facet.restore();
}

// ── pi's exact boot sequence completes ───────────────────────────────────────
// dist/core/http-dispatcher.js: construct EnvHttpProxyAgent, attach an error
// listener if it is an EventEmitter, install it globally, then install()
// only if nothing else has replaced fetch since module load.
{
  const facet = bootFacet();
  const undici = facet.require('undici');
  const EventEmitter = facet.require('events');
  const originalGlobalFetch = globalThis.fetch;

  const dispatcher = new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: 300000,
    headersTimeout: 300000,
    clientFactory: (origin, opts) => new undici.Client(origin, opts),
    factory: (origin, opts) => new undici.Pool(origin, opts),
  });
  assert.ok(dispatcher instanceof EventEmitter, 'pi checks this before attaching its listener');
  EventEmitter.prototype.on.call(dispatcher, 'error', () => {});
  undici.setGlobalDispatcher(dispatcher);
  if (globalThis.fetch === originalGlobalFetch) undici.install?.();

  assert.equal(globalThis.fetch, originalGlobalFetch, 'pi\'s boot left the patched fetch alone');
  const res = await globalThis.fetch('http://127.0.0.1:3000/health');
  assert.equal(res.status, 200, 'a post-boot fetch still reaches the session');
  facet.restore();
}

// ── request() honours undici's contract, not fetch's defaults ────────────────
{
  const redirects = [];
  const origin = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    redirects.push({ url, redirect: init?.redirect, method: init?.method });
    if (url.endsWith('/hop')) {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: '/landed' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { 'content-type': 'application/json', 'X-Trace': 'yes' },
    }));
  };
  const facet = bootFacet({ origin });
  const undici = facet.require('undici');

  // maxRedirections defaults to 0 — the 3xx is the answer, not a hop.
  const held = await undici.request('https://example.com/hop');
  assert.equal(held.statusCode, 302, 'redirects are NOT followed by default');
  assert.equal(redirects.at(-1).redirect, 'manual', 'the platform is told not to follow either');

  const followed = await undici.request('https://example.com/hop', { maxRedirections: 3 });
  assert.equal(followed.statusCode, 201, 'maxRedirections follows the hop');
  assert.deepEqual(await followed.body.json(), { ok: true });

  const withQuery = await undici.request('https://example.com/search', {
    method: 'POST',
    query: { q: 'nimbus', page: 2 },
    headers: { 'x-custom': 'set' },
    body: 'payload',
  });
  assert.equal(withQuery.statusCode, 201);
  assert.equal(withQuery.headers['x-trace'], 'yes', 'headers come back as a lowercased bag');
  assert.equal(new URL(redirects.at(-1).url).search, '?q=nimbus&page=2');
  assert.equal(redirects.at(-1).method, 'POST');

  // The body is a Node Readable AND carries the WHATWG mixin; one read only.
  const streamed = await undici.request('https://example.com/data');
  const chunks = [];
  for await (const chunk of streamed.body) chunks.push(chunk);
  assert.ok(chunks.length > 0, 'the body is async-iterable like a Readable');

  const once = await undici.request('https://example.com/data');
  assert.equal(await once.body.text(), '{"ok":true}');
  await assert.rejects(() => once.body.text(), TypeError, 'a second read fails like undici\'s');
  facet.restore();
}

// ── throwOnError surfaces the status on the error ────────────────────────────
{
  const facet = bootFacet({
    origin: () => Promise.resolve(new Response('nope', { status: 503 })),
  });
  const undici = facet.require('undici');
  const err = await undici.request('https://example.com/x', { throwOnError: true }).then(
    () => null,
    (e) => e,
  );
  assert.equal(err.statusCode, 503);
  assert.equal(err.code, 'UND_ERR_RESPONSE_STATUS_CODE');
  assert.equal(err.body, 'nope');
  assert.ok(err instanceof undici.errors.UndiciError, 'it is an UndiciError subclass');
  facet.restore();
}

console.log('ok: undici maps onto the platform HTTP stack; install() keeps loopback + AI mediation');
