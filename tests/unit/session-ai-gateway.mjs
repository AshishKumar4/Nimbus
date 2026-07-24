#!/usr/bin/env bun
// Session AI gateway — the one model-access path (packages/worker/src/session/ai.ts).
//
// Behaviour pinned here, through the module's public surface only:
//
//   1. Credential precedence: session credential → owner token → an actionable
//      "not connected" answer. Owner token is ignored when the deployment
//      requires per-user OAuth.
//   2. The raw access token is never in a response the sandbox can see; it only
//      ever appears in the upstream Authorization header.
//   3. GET /v1/models is synthesised from the account's catalogue (Cloudflare
//      has no models endpoint), paginated, never hardcoded, default first.
//   4. Streaming bodies pass through un-buffered.
//   5. Cloudflare's error envelope is translated into OpenAI's, in all three
//      shapes Cloudflare can emit.
//   6. An unconnected session answers 503 in OpenAI's error shape with a
//      message that says what to do.
//   7. Expiring credentials refresh once; a failed refresh drops the credential
//      rather than wedging every later request.
//   8. Cookie capture is idempotent and does not clobber a chosen account.
//   9. `/v1/v1/models` (client appends its own /v1) routes like `/v1/models`.

import assert from 'node:assert/strict';
import {
  captureSessionAiCredential,
  clearSessionAiCredential,
  handleSessionAiRequest,
  resolveSessionAiCredential,
  sessionAiEnv,
  sessionAiBaseUrl,
  setSessionAiAccount,
  storeSessionAiCredential,
  SESSION_AI_CREDENTIAL_KEY,
  SESSION_AI_PLACEHOLDER_KEY,
} from '../../packages/worker/src/session/ai.ts';
import { createNimbusAgentOAuthCookie } from '../../packages/worker/src/session/agent-oauth.ts';
import { NIMBUS_AI_GATEWAY_PORT } from '../../packages/worker/src/constants.ts';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';
const OTHER_ACCOUNT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SECRET = 'test-secret-value-of-at-least-32-characters';

function makeHost(env = {}) {
  const store = new Map();
  return {
    env: { NIMBUS_AGENT_COOKIE_SECRET: SECRET, ...env },
    ctx: {
      storage: {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
      },
    },
    _store: store,
  };
}

// Records every upstream call so assertions can inspect what Cloudflare saw.
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function modelsPayload(names) {
  return {
    success: true,
    result: names.map((name, i) => ({
      id: `id-${i}`,
      name,
      description: 'a model',
      task: { name: 'Text Generation' },
      created_at: '2025-08-05 10:27:29.131',
    })),
  };
}

const req = (path, init) => new Request(`http://127.0.0.1:${NIMBUS_AI_GATEWAY_PORT}${path}`, init);

// ── 1. Credential precedence ──────────────────────────────────────────────

{
  const host = makeHost();
  const resolution = await resolveSessionAiCredential(host);
  assert.equal(resolution.ok, false);
  assert.equal(resolution.reason.code, 'E_AI_NOT_CONNECTED');
  // Actionable: names the thing to do, not just the failure.
  assert.match(resolution.reason.message, /connect Cloudflare/i);
}

{
  const host = makeHost({
    NIMBUS_CLOUDFLARE_API_TOKEN: 'owner-token',
    NIMBUS_CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  });
  const resolution = await resolveSessionAiCredential(host);
  assert.equal(resolution.ok, true);
  assert.equal(resolution.credential.source, 'owner-token');
  assert.equal(resolution.credential.accountId, ACCOUNT);
}

{
  // A deployment that requires per-user OAuth must not silently spend the
  // owner's quota (this is prod's configuration).
  const host = makeHost({
    NIMBUS_CLOUDFLARE_API_TOKEN: 'owner-token',
    NIMBUS_CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    NIMBUS_AGENT_REQUIRE_USER_OAUTH: '1',
  });
  const resolution = await resolveSessionAiCredential(host);
  assert.equal(resolution.ok, false);
  assert.equal(resolution.reason.code, 'E_AI_NOT_CONNECTED');
}

{
  // The session's own credential outranks a configured owner token.
  const host = makeHost({
    NIMBUS_CLOUDFLARE_API_TOKEN: 'owner-token',
    NIMBUS_CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT,
  });
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  const resolution = await resolveSessionAiCredential(host);
  assert.equal(resolution.credential.source, 'session');
  assert.equal(resolution.credential.accountId, ACCOUNT);
}

{
  // Connected but no account picked is a distinct, separately actionable state.
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: null, expiresAt: null,
  });
  const resolution = await resolveSessionAiCredential(host);
  assert.equal(resolution.ok, false);
  assert.equal(resolution.reason.code, 'E_AI_NO_ACCOUNT');
}

