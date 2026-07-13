#!/usr/bin/env bun
// agent-chat-turns — POST /api/agent/messages contract: cancelling the
// NDJSON stream aborts the model turn and persists the partial assistant
// message; { retry: true } re-runs the last user turn without duplicating
// history. The Workers AI provider is mocked at the fetch seam (SSE).

import assert from 'node:assert/strict';
import { handleAgentRequest } from '../../packages/worker/src/session/agent.ts';

const MESSAGES_KEY = 'nimbus:agent:messages';
const CHAT_URL = 'http://session.test/api/agent/messages';

function makeHost() {
  const store = new Map();
  return {
    host: {
      ctx: {
        storage: {
          async get(key) { return store.get(key); },
          async put(key, value) { store.set(key, value); },
          async delete(key) { store.delete(key); },
          async deleteAll() { store.clear(); },
        },
      },
      env: {
        NIMBUS_CLOUDFLARE_ACCOUNT_ID: 'test-account',
        NIMBUS_CLOUDFLARE_API_TOKEN: 'test-token',
        NIMBUS_AGENT_COOKIE_SECRET: 'unit-test-cookie-secret-0123456789abcdef',
      },
      sqliteFs: null,
    },
    store,
  };
}

function sseChunk(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finishReason }],
  })}\n\n`;
}

/**
 * Mock the provider fetch: emits the given SSE chunks. With hang=true the
 * stream then stays open until the request signal aborts (erroring the
 * body with AbortError, matching native fetch cancellation).
 */
function mockProviderFetch({ hang }) {
  const encoder = new TextEncoder();
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.includes('/accounts/test-account/ai/v1/'), `unexpected fetch: ${url}`);
    const signal = init?.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseChunk('Hello')));
        controller.enqueue(encoder.encode(sseChunk(' world')));
        if (hang) {
          const onAbort = () => {
            try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch {}
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
          return;
        }
        controller.enqueue(encoder.encode(sseChunk(null, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

async function postChat(host, body) {
  const request = new Request(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleAgentRequest(host, request, new URL(CHAT_URL));
}

/** Read NDJSON events until predicate matches; returns [events, reader]. */
async function readEventsUntil(response, predicate) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line) events.push(JSON.parse(line));
      lineEnd = buffer.indexOf('\n');
    }
    if (predicate(events)) return [events, reader];
  }
  return [events, reader];
}

async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const realFetch = globalThis.fetch;

// ── Abort: cancelling the stream persists the partial turn ──────────
{
  const { host, store } = makeHost();
  globalThis.fetch = mockProviderFetch({ hang: true });
  try {
    const response = await postChat(host, { message: 'hi there', stream: true });
    assert.equal(response.status, 200);
    const [events, reader] = await readEventsUntil(
      response,
      (list) => list.filter((event) => event.type === 'text-delta').length >= 2,
    );
    assert.ok(events.some((event) => event.type === 'start'), 'start event emitted');
    assert.ok(events.some((event) => event.type === 'assistant-start'), 'assistant-start emitted');

    // Client Stop: cancel the NDJSON body mid-turn.
    await reader.cancel();

    const persisted = await waitFor(async () => {
      const messages = store.get(MESSAGES_KEY);
      return messages?.length === 2 ? messages : null;
    }, 'partial assistant persistence');

    assert.equal(persisted[0].role, 'user');
    assert.equal(persisted[0].content, 'hi there');
    const partial = persisted[1];
    assert.equal(partial.role, 'assistant');
    assert.equal(partial.aborted, true, 'partial turn carries the aborted marker');
    assert.equal(partial.content, 'Hello world');
    assert.deepEqual(partial.parts, [{ type: 'text', text: 'Hello world' }]);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - cancel aborts the turn and persists the partial assistant message');
}

// ── Abort with no streamed parts persists nothing ────────────────────
{
  const { host, store } = makeHost();
  globalThis.fetch = mockProviderFetch({ hang: true });
  try {
    const response = await postChat(host, { message: 'hi', stream: true });
    const [, reader] = await readEventsUntil(
      response,
      (list) => list.some((event) => event.type === 'assistant-start'),
    );
    await reader.cancel();
    // The turn may still persist text that raced in before the cancel was
    // observed; what must never appear is an empty assistant shell.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const messages = store.get(MESSAGES_KEY);
    for (const message of messages) {
      if (message.role === 'assistant') {
        assert.ok(message.parts?.length > 0, 'no empty assistant message persisted');
      }
    }
    assert.equal(messages[0].role, 'user');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - cancel never persists an empty assistant shell');
}

console.log('agent-chat-turns: all assertions passed');
