#!/usr/bin/env bun
// cli-session-new — `nimbus session new` sends the token ONLY as an
// Authorization: Bearer header and prints the server-returned attach URL
// verbatim (which carries the server-minted bootstrap token on enforced
// deployments). The caller's long-lived token never appears in any URL.

import assert from 'node:assert/strict';
import { newSession } from '../../packages/cli/src/commands/session.ts';

async function captureSessionNew(args, options = {}) {
  const oldFetch = globalThis.fetch;
  const oldStdoutWrite = process.stdout.write;
  const oldStderrWrite = process.stderr.write;
  const oldEndpoint = process.env.NIMBUS_ENDPOINT;
  const oldToken = process.env.NIMBUS_TOKEN;

  let stdout = '';
  let stderr = '';
  const calls = [];

  if ('endpoint' in options) process.env.NIMBUS_ENDPOINT = options.endpoint;
  else delete process.env.NIMBUS_ENDPOINT;
  if ('token' in options) process.env.NIMBUS_TOKEN = options.token;
  else delete process.env.NIMBUS_TOKEN;

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(null, {
      status: options.status ?? 302,
      headers: options.location !== null
        ? { Location: options.location ?? '/s/calm-otter-1234/' }
        : {},
    });
  };
  process.stdout.write = (chunk) => { stdout += String(chunk); return true; };
  process.stderr.write = (chunk) => { stderr += String(chunk); return true; };

  try {
    const code = await newSession(args);
    return { code, stdout, stderr, calls };
  } finally {
    globalThis.fetch = oldFetch;
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
    if (oldEndpoint === undefined) delete process.env.NIMBUS_ENDPOINT;
    else process.env.NIMBUS_ENDPOINT = oldEndpoint;
    if (oldToken === undefined) delete process.env.NIMBUS_TOKEN;
    else process.env.NIMBUS_TOKEN = oldToken;
  }
}

// Authenticated: Bearer header only; printed URL is the server's bootstrap
// attach URL, never the caller's token.
{
  const result = await captureSessionNew([
    '--endpoint', 'https://nimbus.example.com',
    '--token', 'cli-token',
  ], {
    location: '/s/calm-otter-1234/?nimbus_token=server-bootstrap-jwt',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.calls[0].url, 'https://nimbus.example.com/new');
  assert.equal(result.calls[0].init.method, 'POST');
  assert.equal(new Headers(result.calls[0].init.headers).get('Authorization'), 'Bearer cli-token');

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sessionId, 'calm-otter-1234');
  const attachUrl = new URL(payload.url);
  assert.equal(attachUrl.origin, 'https://nimbus.example.com');
  assert.equal(attachUrl.pathname, '/s/calm-otter-1234/');
  assert.equal(attachUrl.searchParams.get('nimbus_token'), 'server-bootstrap-jwt');
  assert.ok(!payload.url.includes('cli-token'), 'caller token must never appear in the URL');
}

// NIMBUS_TOKEN env var behaves like --token.
{
  const result = await captureSessionNew(['--endpoint', 'https://nimbus.example.com'], {
    token: 'env-token',
    location: '/s/calm-otter-1234/?nimbus_token=server-bootstrap-jwt',
  });
  assert.equal(result.code, 0);
  assert.equal(new Headers(result.calls[0].init.headers).get('Authorization'), 'Bearer env-token');
  const url = JSON.parse(result.stdout).url;
  assert.equal(new URL(url).searchParams.get('nimbus_token'), 'server-bootstrap-jwt');
  assert.ok(!url.includes('env-token'), 'env token must never appear in the URL');
}

// Unauthenticated/self-host: no Authorization header, clean attach URL.
{
  const result = await captureSessionNew(['--endpoint', 'https://nimbus.example.com']);
  assert.equal(result.code, 0);
  assert.equal(result.calls[0].init.headers, undefined);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sessionId, 'calm-otter-1234');
  assert.equal(payload.url, 'https://nimbus.example.com/s/calm-otter-1234/');
}

// Missing Location → loud failure, exit 70.
{
  const result = await captureSessionNew(['--endpoint', 'https://nimbus.example.com'], {
    location: null,
    status: 401,
  });
  assert.equal(result.code, 70);
  assert.match(result.stderr, /no Location \(status 401\)/);
  assert.equal(result.stdout, '');
}

// Unparseable Location → loud failure, exit 70.
{
  const result = await captureSessionNew(['--endpoint', 'https://nimbus.example.com'], {
    location: '/elsewhere',
  });
  assert.equal(result.code, 70);
  assert.match(result.stderr, /unexpected Location/);
  assert.equal(result.stdout, '');
}

console.log('cli-session-new: ok');
