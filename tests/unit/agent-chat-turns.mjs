#!/usr/bin/env bun
// agent-chat-turns — POST /api/agent/messages contract: cancelling the
// NDJSON stream aborts the model turn and persists the partial assistant
// message; { retry: true } re-runs the last user turn without duplicating
// history; turns write their own messages into one conversation, which a
// clear empties for good. The Workers AI provider is mocked at the fetch
// seam (SSE).

import assert from 'node:assert/strict';
import { handleAgentRequest } from '../../packages/worker/src/session/agent.ts';

const MESSAGES_KEY = 'nimbus:agent:messages';
const CHAT_URL = 'http://session.test/api/agent/messages';

function makeHost(initialStore = new Map()) {
  const store = initialStore;
  const writes = [];
  // Keys whose next put is refused, as SQLite refuses a value past its limit
  // (SQLITE_TOOBIG): the whole put fails and writes nothing.
  const refusals = new Set();
  return {
    host: {
      ctx: {
        storage: {
          // As Durable Object storage answers: a copy, never the stored value itself.
          async get(key) { const value = store.get(key); return value === undefined ? undefined : structuredClone(value); },
          // One key and value, or an object of them, put as one.
          async put(key, value) {
            const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key);
            const refused = entries.find(([name]) => refusals.has(name));
            if (refused !== undefined) {
              refusals.delete(refused[0]);
              throw new Error(`string or blob too big: SQLITE_TOOBIG (${refused[0]})`);
            }
            for (const [name, entry] of entries) {
              const snapshot = structuredClone(entry);
              writes.push({ key: name, value: snapshot });
              store.set(name, snapshot);
            }
          },
          async delete(key) { store.delete(key); },
          async deleteAll() { store.clear(); },
        },
      },
      env: {
        NIMBUS_CLOUDFLARE_ACCOUNT_ID: 'test-account',
        NIMBUS_CLOUDFLARE_API_TOKEN: 'test-token',
        NIMBUS_AGENT_COOKIE_SECRET: 'unit-test-cookie-secret-0123456789abcdef',
      },
      shell: {},
      processes: { publishedAll() { return []; } },
      ensureSqliteFs() {},
      ensureFacetManager() {},
      async ensureRuntimeReady() {},
      // No dev servers ran before this incarnation: none to restore.
      async devServersRespawned() {},
      sqliteFs: null,
    },
    store,
    writes,
    refuseNextPut(key) { refusals.add(key); },
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
 * Mock the provider fetch: emits two SSE text chunks, then per mode either
 * completes ('complete'), stays open until the request signal aborts
 * ('hang', erroring the body with AbortError like native fetch
 * cancellation), or errors the body mid-stream ('fail').
 */
function mockProviderFetch(mode = 'complete') {
  const encoder = new TextEncoder();
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.includes('/accounts/test-account/ai/v1/'), `unexpected fetch: ${url}`);
    const signal = init?.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseChunk('Hello')));
        controller.enqueue(encoder.encode(sseChunk(' world')));
        if (mode === 'hang') {
          const onAbort = () => {
            try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch {}
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
          return;
        }
        if (mode === 'fail') {
          // Delay so the queued chunks are consumed first; error() would
          // otherwise discard them before the SSE parser sees them.
          setTimeout(() => {
            try { controller.error(new Error('provider exploded')); } catch {}
          }, 50);
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

function controlledProviderFetch() {
  const encoder = new TextEncoder();
  let bodyController;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.includes('/accounts/test-account/ai/v1/'), `unexpected fetch: ${url}`);
    const signal = init?.signal;
    const body = new ReadableStream({
      start(controller) {
        bodyController = controller;
        const onAbort = () => {
          try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch {}
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        readyResolve();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  return {
    fetch,
    ready,
    emitText(text) { bodyController.enqueue(encoder.encode(sseChunk(text))); },
    finish() {
      bodyController.enqueue(encoder.encode(sseChunk(null, 'stop')));
      bodyController.enqueue(encoder.encode('data: [DONE]\n\n'));
      bodyController.close();
    },
  };
}

/** The model asks for list_processes `toolRounds` times, then answers. */
function toolProviderFetch(toolRounds = 1) {
  const encoder = new TextEncoder();
  let requestCount = 0;
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.includes('/accounts/test-account/ai/v1/'), `unexpected fetch: ${url}`);
    requestCount += 1;
    if (requestCount <= toolRounds) {
      const chunks = [
        {
          id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: 'test-model',
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: `call-list-${requestCount}`,
                type: 'function',
                function: { name: 'list_processes', arguments: '{}' },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
      ];
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseChunk('Processes checked.')));
        controller.enqueue(encoder.encode(sseChunk(null, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

function collectEvents(response) {
  const reader = response.body.getReader();
  const events = [];
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let lineEnd = buffer.indexOf('\n');
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (line) events.push(JSON.parse(line));
        lineEnd = buffer.indexOf('\n');
      }
    }
  })();
  return { reader, events, done };
}

const realFetch = globalThis.fetch;

function rows(messages) {
  return messages.map((m) => `${m.role}:${m.content}`);
}

function assistantWrites(writes) {
  return writes
    .filter((write) => write.key === MESSAGES_KEY)
    .map((write) => write.value.find((message) => message.role === 'assistant'))
    .filter(Boolean);
}

// ── Abort: cancelling the stream persists the partial turn ──────────
{
  const { host, store } = makeHost();
  globalThis.fetch = mockProviderFetch('hang');
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
    assert.equal(partial.status, 'interrupted');
    assert.equal(partial.aborted, true, 'partial turn carries the aborted marker');
    assert.equal(partial.error, undefined, 'a client stop is not a provider error');
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
  globalThis.fetch = mockProviderFetch('hang');
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

// ── Retry: empty history is rejected ─────────────────────────────────
{
  const { host } = makeHost();
  globalThis.fetch = mockProviderFetch();
  try {
    const response = await postChat(host, { retry: true, stream: true });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.code, 'E_AGENT_NOTHING_TO_RETRY');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - retry on empty history returns 400');
}

// ── Retry: history ending in a legacy tool row is rejected ───────────
{
  const { host, store } = makeHost();
  store.set(MESSAGES_KEY, [
    { id: 'u1', role: 'user', content: 'run it', createdAt: 1 },
    { id: 't1', role: 'tool', content: '{}', createdAt: 2 },
  ]);
  globalThis.fetch = mockProviderFetch();
  try {
    const response = await postChat(host, { retry: true, stream: true });
    assert.equal(response.status, 400);
    assert.deepEqual(store.get(MESSAGES_KEY).map((m) => m.id), ['u1', 't1'], 'history untouched');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - retry rejects history that does not end at a user turn');
}

// ── Retry: drops the trailing assistant turn and re-runs, no dup user ─
{
  const { host, store } = makeHost();
  store.set(MESSAGES_KEY, [
    { id: 'u1', role: 'user', content: 'say hello', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'old answer', createdAt: 2, parts: [{ type: 'text', text: 'old answer' }] },
  ]);
  globalThis.fetch = mockProviderFetch();
  try {
    const response = await postChat(host, { retry: true, stream: true });
    assert.equal(response.status, 200);
    const [events] = await readEventsUntil(response, (list) => list.some((event) => event.type === 'done'));
    const done = events.find((event) => event.type === 'done');
    assert.ok(done, 'retry stream completes');
    assert.equal(done.message.role, 'assistant');
    assert.equal(done.message.content, 'Hello world');
    assert.equal(done.message.status, 'complete');
    assert.equal(done.message.aborted, undefined);
    assert.equal(done.message.error, undefined);

    const persisted = store.get(MESSAGES_KEY);
    assert.deepEqual(persisted.map((m) => m.role), ['user', 'assistant'], 'exactly one user + one assistant');
    assert.equal(persisted[0].id, 'u1', 'user message not duplicated');
    assert.equal(persisted[1].content, 'Hello world', 'old assistant answer replaced');
    assert.notEqual(persisted[1].id, 'a1');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - retry replaces the trailing assistant turn without duplicating the user turn');
}

// ── Retry: history ending at a user turn re-runs it as-is ────────────
{
  const { host, store } = makeHost();
  store.set(MESSAGES_KEY, [
    { id: 'u1', role: 'user', content: 'say hello', createdAt: 1 },
  ]);
  globalThis.fetch = mockProviderFetch();
  try {
    const response = await postChat(host, { retry: true, stream: true });
    assert.equal(response.status, 200);
    await readEventsUntil(response, (list) => list.some((event) => event.type === 'done'));
    const persisted = store.get(MESSAGES_KEY);
    assert.deepEqual(persisted.map((m) => m.role), ['user', 'assistant']);
    assert.equal(persisted[0].id, 'u1');
    assert.equal(persisted[1].content, 'Hello world');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - retry after a failed turn re-runs the trailing user message');
}

// ── Terminal error: partial turn persists with the error surfaced ────
{
  const { host, store } = makeHost();
  globalThis.fetch = mockProviderFetch('fail');
  try {
    const response = await postChat(host, { message: 'hi there', stream: true });
    assert.equal(response.status, 200);
    const [events] = await readEventsUntil(response, (list) => list.some((event) => event.type === 'error'));
    const errorEvent = events.find((event) => event.type === 'error');
    assert.ok(errorEvent, 'terminal error event emitted');
    assert.equal(errorEvent.code, 'E_AGENT_TURN_FAILED');
    assert.ok(events.filter((event) => event.type === 'text-delta').length >= 2, 'deltas streamed before the failure');

    const persisted = store.get(MESSAGES_KEY);
    assert.deepEqual(persisted.map((m) => m.role), ['user', 'assistant'], 'partial turn persisted on error');
    const partial = persisted[1];
    assert.equal(partial.status, 'interrupted');
    assert.equal(partial.content, 'Hello world');
    assert.deepEqual(partial.parts, [{ type: 'text', text: 'Hello world' }]);
    assert.equal(typeof partial.error, 'string', 'terminal error marker stored');
    assert.equal(partial.aborted, undefined, 'error is not mislabelled as a user stop');
    assert.equal(errorEvent.error, partial.error, 'event error matches the stored marker');

    const eventLast = errorEvent.messages[errorEvent.messages.length - 1];
    assert.equal(eventLast.id, partial.id, 'error event message list reflects the persisted partial');

    // Retry stays coherent: it drops the errored partial and re-runs.
    globalThis.fetch = mockProviderFetch();
    const retryResponse = await postChat(host, { retry: true, stream: true });
    assert.equal(retryResponse.status, 200);
    await readEventsUntil(retryResponse, (list) => list.some((event) => event.type === 'done'));
    const after = store.get(MESSAGES_KEY);
    assert.deepEqual(after.map((m) => m.role), ['user', 'assistant']);
    assert.equal(after[1].error, undefined, 'errored partial replaced by the fresh turn');
    assert.equal(after[1].content, 'Hello world');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - terminal stream error persists the partial turn and retry replaces it');
}

// ── Incremental persistence: bounded text writes + reset recovery ────
{
  const { host, store, writes } = makeHost();
  const provider = controlledProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const response = await postChat(host, { message: 'survive a reset', stream: true });
    const stream = collectEvents(response);
    await provider.ready;
    provider.emitText('Hello');
    provider.emitText(' world');
    await waitFor(
      () => stream.events.filter((event) => event.type === 'text-delta').length >= 2,
      'two text deltas',
    );
    assert.equal(assistantWrites(writes).length, 0, 'small deltas are not persisted per token');

    const incremental = await waitFor(() => {
      const messages = store.get(MESSAGES_KEY);
      return messages?.[1]?.status === 'streaming' ? messages : null;
    }, 'debounced streaming persistence');
    assert.equal(incremental.length, 2);
    assert.equal(incremental[1].content, 'Hello world');

    const persistedTurns = assistantWrites(writes);
    assert.equal(persistedTurns.length, 1, 'coalesced text deltas produce one incremental write');

    provider.emitText('x'.repeat(1024));
    await waitFor(() => assistantWrites(writes).length === 2, 'size-threshold streaming persistence');
    const growingTurns = assistantWrites(writes);
    assert.equal(new Set(growingTurns.map((message) => message.id)).size, 1, 'incremental writes retain one assistant id');
    assert.ok(growingTurns[1].content.length > growingTurns[0].content.length, 'same assistant message grows in place');
    for (const write of writes) {
      assert.ok(write.value.filter((message) => message.role === 'assistant').length <= 1, 'no write duplicates the assistant row');
    }

    const activeResponse = await handleAgentRequest(host, new Request(CHAT_URL), new URL(CHAT_URL));
    const active = (await activeResponse.json()).messages;
    assert.equal(active[1].status, 'streaming', 'same-isolate GET preserves the active producer');

    // A new Host models the post-reset isolate: its active-producer registry
    // is empty, while the same durable message array survives.
    const recoveredStore = new Map([[MESSAGES_KEY, structuredClone(incremental)]]);
    const { host: recoveredHost } = makeHost(recoveredStore);
    const getResponse = await handleAgentRequest(
      recoveredHost,
      new Request(CHAT_URL),
      new URL(CHAT_URL),
    );
    const recovered = (await getResponse.json()).messages;
    assert.equal(recovered.length, 2);
    assert.equal(recovered[1].id, incremental[1].id);
    assert.equal(recovered[1].status, 'interrupted');
    assert.equal(recovered[1].aborted, undefined);
    assert.equal(recovered[1].error, undefined);

    provider.finish();
    await stream.done;
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - incremental turn survives reset and orphan sweep marks it interrupted');
}

// ── Tool boundaries persist immediately ─────────────────────────────
{
  const { host, writes } = makeHost();
  globalThis.fetch = toolProviderFetch();
  try {
    const response = await postChat(host, { message: 'list processes', stream: true });
    const [events] = await readEventsUntil(
      response,
      (list) => list.some((event) => event.type === 'done'),
    );
    assert.ok(events.some((event) => event.type === 'tool-call'));
    assert.ok(events.some((event) => event.type === 'tool-result'));
    const checkpoints = assistantWrites(writes).filter((message) => message.status === 'streaming');
    assert.ok(checkpoints.some((message) => message.parts?.some((part) => part.type === 'tool' && part.status === 'running')),
      'tool-call boundary persisted');
    assert.ok(checkpoints.some((message) => message.parts?.some((part) => part.type === 'tool' && part.status !== 'running')),
      'tool-result boundary persisted');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - tool call and result boundaries persist immediately');
}

// The loop runs until the model stops asking for tools: no step-count cap
// ends a turn while the model is still working.
{
  const { host } = makeHost();
  const realFetch = globalThis.fetch;
  const rounds = 40;
  globalThis.fetch = toolProviderFetch(rounds);
  try {
    const response = await postChat(host, { message: 'list processes again and again', stream: true });
    const [events] = await readEventsUntil(response, (list) => list.some((event) => event.type === 'done'));
    assert.equal(events.filter((event) => event.type === 'tool-result').length, rounds,
      `every one of ${rounds} tool rounds ran`);
    const done = events.find((event) => event.type === 'done');
    assert.match(JSON.stringify(done), /Processes checked\./, 'the turn ends with the model\'s answer, not a cap');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`ok - a turn runs ${40} tool rounds to the model's own answer`);
}

// ── Two turns at once: each writes its own message into the one conversation ──
// SES-4. Red before: each turn checkpointed its own copy of the whole
// conversation, so turn A's next checkpoint put back the conversation as A
// saw it, without B's question and answer.
{
  const { host, store } = makeHost();
  const providerA = controlledProviderFetch();
  globalThis.fetch = providerA.fetch;
  try {
    const responseA = await postChat(host, { message: 'question A', stream: true });
    const streamA = collectEvents(responseA);
    await providerA.ready;
    providerA.emitText('answer A begins');
    await waitFor(() => store.get(MESSAGES_KEY)?.some((m) => m.role === 'assistant' && m.status === 'streaming'), 'A checkpoints');

    globalThis.fetch = mockProviderFetch('complete');
    const responseB = await postChat(host, { message: 'question B', stream: true });
    await readEventsUntil(responseB, (list) => list.some((event) => event.type === 'done'));

    providerA.emitText(' and goes on' + 'x'.repeat(1024));
    providerA.finish();
    await streamA.done;

    const stored = store.get(MESSAGES_KEY);
    const texts = stored.map((m) => `${m.role}:${m.role === 'assistant' ? m.content.slice(0, 15) : m.content}`);
    assert.deepEqual(texts, ['user:question A', 'assistant:answer A begins', 'user:question B', 'assistant:Hello world'],
      `both turns' messages stay, each written in place: ${JSON.stringify(texts)}`);
    assert.equal(stored[1].status, 'complete');
    assert.equal(stored[3].status, 'complete');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - two concurrent turns each write their own messages into one conversation');
}

// ── Clear while a turn streams: the turn writes nothing after it ──────
// SES-4. Red before: the streaming turn's next checkpoint wrote back the
// conversation the clear had deleted.
{
  const { host, store } = makeHost();
  const provider = controlledProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const response = await postChat(host, { message: 'before the clear', stream: true });
    const stream = collectEvents(response);
    await provider.ready;
    provider.emitText('partial');
    await waitFor(() => store.get(MESSAGES_KEY)?.some((m) => m.role === 'assistant'), 'the turn checkpoints');

    const cleared = await handleAgentRequest(host, new Request(CHAT_URL, { method: 'DELETE' }), new URL(CHAT_URL));
    assert.deepEqual((await cleared.json()).messages, []);

    provider.emitText('x'.repeat(1024));
    provider.finish();
    await stream.done;
    const after = await handleAgentRequest(host, new Request(CHAT_URL), new URL(CHAT_URL));
    assert.deepEqual((await after.json()).messages, [], 'the cleared conversation stays cleared');
    assert.equal(store.get(MESSAGES_KEY) ?? null, null);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a turn that outlives a clear writes nothing back');
}

// ── A message after a restart: the orphaned turn is settled first ────
// Red before: a POST read the stored history raw, so an answer orphaned by a
// restart mid-tool-call kept its running tool, and the model was sent a tool
// call with no result (the turn failed before reaching it).
{
  const orphaned = [
    { id: 'u-1', role: 'user', content: 'list processes', createdAt: 1 },
    {
      id: 'a-1', role: 'assistant', content: '', createdAt: 2, status: 'streaming',
      parts: [{ type: 'tool', toolCallId: 'call-1', toolName: 'list_processes', input: {}, status: 'running', startedAt: 2 }],
    },
  ];
  const { host, store } = makeHost(new Map([[MESSAGES_KEY, structuredClone(orphaned)]]));
  globalThis.fetch = mockProviderFetch('complete');
  try {
    const response = await postChat(host, { message: 'after the restart', stream: true });
    const [events] = await readEventsUntil(response, (list) => list.some((event) => event.type === 'done' || event.type === 'error'));
    const end = events.find((event) => event.type === 'done' || event.type === 'error');
    assert.equal(end.type, 'done', `the new turn reaches the model: ${JSON.stringify(end).slice(0, 300)}`);
    const stored = store.get(MESSAGES_KEY);
    assert.equal(stored[1].status, 'interrupted', 'the orphaned answer is settled');
    assert.equal(stored[1].parts[0].status, 'error', 'its running tool too');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a message after a restart settles the orphaned turn before the model reads history');
}

// ── Retry while the turn is still answering is refused ───────────────
// Red before: the retry dropped the live answer's row and streamed a second
// one; the first then wrote its row back beside it.
{
  const { host } = makeHost();
  const provider = controlledProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const response = await postChat(host, { message: 'slow question', stream: true });
    const stream = collectEvents(response);
    await provider.ready;
    provider.emitText('working');
    const retried = await postChat(host, { retry: true, stream: true });
    assert.equal(retried.status, 409, 'a retry of a running turn is refused');
    assert.equal((await retried.json()).code, 'E_AGENT_TURN_RUNNING');
    provider.finish();
    await stream.done;
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a retry of a turn still answering is refused');
}

// ── A turn whose question was trimmed away writes nothing back ───────
// Red before: its answer was added at the end of the conversation, after
// newer turns, with no question, pushing a newer row off.
{
  const { host, store } = makeHost();
  const provider = controlledProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const response = await postChat(host, { message: 'the oldest question', stream: true });
    const stream = collectEvents(response);
    await provider.ready;
    globalThis.fetch = mockProviderFetch('complete');
    for (let i = 0; i < 40; i++) {
      const later = await postChat(host, { message: `later ${i}`, stream: true });
      await readEventsUntil(later, (list) => list.some((event) => event.type === 'done'));
    }
    const before = store.get(MESSAGES_KEY);
    assert.ok(!before.some((m) => m.content === 'the oldest question'), 'the oldest question is trimmed off');
    provider.emitText('the oldest answer' + 'x'.repeat(1024));
    provider.finish();
    await stream.done;
    const after = store.get(MESSAGES_KEY);
    assert.ok(!after.some((m) => m.role === 'assistant' && m.content.startsWith('the oldest answer')), 'its answer is not written back');
    assert.deepEqual(after.map((m) => m.id), before.map((m) => m.id), 'the newer history is kept as it was');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a turn whose question was trimmed off writes nothing back');
}

/** The provider fetch, counting the model calls it answers. */
function countingProviderFetch(mode = 'complete') {
  const provider = mockProviderFetch(mode);
  const counter = { calls: 0 };
  counter.fetch = async (input, init) => {
    counter.calls += 1;
    return provider(input, init);
  };
  return counter;
}

// ── A send repeated under its id is that message, accepted once ──────
// SES-X1. Red before: the server ignored the client's id, so a send whose
// response was lost and was sent again stored a second copy of the user
// message, and answered it again.
{
  const { host, store } = makeHost();
  const id = crypto.randomUUID();
  const provider = countingProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const first = await postChat(host, { message: 'build me a site', id, stream: true });
    await readEventsUntil(first, (list) => list.some((event) => event.type === 'done'));
    const answered = store.get(MESSAGES_KEY);
    const callsAnswering = provider.calls;

    const repeat = await postChat(host, { message: 'build me a site', id, stream: true });
    assert.equal(repeat.status, 200);
    const [events] = await readEventsUntil(repeat, () => false);
    const stored = store.get(MESSAGES_KEY);
    assert.equal(stored.filter((m) => m.role === 'user').length, 1,
      `the repeat adds no second user message: ${JSON.stringify(stored.map((m) => `${m.role}:${m.content}`))}`);
    assert.deepEqual(stored, answered, 'the repeat changes nothing');
    assert.equal(stored[0].id, id, 'the user message is stored under the id its client chose');
    assert.equal(provider.calls, callsAnswering, 'an answered send is not answered again');
    assert.deepEqual(events, [{ type: 'start', messages: answered }], 'the repeat is answered with the conversation that holds its turn');

    const json = await postChat(host, { message: 'build me a site', id, stream: false });
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { ok: true, messages: answered }, 'the JSON form answers the same');
    assert.deepEqual(store.get(MESSAGES_KEY), answered);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a send repeated under its id adds no message and runs no turn');
}

// ── A repeat while its turn runs is refused, and adds nothing ────────
{
  const { host, store } = makeHost();
  const id = crypto.randomUUID();
  const provider = controlledProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const response = await postChat(host, { message: 'slow question', id, stream: true });
    const stream = collectEvents(response);
    await provider.ready;
    const repeat = await postChat(host, { message: 'slow question', id, stream: true });
    assert.equal(repeat.status, 409, 'a repeat of a running send is refused');
    assert.equal((await repeat.json()).code, 'E_AGENT_TURN_RUNNING');
    provider.emitText('done');
    provider.finish();
    await stream.done;
    assert.deepEqual(store.get(MESSAGES_KEY).map((m) => `${m.role}:${m.content}`), ['user:slow question', 'assistant:done']);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a repeat of a send still answering is refused');
}

/** The provider failing every request before any output. */
async function failingProviderFetch() {
  return new Response('upstream exploded', { status: 500 });
}

// ── A repeat of a send left unanswered answers it, under its one copy ─
// The first request arrived and its client went away: the turn stopped
// with no answer, or a partial one. The repeat is the user asking again.
for (const leftover of ['none', 'partial']) {
  const id = crypto.randomUUID();
  const { host, store } = makeHost();
  try {
    if (leftover === 'none') {
      globalThis.fetch = failingProviderFetch;
      const first = await postChat(host, { message: 'say hello', id, stream: true });
      await readEventsUntil(first, (list) => list.some((event) => event.type === 'error'));
    } else {
      globalThis.fetch = mockProviderFetch('hang');
      const first = await postChat(host, { message: 'say hello', id, stream: true });
      const [, reader] = await readEventsUntil(first, (list) => list.filter((event) => event.type === 'text-delta').length >= 2);
      await reader.cancel();
      await waitFor(() => store.get(MESSAGES_KEY)?.[1]?.status === 'interrupted', 'the partial answer');
    }
    assert.deepEqual(rows(store.get(MESSAGES_KEY)), leftover === 'none' ? ['user:say hello'] : ['user:say hello', 'assistant:Hello world']);

    globalThis.fetch = mockProviderFetch('complete');
    const repeat = await postChat(host, { message: 'say hello', id, stream: true });
    const [events] = await readEventsUntil(repeat, (list) => list.some((event) => event.type === 'done'));
    assert.ok(events.some((event) => event.type === 'done'), 'the repeat runs the turn');
    const stored = store.get(MESSAGES_KEY);
    assert.deepEqual(rows(stored), ['user:say hello', 'assistant:Hello world'],
      `${leftover}: one user message, answered once: ${JSON.stringify(stored)}`);
    assert.equal(stored[0].id, id);
    assert.equal(stored[1].status, 'complete');
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log('ok - a repeat of a send left unanswered answers it without a second copy');

// ── A repeat of an earlier send runs nothing ─────────────────────────
{
  const id = crypto.randomUUID();
  const { host, store } = makeHost();
  try {
    globalThis.fetch = failingProviderFetch;
    for (const [message, sentId] of [['first', id], ['second', crypto.randomUUID()]]) {
      const response = await postChat(host, { message, id: sentId, stream: true });
      await readEventsUntil(response, (list) => list.some((event) => event.type === 'error'));
    }
    const history = store.get(MESSAGES_KEY);
    assert.deepEqual(rows(history), ['user:first', 'user:second']);
    const provider = countingProviderFetch();
    globalThis.fetch = provider.fetch;
    const repeat = await postChat(host, { message: 'first', id, stream: true });
    const [events] = await readEventsUntil(repeat, () => false);
    assert.deepEqual(events, [{ type: 'start', messages: history }]);
    assert.deepEqual(store.get(MESSAGES_KEY), history);
    assert.equal(provider.calls, 0, 'no turn runs for a send that is no longer the last');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a repeat of a send that is no longer the last runs nothing');
}

// ── An id is one message's: taken or malformed, it is refused ────────
{
  const id = crypto.randomUUID();
  const history = [
    { id, role: 'user', content: 'mine', createdAt: 1 },
    { id: '00000000-0000-4000-8000-000000000000', role: 'assistant', content: 'answer', createdAt: 2, status: 'complete' },
  ];
  const { host, store } = makeHost(new Map([[MESSAGES_KEY, structuredClone(history)]]));
  const provider = countingProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    for (const body of [
      { message: 'not mine', id },
      { message: 'answer', id: history[1].id },
    ]) {
      const taken = await postChat(host, { ...body, stream: true });
      assert.equal(taken.status, 409, `${JSON.stringify(body)} is refused`);
      assert.equal((await taken.json()).code, 'E_AGENT_MESSAGE_ID_TAKEN');
    }
    for (const bad of ['u-1', id.toUpperCase(), 42, '']) {
      const refused = await postChat(host, { message: 'hello', id: bad, stream: true });
      assert.equal(refused.status, 400, `${JSON.stringify(bad)} is not an id`);
      assert.equal((await refused.json()).code, 'E_AGENT_BAD_MESSAGE_ID');
    }
    assert.deepEqual(store.get(MESSAGES_KEY), history, 'nothing is stored for a refused send');
    assert.equal(provider.calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - an id taken by another message, or not a UUID, is refused');
}

/**
 * A provider whose every request is its own controlled stream: `opened[i]`
 * is the i-th request's, with emitText and finish.
 */
function controlledProviderQueue() {
  const encoder = new TextEncoder();
  const opened = [];
  const fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.ok(url.includes('/accounts/test-account/ai/v1/'), `unexpected fetch: ${url}`);
    const signal = init?.signal;
    const body = new ReadableStream({
      start(controller) {
        const onAbort = () => {
          try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch {}
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        opened.push({
          emitText(text) { controller.enqueue(encoder.encode(sseChunk(text))); },
          finish() {
            controller.enqueue(encoder.encode(sseChunk(null, 'stop')));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetch, opened };
}

// ── An answer's announced id is taken before its first checkpoint ─────
// Review F1. Red before: assistant-start announced the answer's id before
// any output was stored, and a send under that id was accepted; the
// answer's first checkpoint then replaced that message.
{
  const { host, store } = makeHost();
  const provider = controlledProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const response = await postChat(host, { message: 'question A', id: crypto.randomUUID(), stream: true });
    const stream = collectEvents(response);
    await provider.ready;
    const announced = (await waitFor(() => stream.events.find((event) => event.type === 'assistant-start'), 'assistant-start')).messageId;
    const squat = await postChat(host, { message: 'squatter', id: announced, stream: true });
    assert.equal(squat.status, 409, 'a send under an answer\'s announced id is refused');
    assert.equal((await squat.json()).code, 'E_AGENT_MESSAGE_ID_TAKEN');
    provider.emitText('answer A');
    provider.finish();
    await stream.done;
    assert.deepEqual(rows(store.get(MESSAGES_KEY)), ['user:question A', 'assistant:answer A']);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - an answer\'s announced id is not a client\'s to send under');
}

// ── A send trimmed off the conversation is still the one send ────────
// Review F2. Red before: only the 80 stored rows were consulted, so a send
// trimmed off them was taken as new when sent again: stored and answered a
// second time, and its id was anyone's to claim with other text.
{
  const { host, store } = makeHost();
  const id = crypto.randomUUID();
  globalThis.fetch = mockProviderFetch('complete');
  try {
    const first = await postChat(host, { message: 'the oldest question', id, stream: true });
    await readEventsUntil(first, (list) => list.some((event) => event.type === 'done'));
    for (let i = 0; i < 40; i++) {
      const later = await postChat(host, { message: `later ${i}`, id: crypto.randomUUID(), stream: true });
      await readEventsUntil(later, (list) => list.some((event) => event.type === 'done'));
    }
    const before = store.get(MESSAGES_KEY);
    assert.ok(!before.some((m) => m.id === id), 'the oldest send is trimmed off');

    const provider = countingProviderFetch();
    globalThis.fetch = provider.fetch;
    const repeat = await postChat(host, { message: 'the oldest question', id, stream: true });
    assert.equal(repeat.status, 200);
    const [events] = await readEventsUntil(repeat, () => false);
    assert.deepEqual(events, [{ type: 'start', messages: before }], 'the repeat is answered with the conversation as it is');
    assert.equal(provider.calls, 0, 'a trimmed send is not answered again');
    const reclaim = await postChat(host, { message: 'another text', id, stream: true });
    assert.equal(reclaim.status, 409, 'a trimmed send\'s id is still its own');
    assert.equal((await reclaim.json()).code, 'E_AGENT_MESSAGE_ID_TAKEN');
    assert.deepEqual(store.get(MESSAGES_KEY), before, 'nothing is stored for either');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a send trimmed off the conversation is neither answered again nor reclaimed');
}

// ── A running send trimmed off the conversation is not put back ──────
// Review F2. Red before: sent again, the trimmed send was stored anew, and
// its first producer's answer, which no longer had its question, found it
// again and was written back.
{
  const { host, store } = makeHost();
  const id = crypto.randomUUID();
  const provider = controlledProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    const response = await postChat(host, { message: 'the oldest question', id, stream: true });
    const stream = collectEvents(response);
    await provider.ready;
    globalThis.fetch = mockProviderFetch('complete');
    for (let i = 0; i < 40; i++) {
      const later = await postChat(host, { message: `later ${i}`, id: crypto.randomUUID(), stream: true });
      await readEventsUntil(later, (list) => list.some((event) => event.type === 'done'));
    }
    const before = store.get(MESSAGES_KEY);
    const repeat = await postChat(host, { message: 'the oldest question', id, stream: true });
    assert.equal(repeat.status, 409, 'a running send sent again is refused');
    assert.equal((await repeat.json()).code, 'E_AGENT_TURN_RUNNING');
    provider.emitText('the oldest answer');
    provider.finish();
    await stream.done;
    assert.deepEqual(store.get(MESSAGES_KEY), before, 'its answer is not written back');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a running send trimmed off the conversation is not stored again');
}

// ── A send sent again is matched to its own answer ───────────────────
// Review F3. Red before: the trailing answer was taken for the last
// question's, so B, which failed with no output while A was answering, was
// taken as answered by A's answer and never answered.
{
  const { host, store } = makeHost();
  const providerA = controlledProviderFetch();
  globalThis.fetch = providerA.fetch;
  const idB = crypto.randomUUID();
  try {
    const responseA = await postChat(host, { message: 'question A', id: crypto.randomUUID(), stream: true });
    const streamA = collectEvents(responseA);
    await providerA.ready;
    globalThis.fetch = failingProviderFetch;
    const responseB = await postChat(host, { message: 'question B', id: idB, stream: true });
    await readEventsUntil(responseB, (list) => list.some((event) => event.type === 'error'));
    providerA.emitText('answer A');
    providerA.finish();
    await streamA.done;
    assert.deepEqual(rows(store.get(MESSAGES_KEY)), ['user:question A', 'user:question B', 'assistant:answer A']);

    globalThis.fetch = mockProviderFetch('complete');
    const resend = await postChat(host, { message: 'question B', id: idB, stream: true });
    const [events] = await readEventsUntil(resend, (list) => list.some((event) => event.type === 'done' || event.type === 'error'));
    assert.ok(events.some((event) => event.type === 'done'), `B sent again is answered: ${JSON.stringify(events.map((event) => event.type))}`);
    const stored = store.get(MESSAGES_KEY);
    assert.deepEqual(rows(stored), ['user:question A', 'user:question B', 'assistant:answer A', 'assistant:Hello world']);
    assert.equal(stored[2].status, 'complete', 'A\'s answer stays');
    assert.equal(stored[3].replyTo, idB, 'B\'s answer names B');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a send sent again is matched to its own answer, not the trailing one');
}

// ── A retry removes only its own question's answer ───────────────────
// Review F3. Red before: a retry popped the trailing answer whoever's it
// was, so A's interrupted answer was lost to B's retry.
{
  const history = [
    { id: 'u-a', role: 'user', content: 'question A', createdAt: 1 },
    { id: 'u-b', role: 'user', content: 'question B', createdAt: 2 },
    { id: 'a-a', role: 'assistant', content: 'half of A', createdAt: 3, status: 'interrupted', error: 'cut', replyTo: 'u-a', parts: [{ type: 'text', text: 'half of A' }] },
  ];
  const { host, store } = makeHost(new Map([[MESSAGES_KEY, structuredClone(history)]]));
  globalThis.fetch = mockProviderFetch('complete');
  try {
    const response = await postChat(host, { retry: true, stream: true });
    await readEventsUntil(response, (list) => list.some((event) => event.type === 'done'));
    const stored = store.get(MESSAGES_KEY);
    assert.deepEqual(rows(stored), ['user:question A', 'user:question B', 'assistant:half of A', 'assistant:Hello world']);
    assert.equal(stored[3].replyTo, 'u-b');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a retry removes only its own question\'s answer');
}

// ── A clear's leftover producer does not end the new one's turn ──────
// Review F4. Red before: the running turns were one set of user ids, so the
// producer a clear left running, ending, released the same id's turn in the
// new conversation, and a repeat started a second answer beside it.
{
  const { host, store } = makeHost();
  const providers = controlledProviderQueue();
  globalThis.fetch = providers.fetch;
  const id = crypto.randomUUID();
  try {
    const before = collectEvents(await postChat(host, { message: 'again', id, stream: true }));
    const old = await waitFor(() => providers.opened[0], 'the first producer');
    await handleAgentRequest(host, new Request(CHAT_URL, { method: 'DELETE' }), new URL(CHAT_URL));
    const after = await postChat(host, { message: 'again', id, stream: true });
    assert.equal(after.status, 200, 'after a clear the id is free');
    const current = collectEvents(after);
    const fresh = await waitFor(() => providers.opened[1], 'the second producer');
    old.emitText('old answer');
    old.finish();
    await before.done;
    const repeat = await postChat(host, { message: 'again', id, stream: true });
    assert.equal(repeat.status, 409, 'the new conversation\'s turn is still running');
    assert.equal((await repeat.json()).code, 'E_AGENT_TURN_RUNNING');
    fresh.emitText('new answer');
    fresh.finish();
    await current.done;
    assert.deepEqual(rows(store.get(MESSAGES_KEY)), ['user:again', 'assistant:new answer']);
    assert.equal(providers.opened.length, 2, 'no third answer was started');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a producer a clear left running releases only its own turn');
}

// ── A send its storage refused is not taken ──────────────────────────
// Review 2, F1. Red before: the receipt and the message were two puts; when
// the message's was refused (a conversation past the value limit), the
// receipt stayed, and the send sent again was answered as a repeat of a
// message the session never stored.
{
  const { host, store, refuseNextPut } = makeHost();
  const id = crypto.randomUUID();
  globalThis.fetch = mockProviderFetch('complete');
  try {
    refuseNextPut(MESSAGES_KEY);
    await assert.rejects(postChat(host, { message: 'too much', id, stream: true }), /SQLITE_TOOBIG/);
    assert.equal(store.get(MESSAGES_KEY), undefined, 'the message is not stored');
    const again = await postChat(host, { message: 'too much', id, stream: true });
    const [events] = await readEventsUntil(again, (list) => list.some((event) => event.type === 'done'));
    assert.ok(events.some((event) => event.type === 'done'), `sent again, it is stored and answered: ${JSON.stringify(events.map((event) => event.type))}`);
    assert.deepEqual(rows(store.get(MESSAGES_KEY)), ['user:too much', 'assistant:Hello world']);
    assert.equal(store.get(MESSAGES_KEY)[0].id, id);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - a send whose storage was refused is taken when sent again');
}

// ── An answer that names its question is its answer, before any by place ─
// Review 2, F2. Red before: the first answer in place won, so a legacy
// answer stored before answers named their question was taken for B's, and
// a second retry of B removed A's answer.
{
  const history = [
    { id: 'u-a', role: 'user', content: 'question A', createdAt: 1 },
    { id: 'u-b', role: 'user', content: 'question B', createdAt: 2 },
    { id: 'a-b', role: 'assistant', content: 'legacy B', createdAt: 3, status: 'complete' },
    { id: 'a-a', role: 'assistant', content: 'legacy A', createdAt: 4, status: 'complete' },
  ];
  const { host, store } = makeHost(new Map([[MESSAGES_KEY, structuredClone(history)]]));
  globalThis.fetch = mockProviderFetch('complete');
  try {
    for (const attempt of [1, 2]) {
      const response = await postChat(host, { retry: true, stream: true });
      await readEventsUntil(response, (list) => list.some((event) => event.type === 'done'));
      const stored = store.get(MESSAGES_KEY);
      assert.deepEqual(rows(stored), ['user:question A', 'user:question B', 'assistant:legacy A', 'assistant:Hello world'],
        `retry ${attempt} replaces B's answer alone`);
      assert.equal(stored[3].replyTo, 'u-b');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - an answer that names its question is found before a legacy one by place');
}

// ── Text that is not well-formed is refused ──────────────────────────
// Review 2, F3. Red before: a lone surrogate was stored as sent, but its
// digest was that of U+FFFD, so '\ufffd' under the same id passed as a
// repeat of it.
{
  const { host, store } = makeHost();
  const id = crypto.randomUUID();
  const provider = countingProviderFetch();
  globalThis.fetch = provider.fetch;
  try {
    for (const message of ['\ud800', 'a\udc00b', '\ude00\ud83d']) {
      const refused = await postChat(host, { message, id, stream: true });
      assert.equal(refused.status, 400, `${JSON.stringify(message)} is refused`);
      assert.equal((await refused.json()).code, 'E_AGENT_BAD_MESSAGE_TEXT');
    }
    assert.equal(store.get(MESSAGES_KEY), undefined, 'nothing is stored for it');
    const replacement = await postChat(host, { message: '\ufffd', id, stream: true });
    const [events] = await readEventsUntil(replacement, (list) => list.some((event) => event.type === 'done'));
    assert.ok(events.some((event) => event.type === 'done'), 'U+FFFD itself is a message, under the id');
    assert.deepEqual(rows(store.get(MESSAGES_KEY)), ['user:\ufffd', 'assistant:Hello world']);
    const pair = await postChat(host, { message: '\ud83d\ude00', id: crypto.randomUUID(), stream: true });
    assert.equal(pair.status, 200, 'a surrogate pair is well-formed');
    await readEventsUntil(pair, (list) => list.some((event) => event.type === 'done'));
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - text with a lone surrogate is refused before it is stored or hashed');
}

// ── History written before parts reaches the model as it was stored ──
// A tool result stored as its own `tool`-role row reaches the model as the
// tool's name (a string, else the row's name) and output in text; an
// assistant answer stored before parts, as its content; a part that is not
// an object is dropped.
{
  const { host, store } = makeHost();
  store.set(MESSAGES_KEY, [
    { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
    { id: 't1', role: 'tool', name: 'by-name', content: JSON.stringify({ tool: 'list_files', input: { dir: '.' }, output: ['a', 'b'] }), createdAt: 2 },
    { id: 't2', role: 'tool', name: 'by-name', content: JSON.stringify({ output: 'only output' }), createdAt: 3 },
    { id: 't3', role: 'tool', content: 'not json', createdAt: 4 },
    { id: 't4', role: 'tool', content: 'null', createdAt: 5 },
    { id: 't5', role: 'tool', content: JSON.stringify({ tool: 'zero', output: 0 }), createdAt: 6 },
    { id: 't6', role: 'tool', name: 'by-name', content: JSON.stringify({ tool: 7, output: 'x' }), createdAt: 6 },
    { id: 'a1', role: 'assistant', content: 'stored before parts', createdAt: 7 },
    { id: 'a2', role: 'assistant', content: 'unused', parts: [null, 7, { type: 'text', text: 'from parts' }], createdAt: 8 },
  ]);
  const sent = [];
  const provider = mockProviderFetch();
  globalThis.fetch = async (input, init) => {
    const body = await (input instanceof Request ? input.clone().text() : new Response(init.body).text());
    sent.push(JSON.parse(body).messages);
    return provider(input, { ...init, body });
  };
  try {
    const response = await postChat(host, { message: 'next', stream: true });
    await readEventsUntil(response, (list) => list.some((event) => event.type === 'done'));
    const texts = sent[0].filter((m) => m.role !== 'system').map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('')}`);
    assert.deepEqual(texts, [
      'user:go',
      'assistant:Tool list_files result:\n["a","b"]',
      'assistant:Tool by-name result:\n"only output"',
      'assistant:Tool tool result:\n"not json"',
      'assistant:Tool tool result:\n"null"',
      'assistant:Tool zero result:\n0',
      'assistant:Tool by-name result:\n"x"',
      'assistant:stored before parts',
      'assistant:from parts',
      'user:next',
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ok - history written before parts reaches the model as it was stored');
}

console.log('agent-chat-turns: all assertions passed');
