#!/usr/bin/env bun
// Behavior test: transparent AI-provider mediation.
//
// A tool that ignores OPENAI_BASE_URL and calls its own baked-in vendor host
// still reaches the session's models, because the seeded key is a session
// capability token and egress presenting it is served by the session gateway.
// The two mediators — a facet's patched global fetch and the shell's curl —
// must agree, and both must leave everything else alone: a request carrying a
// user's own real provider key is not ours and goes to that provider.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { createCurlCommand } from '../../packages/worker/src/substrate/lifo/commands/net/curl.ts';
import { handleSessionAiRequest, storeSessionAiCredential } from '../../packages/worker/src/session/ai.ts';
import {
  NIMBUS_AI_TOKEN_ENV,
  mintSessionAiToken,
  requestCarriesSessionAiToken,
} from '../../packages/worker/src/_shared/ai-egress.ts';
import { NIMBUS_AI_GATEWAY_PORT } from '../../packages/worker/src/constants.ts';

const TOKEN = mintSessionAiToken();
const FOREIGN_KEY = 'sk-proj-Aa0000000000000000000000000000000000000000000000';

// ── the policy itself ────────────────────────────────────────────────────────
{
  const h = (init) => new Headers(init);
  assert.equal(requestCarriesSessionAiToken(h({ Authorization: `Bearer ${TOKEN}` }), TOKEN), true);
  assert.equal(requestCarriesSessionAiToken(h({ authorization: `bearer ${TOKEN}` }), TOKEN), true,
    'the Bearer scheme is matched case-insensitively');
  assert.equal(requestCarriesSessionAiToken(h({ Authorization: TOKEN }), TOKEN), true,
    'a bare credential with no scheme still matches');
  assert.equal(requestCarriesSessionAiToken(h({ 'x-api-key': TOKEN }), TOKEN), true,
    'Anthropic-shaped clients carry the credential in x-api-key');
  assert.equal(requestCarriesSessionAiToken(h({ Authorization: `Bearer ${FOREIGN_KEY}` }), TOKEN), false,
    "a user's own provider key is not ours");
  assert.equal(requestCarriesSessionAiToken(h({ Authorization: `Bearer ${TOKEN}` }), ''), false,
    'a session with no token mediates nothing');
  assert.notEqual(mintSessionAiToken(), TOKEN, 'tokens are per session, not a shared constant');
}

// ── the facet's patched fetch ────────────────────────────────────────────────

function installShims(env) {
  // The shim installs its fetch patch once per global; reset the latch so a
  // second environment can be exercised in the same process.
  globalThis.__nimbusFetchUaInstalled = false;
  const routed = [];
  const origin = [];
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
    origin.push({ url, authorization: headers.get('authorization'), apiKey: headers.get('x-api-key') });
    return Promise.resolve(new Response('origin', { status: 299 }));
  };
  const supervisor = {
    routeLoopback: (port, request) => {
      routed.push({ port, url: request.url, method: request.method, headers: request.headers });
      return new Response('gateway', { status: 200, headers: { 'X-Served-By': 'session-ai' } });
    },
  };
  const factory = new Function(
    '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + generateShimsCode() + '\n;return null;',
  );
  factory(
    {}, {}, {}, {}, {}, supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], env, '/home/user/main.mjs', '/home/user',
  );
  return { routed, origin };
}

{
  const { routed, origin } = installShims({ [NIMBUS_AI_TOKEN_ENV]: TOKEN, OPENAI_API_KEY: TOKEN });

  // The whole point: the official OpenAI SDK's DEFAULT base URL, mediated.
  const res = await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '@cf/a/b', messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Served-By'), 'session-ai');
  assert.equal(routed.length, 1, 'the vendor-addressed request was served by the session gateway');
  assert.equal(routed[0].port, NIMBUS_AI_GATEWAY_PORT);
  assert.equal(routed[0].method, 'POST');
  assert.equal(new URL(routed[0].url).pathname, '/v1/chat/completions', 'the path reaches the gateway intact');
  assert.equal(origin.length, 0, 'nothing left the sandbox');

  // Anthropic-shaped clients carry it elsewhere.
  await globalThis.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': TOKEN },
  });
  assert.equal(routed.length, 2, 'x-api-key is a credential carrier too');
  assert.equal(routed[1].port, NIMBUS_AI_GATEWAY_PORT);

  // A Request object, and a foreign key: the fallback that makes host-matching
  // unnecessary. This one is genuinely the user's, so it goes to the user's
  // provider — with their key untouched.
  const passthrough = await globalThis.fetch(new Request('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FOREIGN_KEY}` },
  }));
  assert.equal(passthrough.status, 299, 'a real provider key reaches the real provider');
  assert.equal(routed.length, 2, 'a foreign credential is never mediated');
  assert.equal(origin.at(-1).authorization, `Bearer ${FOREIGN_KEY}`, "the user's key is passed through intact");

  // Unauthenticated egress is ordinary traffic.
  await globalThis.fetch('https://registry.npmjs.org/left-pad');
  assert.equal(routed.length, 2);
  assert.equal(origin.length, 2);

  // Loopback still wins for loopback: a local model server on its own port is
  // reached at that port, not hijacked by the gateway.
  await globalThis.fetch('http://127.0.0.1:11434/v1/chat/completions', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(routed.at(-1).port, 11434, 'an in-session port keeps its traffic');
}

