/**
 * stream.ts - NDJSON agent-stream client. Reads AgentStreamEvent lines from
 * a POST /api/agent/messages response and folds them into a live turn using
 * the same part-accumulation helpers the backend persists with.
 */

import {
  appendTextPart,
  upsertToolPart,
  type AgentStreamEvent,
  type AgentTurnUsage,
  type StoredMessage,
  type StoredTurnPart,
} from '../../src/session/agent-contract.js';

export interface LiveTurn {
  /**
   * Renderable snapshot of the in-flight assistant turn. The object keeps a
   * stable identity for the whole turn (parts mutate in place), so memoized
   * settled messages skip re-renders and the live message re-renders via an
   * explicit tick prop.
   */
  message: StoredMessage & { parts: StoredTurnPart[] };
  usage: AgentTurnUsage;
}

export interface StreamCallbacks {
  /** Authoritative message list from the server (start/done/error events). */
  onMessages(messages: StoredMessage[]): void;
  /** The live turn mutated - schedule a repaint. */
  onLiveChange(): void;
  /** The turn ended in a terminal server-side error. */
  onError(error: string): void;
  /** The turn completed and was persisted. */
  onDone(message: StoredMessage): void;
}

export type AgentStreamOutcome = 'done' | 'error' | 'eof';

export function createLiveTurn(): LiveTurn {
  return {
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      parts: [],
      status: 'streaming',
    },
    usage: {},
  };
}

export async function readAgentStream(
  body: ReadableStream<Uint8Array>,
  live: LiveTurn,
  callbacks: StreamCallbacks,
): Promise<AgentStreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outcome: AgentStreamOutcome = 'eof';
  const consume = (line: string) => {
    if (!line) return;
    const event = JSON.parse(line) as AgentStreamEvent;
    applyStreamEvent(event, live, callbacks);
    if (event.type === 'done' || event.type === 'error') outcome = event.type;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf('\n');
    while (lineEnd >= 0) {
      consume(buffer.slice(0, lineEnd).trim());
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf('\n');
    }
  }
  consume(buffer.trim());
  return outcome;
}

export function applyStreamEvent(event: AgentStreamEvent, live: LiveTurn, callbacks: StreamCallbacks): void {
  switch (event.type) {
    case 'start':
      callbacks.onMessages(event.messages);
      return;
    case 'message':
      // The user message is already rendered optimistically; the
      // authoritative copy arrives with the done/error message list.
      return;
    case 'assistant-start':
      live.message.id = event.messageId || live.message.id;
      live.message.createdAt = event.createdAt || live.message.createdAt;
      callbacks.onLiveChange();
      return;
    case 'text-delta':
      appendTextPart(live.message.parts, 'text', event.delta);
      callbacks.onLiveChange();
      return;
    case 'reasoning-delta':
      appendTextPart(live.message.parts, 'reasoning', event.delta);
      callbacks.onLiveChange();
      return;
    case 'tool-call':
      upsertToolPart(live.message.parts, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        status: 'running',
        startedAt: Date.now(),
      });
      callbacks.onLiveChange();
      return;
    case 'tool-result':
      upsertToolPart(live.message.parts, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        output: event.output,
        status: event.status,
      });
      callbacks.onLiveChange();
      return;
    case 'tool-error':
      upsertToolPart(live.message.parts, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        output: { error: event.error },
        error: event.error,
        status: 'error',
      });
      callbacks.onLiveChange();
      return;
    case 'finish-step':
      accumulateUsage(live.usage, event.usage);
      callbacks.onLiveChange();
      return;
    case 'done':
      callbacks.onMessages(event.messages);
      callbacks.onDone(event.message);
      return;
    case 'error':
      callbacks.onMessages(event.messages);
      callbacks.onError(event.error || 'Agent request failed');
      return;
  }
}

function accumulateUsage(total: AgentTurnUsage, step: AgentTurnUsage | undefined): void {
  if (!step) return;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const value = step[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}