// ── 2. Unconnected sessions answer in a shape OpenAI clients can read ─────

{
  const host = makeHost();
  const response = await handleSessionAiRequest(host, req('/v1/models'));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.error.code, 'E_AI_NOT_CONNECTED');
  assert.match(body.error.message, /connect Cloudflare/i);
  // Not the Cloudflare envelope, which a client cannot parse.
  assert.equal(body.errors, undefined);
  assert.equal(body.success, undefined);
}

// ── 3. GET /v1/models is the account's catalogue ──────────────────────────

{
  const host = makeHost({ NIMBUS_AGENT_MODEL: '@cf/zai-org/glm-5.2' });
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  // Two pages: a full page forces a second fetch, a short page stops it.
  const firstPage = Array.from({ length: 50 }, (_, i) => `@cf/vendor/model-${i}`);
  const stub = stubFetch(async (url) => {
    const page = new URL(url).searchParams.get('page');
    return Response.json(modelsPayload(page === '1' ? firstPage : ['@cf/zai-org/glm-5.2']));
  });
  try {
    const response = await handleSessionAiRequest(host, req('/v1/models'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 51);
    // The configured default is first, so a client that takes data[0] gets it.
    assert.equal(body.data[0].id, '@cf/zai-org/glm-5.2');
    assert.equal(body.data[0].object, 'model');
    assert.equal(body.data[0].owned_by, 'cloudflare');
    assert.ok(body.data.some((m) => m.id === '@cf/vendor/model-7'));

    // Enumerated from the account, with the credential attached upstream.
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls[0].url.includes(`/accounts/${ACCOUNT}/ai/models/search`));
    assert.ok(stub.calls[0].url.includes('task=Text+Generation'));
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer session-token');

    // Serialized body must not carry the token anywhere.
    assert.ok(!JSON.stringify(body).includes('session-token'));
  } finally {
    stub.restore();
  }
}

// ── 9. Path normalization: a client that appends its own /v1 still lands ──

{
  // A different account than the catalogue test above, so this exercises a
  // real fetch rather than that account's cached catalogue.
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: OTHER_ACCOUNT, expiresAt: null,
  });
  const stub = stubFetch(async () => Response.json(modelsPayload(['@cf/a/b'])));
  try {
    const response = await handleSessionAiRequest(host, req('/v1/v1/models'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 1);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
}

{
  // The catalogue is cached per account for a short window, so a tool that
  // lists models on every launch does not re-enumerate on every call.
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: OTHER_ACCOUNT, expiresAt: null,
  });
  const stub = stubFetch(async () => { throw new Error('should be served from cache'); });
  try {
    const response = await handleSessionAiRequest(host, req('/v1/models'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].id, '@cf/a/b');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
}

{
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  const response = await handleSessionAiRequest(host, req('/v1/nope'));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error.message, /no such endpoint/i);
}

// ── 4. Chat completions: credential attached, gateway named, stream intact ─

{
  const host = makeHost({ NIMBUS_AGENT_GATEWAY_ID: 'nimbus-gw' });
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  const stub = stubFetch(async () => Response.json({
    id: 'id-1', object: 'chat.completion', choices: [{ message: { content: 'hi' } }],
  }));
  try {
    const response = await handleSessionAiRequest(host, req('/v1/chat/completions', {
      method: 'POST',
      // A client-supplied Authorization must never reach Cloudflare.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION_AI_PLACEHOLDER_KEY}` },
      body: JSON.stringify({ model: '@cf/a/b', messages: [{ role: 'user', content: 'hi' }] }),
    }));
    assert.equal(response.status, 200);
    const call = stub.calls[0];
    assert.ok(call.url.endsWith(`/accounts/${ACCOUNT}/ai/v1/chat/completions`));
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer session-token');
    // Workers AI requests always require a gateway id.
    assert.equal(headers.get('cf-aig-gateway-id'), 'nimbus-gw');
  } finally {
    stub.restore();
  }
}