{
  // A session that seeded no token mediates nothing, even for a request that
  // presents what another session's token would have looked like.
  const { routed, origin } = installShims({});
  await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(routed.length, 0);
  assert.equal(origin.length, 1);
}

// ── the shell's curl ─────────────────────────────────────────────────────────

function curlCtx(args, env) {
  const out = [];
  return {
    out,
    ctx: {
      args,
      env,
      cwd: '/home/user',
      vfs: { writeFile: () => { throw new Error('no file output expected'); } },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => out.push('[err]' + s) },
      signal: new AbortController().signal,
    },
  };
}

{
  const routed = [];
  const kernel = {
    portRegistry: { get: () => undefined },
    routeLoopback: async (port, request) => {
      routed.push({ port, url: request.url, authorization: request.headers.get('authorization') });
      return Response.json({ object: 'list', data: [{ id: '@cf/zai-org/glm-5.2' }] });
    },
  };
  const curl = createCurlCommand(kernel);

  const { ctx, out } = curlCtx(
    ['-s', 'https://api.openai.com/v1/models', '-H', `Authorization: Bearer ${TOKEN}`],
    { [NIMBUS_AI_TOKEN_ENV]: TOKEN },
  );
  assert.equal(await curl(ctx), 0);
  assert.equal(routed.length, 1, 'curl to a vendor host with the session key is served by the gateway');
  assert.equal(routed[0].port, NIMBUS_AI_GATEWAY_PORT);
  assert.equal(new URL(routed[0].url).pathname, '/v1/models');
  assert.match(out.join(''), /@cf\/zai-org\/glm-5\.2/, "the session's own models came back");

  // A foreign key goes out to the network, key intact.
  const external = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    external.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    return Promise.resolve(new Response('upstream', { status: 401 }));
  };
  try {
    const foreign = curlCtx(
      ['-s', 'https://api.openai.com/v1/models', '-H', `Authorization: Bearer ${FOREIGN_KEY}`],
      { [NIMBUS_AI_TOKEN_ENV]: TOKEN },
    );
    await curl(foreign.ctx);
    assert.equal(routed.length, 1, 'a foreign credential is never mediated');
    assert.equal(external.length, 1);
    assert.equal(external[0].authorization, `Bearer ${FOREIGN_KEY}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── what the gateway does with mediated traffic ──────────────────────────────

function aiHost(env = {}) {
  const store = new Map();
  return {
    env,
    _store: store,
    ctx: {
      storage: {
        get: async (k) => store.get(k),
        put: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
      },
    },
  };
}

{
  const host = aiHost({ NIMBUS_AGENT_GATEWAY_ID: 'nimbus-gw' });
  await storeSessionAiCredential(host, {
    accessToken: 'cf-real-credential', accountId: 'f44999d1ddda7012e9a87729eba250f1', expiresAt: null,
  });

  // An API this gateway does not speak must fail with a sentence that accounts
  // for where the answer came from — the client believed it was calling OpenAI.
  const unsupported = await handleSessionAiRequest(host, new Request('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: '{}',
  }));
  assert.equal(unsupported.status, 404);
  const error = (await unsupported.json()).error.message;
  assert.match(error, /\/v1\/responses/, 'the endpoint the client actually asked for is named');
  assert.match(error, /chat\/completions/, 'and what this gateway does speak');
  assert.match(error, /whatever host it was addressed to/, 'and why it landed here at all');
  assert.doesNotMatch(error, /cf-real-credential/);

  // The substituted credential goes upstream and nothing comes back down: the
  // session token never reaches Cloudflare, and Cloudflare's does not reach the
  // sandbox in any observable form.
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return Promise.resolve(Response.json({ id: 'x', choices: [{ message: { content: 'hi' } }] }, {
      headers: { 'cf-ray': 'abc', 'x-upstream': 'cloudflare' },
    }));
  };
  try {
    const response = await handleSessionAiRequest(host, new Request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '@cf/a/b', messages: [] }),
    }));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer cf-real-credential',
      'the supervisor substitutes the real credential at the boundary');
    assert.doesNotMatch(calls[0].headers.get('Authorization'), new RegExp(TOKEN),
      'the session token is never forwarded upstream');
    const seen = JSON.stringify([...response.headers]) + await response.text();
    assert.doesNotMatch(seen, /cf-real-credential/, 'the real credential is not observable from the sandbox');
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('session-ai-egress: ok');
