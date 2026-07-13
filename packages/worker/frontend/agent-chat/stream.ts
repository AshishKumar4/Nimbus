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
  id: string;
  createdAt: number;
  parts: StoredTurnPart[];
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

export function createLiveTurn(): LiveTurn {
  return { id: crypto.randomUUID(), createdAt: Date.now(), parts: [], usage: {} };
}

/** The streamed assistant turn as a renderable StoredMessage snapshot. */
export function liveTurnMessage(live: LiveTurn): StoredMessage {
  return {
    id: live.id,
    role: 'assistant',
    content: '',
    createdAt: live.createdAt,
    parts: live.parts,
  };
}

export async function readAgentStream(
  body: ReadableStream<Uint8Array>,
  live: LiveTurn,
  callbacks: StreamCallbacks,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (line: string) => {
    if (!line) return;
    applyStreamEvent(JSON.parse(line) as AgentStreamEvent, live, callbacks);
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
      live.id = event.messageId || live.id;
      live.createdAt = event.createdAt || live.createdAt;
      callbacks.onLiveChange();
      return;
    case 'text-delta':
      appendTextPart(live.parts, 'text', event.delta);
      callbacks.onLiveChange();
      return;
    case 'reasoning-delta':
      appendTextPart(live.parts, 'reasoning', event.delta);
      callbacks.onLiveChange();
      return;
    case 'tool-call':
      upsertToolPart(live.parts, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        status: 'running',
        startedAt: Date.now(),
      });
      callbacks.onLiveChange();
      return;
    case 'tool-result':
      upsertToolPart(live.parts, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        output: event.output,
        status: event.status,
      });
      callbacks.onLiveChange();
      return;
    case 'tool-error':
      upsertToolPart(live.parts, {
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