{
  // SSE must arrive incrementally: the gateway hands back the upstream stream
  // rather than reading it to completion first.
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const upstream = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      await gate;
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const stub = stubFetch(async () => new Response(upstream, {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  try {
    const response = await handleSessionAiRequest(host, req('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: '@cf/a/b', stream: true }),
    }));
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
    const reader = response.body.getReader();
    // First chunk is readable while the upstream is still open — that is the
    // whole point; a buffering proxy would block here forever.
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"content":"a"/);
    release();
    const second = await reader.read();
    assert.match(new TextDecoder().decode(second.value), /\[DONE\]/);
  } finally {
    stub.restore();
  }
}

{
  // Regression: the caller's abort must reach Cloudflare. Without this a
  // client that stops mid-stream (the agent's Stop button) leaves the upstream
  // turn running and billing, and the turn never settles as interrupted.
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  const stub = stubFetch(async () => Response.json({ ok: true }));
  const controller = new AbortController();
  try {
    await handleSessionAiRequest(host, req('/v1/chat/completions', {
      method: 'POST', body: '{}', signal: controller.signal,
    }));
    const upstreamSignal = stub.calls[0].init.signal;
    assert.ok(upstreamSignal, 'upstream request must carry an abort signal');
    assert.equal(upstreamSignal.aborted, false);
    controller.abort();
    assert.equal(upstreamSignal.aborted, true, 'aborting the caller must abort upstream');
  } finally {
    stub.restore();
  }
}

// ── 5. Cloudflare's error envelopes become OpenAI's ───────────────────────

const errorCases = [
  {
    name: 'api frontend',
    status: 401,
    payload: { result: null, success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    expect: /Authentication error/,
  },
  {
    name: 'ai gateway',
    status: 401,
    payload: { success: false, error: [{ code: 2009, message: 'Unauthorized' }], message: 'Unauthorized' },
    expect: /Unauthorized/,
  },
  {
    name: 'openai style',
    status: 400,
    payload: { error: { message: 'model not found', type: 'invalid_request_error' } },
    expect: /model not found/,
  },
];

for (const testCase of errorCases) {
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  const stub = stubFetch(async () => Response.json(testCase.payload, { status: testCase.status }));
  try {
    const response = await handleSessionAiRequest(host, req('/v1/chat/completions', {
      method: 'POST', body: '{}',
    }));
    assert.equal(response.status, testCase.status, testCase.name);
    const body = await response.json();
    assert.equal(typeof body.error.message, 'string', testCase.name);
    assert.match(body.error.message, testCase.expect, testCase.name);
    assert.ok(!JSON.stringify(body).includes('session-token'), testCase.name);
  } finally {
    stub.restore();
  }
}

{
  // A rejected credential should tell the user to reconnect, not print a code.
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'session-token', accountId: ACCOUNT, expiresAt: null,
  });
  const stub = stubFetch(async () => Response.json(
    { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    { status: 401 },
  ));
  try {
    const response = await handleSessionAiRequest(host, req('/v1/chat/completions', { method: 'POST', body: '{}' }));
    assert.match((await response.json()).error.message, /reconnect cloudflare/i);
  } finally {
    stub.restore();
  }
}

// ── 7. Refresh ────────────────────────────────────────────────────────────

{
  const host = makeHost({ NIMBUS_CF_OAUTH_CLIENT_ID: 'client-id' });
  await storeSessionAiCredential(host, {
    accessToken: 'stale-token',
    refreshToken: 'refresh-token',
    accountId: ACCOUNT,
    expiresAt: Date.now() + 1000, // inside the refresh skew
  });
  const stub = stubFetch(async () => Response.json({
    access_token: 'fresh-token', refresh_token: 'next-refresh', expires_in: 3600,
  }));
  try {
    const resolution = await resolveSessionAiCredential(host);
    assert.equal(resolution.credential.accessToken, 'fresh-token');
    assert.ok(stub.calls[0].url.includes('oauth2/token'));
    // Persisted, so the next request does not refresh again.
    const stored = host._store.get(SESSION_AI_CREDENTIAL_KEY);
    assert.equal(stored.accessToken, 'fresh-token');
    assert.equal(stored.refreshToken, 'next-refresh');
    assert.ok(stored.expiresAt > Date.now() + 3_000_000);
  } finally {
    stub.restore();
  }
  // Second resolve does not hit the network at all.
  const stub2 = stubFetch(async () => { throw new Error('should not refresh again'); });
  try {
    const again = await resolveSessionAiCredential(host);
    assert.equal(again.credential.accessToken, 'fresh-token');
    assert.equal(stub2.calls.length, 0);
  } finally {
    stub2.restore();
  }
}

{
  // A refresh that fails means the grant is gone: drop it and report the
  // actionable state, rather than retrying forever with a dead token.
  const host = makeHost({ NIMBUS_CF_OAUTH_CLIENT_ID: 'client-id' });
  await storeSessionAiCredential(host, {
    accessToken: 'stale-token',
    refreshToken: 'refresh-token',
    accountId: ACCOUNT,
    expiresAt: Date.now() + 1000,
  });
  const stub = stubFetch(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  try {
    const resolution = await resolveSessionAiCredential(host);
    assert.equal(resolution.ok, false);
    assert.equal(resolution.reason.code, 'E_AI_NOT_CONNECTED');
    assert.equal(host._store.get(SESSION_AI_CREDENTIAL_KEY), undefined);
  } finally {
    stub.restore();
  }
}

{
  // Expired with no refresh token: same disposal, no network call.
  const host = makeHost();
  await storeSessionAiCredential(host, {
    accessToken: 'stale-token', accountId: ACCOUNT, expiresAt: Date.now() - 1000,
  });
  const resolution = await resolveSessionAiCredential(host);
  assert.equal(resolution.ok, false);
  assert.equal(host._store.get(SESSION_AI_CREDENTIAL_KEY), undefined);
}

// ── 8. Capturing the credential the browser carries ───────────────────────

async function cookieRequest(sessionId, auth) {
  const cookie = await createNimbusAgentOAuthCookie(auth, SECRET, `/s/${sessionId}`);
  return new Request(`https://example.test/s/${sessionId}/api/agent/status`, {
    headers: {
      Cookie: cookie.split(';')[0],
      'X-Nimbus-Base': `/s/${sessionId}`,
      'X-Nimbus-Tenant': auth.tenantSegment,
    },
  });
}

const baseAuth = {
  mode: 'oauth',
  accessToken: 'cookie-token',
  refreshToken: 'cookie-refresh',
  tokenType: 'Bearer',
  expiresAt: null,
  connectedAt: Date.now(),
  accountId: ACCOUNT,
  sessionId: 'nimble-otter-4271',
  tenantSegment: 'legacy:public:_',
};

{
  const host = makeHost();
  await captureSessionAiCredential(host, await cookieRequest('nimble-otter-4271', baseAuth));
  const resolution = await resolveSessionAiCredential(host);
  assert.equal(resolution.ok, true);
  assert.equal(resolution.credential.accessToken, 'cookie-token');
  assert.equal(resolution.credential.accountId, ACCOUNT);
}

{
  // A picked account survives re-presentation of the same cookie, and a later
  // cookie carrying a newer token.
  const host = makeHost();
  await captureSessionAiCredential(host, await cookieRequest('nimble-otter-4271', baseAuth));
  await setSessionAiAccount(host, OTHER_ACCOUNT);

  await captureSessionAiCredential(host, await cookieRequest('nimble-otter-4271', baseAuth));
  assert.equal(host._store.get(SESSION_AI_CREDENTIAL_KEY).accountId, OTHER_ACCOUNT);

  await captureSessionAiCredential(host, await cookieRequest('nimble-otter-4271', {
    ...baseAuth, accessToken: 'rotated-token',
  }));
  const stored = host._store.get(SESSION_AI_CREDENTIAL_KEY);
  assert.equal(stored.accessToken, 'rotated-token');
  assert.equal(stored.accountId, OTHER_ACCOUNT);
}

{
  // A cookie minted for another session must not seed this one.
  const host = makeHost();
  await captureSessionAiCredential(host, await cookieRequest('other-session-1234', baseAuth));
  assert.equal(host._store.get(SESSION_AI_CREDENTIAL_KEY), undefined);
}

{
  // No cookie, nothing stored, nothing thrown.
  const host = makeHost();
  await captureSessionAiCredential(host, new Request('https://example.test/s/x/index.html'));
  assert.equal(host._store.get(SESSION_AI_CREDENTIAL_KEY), undefined);
}

{
  const host = makeHost();
  await captureSessionAiCredential(host, await cookieRequest('nimble-otter-4271', baseAuth));
  await clearSessionAiCredential(host);
  assert.equal(host._store.get(SESSION_AI_CREDENTIAL_KEY), undefined);
  // Logout must stick even though the browser still holds the cookie.
  await captureSessionAiCredential(host, await cookieRequest('nimble-otter-4271', baseAuth));
  assert.equal(host._store.get(SESSION_AI_CREDENTIAL_KEY)?.accessToken, 'cookie-token');
}

// ── The seeded environment ────────────────────────────────────────────────

{
  const env = sessionAiEnv();
  assert.equal(env.OPENAI_BASE_URL, `http://127.0.0.1:${NIMBUS_AI_GATEWAY_PORT}/v1`);
  assert.equal(env.OPENAI_BASE_URL, sessionAiBaseUrl());
  assert.equal(env.OPENAI_API_BASE, env.OPENAI_BASE_URL);
  // A placeholder, so an env dump inside the sandbox reveals nothing.
  assert.equal(env.OPENAI_API_KEY, SESSION_AI_PLACEHOLDER_KEY);
  assert.ok(!/[A-Za-z0-9_-]{40,}/.test(env.OPENAI_API_KEY));
}

console.log('session-ai-gateway: all assertions passed');
