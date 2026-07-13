#!/usr/bin/env bun
// agent-chat-stream — the chat island's NDJSON reducer must accumulate
// turn parts exactly like the backend persists them: coalesced text /
// reasoning runs, tool upserts by toolCallId, and summed step usage.

import assert from 'node:assert/strict';
import {
  applyStreamEvent,
  createLiveTurn,
  readAgentStream,
} from '../../packages/worker/frontend/agent-chat/stream.ts';

function collector() {
  const seen = { messages: null, liveChanges: 0, error: null, done: null };
  return {
    seen,
    callbacks: {
      onMessages(messages) { seen.messages = messages; },
      onLiveChange() { seen.liveChanges += 1; },
      onError(error) { seen.error = error; },
      onDone(message) { seen.done = message; },
    },
  };
}

// Chronological accumulation: reasoning → text → tool call/result → text.
{
  const live = createLiveTurn();
  const { seen, callbacks } = collector();
  const events = [
    { type: 'assistant-start', messageId: 'a1', createdAt: 123 },
    { type: 'reasoning-delta', delta: 'thinking ' },
    { type: 'reasoning-delta', delta: 'hard' },
    { type: 'text-delta', delta: 'Let me ' },
    { type: 'text-delta', delta: 'check.' },
    { type: 'tool-call', toolCallId: 't1', toolName: 'exec', input: { command: 'ls' } },
    { type: 'tool-result', toolCallId: 't1', toolName: 'exec', input: { command: 'ls' }, output: { stdout: 'app' }, status: 'done' },
    { type: 'text-delta', delta: 'Done.' },
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 } },
  ];
  for (const event of events) applyStreamEvent(event, live, callbacks);

  assert.equal(live.message.id, 'a1');
  assert.equal(live.message.createdAt, 123);
  assert.equal(live.message.role, 'assistant');
  const parts = live.message.parts;
  assert.equal(parts.length, 4, 'reasoning, text, tool, text');
  assert.deepEqual(parts[0], { type: 'reasoning', text: 'thinking hard' });
  assert.deepEqual(parts[1], { type: 'text', text: 'Let me check.' });
  assert.equal(parts[2].type, 'tool');
  assert.equal(parts[2].status, 'done');
  assert.deepEqual(parts[2].output, { stdout: 'app' });
  assert.deepEqual(parts[3], { type: 'text', text: 'Done.' });
  assert.deepEqual(live.usage, { inputTokens: 30, outputTokens: 12, totalTokens: 42 });
  assert.ok(seen.liveChanges >= events.length - 1, 'every mutation schedules a repaint');
}

// Tool errors settle the matching tool part.
{
  const live = createLiveTurn();
  const { callbacks } = collector();
  applyStreamEvent({ type: 'tool-call', toolCallId: 't1', toolName: 'exec', input: {} }, live, callbacks);
  assert.equal(live.message.parts[0].status, 'running');
  assert.ok(live.message.parts[0].startedAt > 0);
  applyStreamEvent({ type: 'tool-error', toolCallId: 't1', toolName: 'exec', input: {}, error: 'boom' }, live, callbacks);
  assert.equal(live.message.parts.length, 1);
  assert.equal(live.message.parts[0].status, 'error');
  assert.equal(live.message.parts[0].error, 'boom');
  assert.deepEqual(live.message.parts[0].output, { error: 'boom' });
}

// Terminal events hand over the authoritative message list.
{
  const live = createLiveTurn();
  const { seen, callbacks } = collector();
  const message = { id: 'a9', role: 'assistant', content: 'hi', createdAt: 5 };
  applyStreamEvent({ type: 'done', message, messages: [message] }, live, callbacks);
  assert.deepEqual(seen.messages, [message]);
  assert.equal(seen.done, message);

  const { seen: seen2, callbacks: callbacks2 } = collector();
  applyStreamEvent({ type: 'error', error: 'quota', code: 'E', messages: [] }, live, callbacks2);
  assert.equal(seen2.error, 'quota');
  assert.deepEqual(seen2.messages, []);
}

// readAgentStream parses NDJSON lines split across arbitrary chunks.
{
  const encoder = new TextEncoder();
  const payload =
    '{"type":"text-delta","delta":"Hel' + 'lo"}\n'
    + '{"type":"finish-step","usage":{"totalTokens":3}}\n'
    + '{"type":"done","message":{"id":"a1","role":"assistant","content":"Hello","createdAt":1},"messages":[]}';
  const bytes = encoder.encode(payload);
  const body = new ReadableStream({
    start(controller) {
      // Deliberately misaligned chunk boundaries.
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17, 41));
      controller.enqueue(bytes.slice(41));
      controller.close();
    },
  });
  const live = createLiveTurn();
  const { seen, callbacks } = collector();
  await readAgentStream(body, live, callbacks);
  assert.deepEqual(live.message.parts, [{ type: 'text', text: 'Hello' }]);
  assert.deepEqual(live.usage, { totalTokens: 3 });
  assert.equal(seen.done?.id, 'a1');
}

console.log('agent-chat-stream: all assertions passed');
