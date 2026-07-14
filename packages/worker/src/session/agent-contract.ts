/**
 * session/agent-contract.ts - Wire contract between the session agent
 * endpoints (src/session/agent.ts) and the built chat island
 * (frontend/agent-chat). Pure types, no runtime imports, so the frontend
 * tsconfig (DOM lib) and the worker tsconfig (workers-types) can both
 * typecheck against the same source of truth.
 */

export type StoredTurnPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      toolCallId: string;
      toolName: string;
      input?: unknown;
      output?: unknown;
      error?: string;
      status: 'running' | 'done' | 'error';
      startedAt?: number;
      durationMs?: number;
    };

export type StoredToolPart = Extract<StoredTurnPart, { type: 'tool' }>;

export type StoredMessageStatus = 'streaming' | 'complete' | 'interrupted';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: number;
  name?: string;
  parts?: StoredTurnPart[];
  /**
   * Turn lifecycle. `aborted` and `error` refine an `interrupted` status
   * with the known reason; an orphaned reset has neither reason marker.
   * Missing status is valid for history written before lifecycle tracking.
   */
  status?: StoredMessageStatus;
  /** Present only when an interrupted turn was stopped by the client. */
  aborted?: true;
  /** Present only when an interrupted turn ended in a provider/stream error. */
  error?: string;
}

/** Per-step token usage as reported by the model provider. */
export interface AgentTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type AgentStreamEvent =
  | { type: 'start'; messages: StoredMessage[] }
  | { type: 'message'; message: StoredMessage }
  | { type: 'assistant-start'; messageId: string; createdAt: number }
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; input: unknown; output: unknown; status: 'done' | 'error' }
  | { type: 'tool-error'; toolCallId: string; toolName: string; input: unknown; error: string }
  | { type: 'finish-step'; finishReason?: string; usage?: AgentTurnUsage }
  | { type: 'done'; message: StoredMessage; messages: StoredMessage[] }
  | { type: 'error'; error: string; code: string; messages: StoredMessage[] };

export type StoredToolPartPatch = Omit<StoredToolPart, 'type'>;

/**
 * Append a text/reasoning delta, coalescing into the trailing part of the
 * same type so a turn stays [reasoning, text, tool, text, ...] in order.
 */
export function appendTextPart(parts: StoredTurnPart[], type: 'text' | 'reasoning', delta: string): void {
  if (!delta) return;
  const last = parts[parts.length - 1];
  if (last?.type === type) {
    last.text += delta;
    return;
  }
  parts.push({ type, text: delta });
}

/**
 * Upsert a tool part by toolCallId. When a settle patch arrives for a part
 * whose start was observed, the duration is derived once from startedAt.
 */
export function upsertToolPart(parts: StoredTurnPart[], patch: StoredToolPartPatch): StoredToolPart {
  let part = parts.find((item): item is StoredToolPart => (
    item.type === 'tool' && item.toolCallId === patch.toolCallId
  ));
  if (!part) {
    part = {
      type: 'tool',
      toolCallId: patch.toolCallId,
      toolName: patch.toolName,
      status: patch.status,
    };
    parts.push(part);
  }
  const startedAt = part.startedAt;
  Object.assign(part, patch);
  if (startedAt && patch.status !== 'running' && !part.durationMs) {
    part.durationMs = Date.now() - startedAt;
  }
  return part;
}

/** Replace a stored message by id, or append it when first checkpointed. */
export function upsertStoredMessage(messages: StoredMessage[], message: StoredMessage): void {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) messages[index] = message;
  else messages.push(message);
}

/** Settle tools that cannot still be running once their turn is interrupted. */
export function interruptRunningTools(parts: StoredTurnPart[], reason: string): void {
  for (const part of parts) {
    if (part.type !== 'tool' || part.status !== 'running') continue;
    part.status = 'error';
    part.error = reason;
    if (part.output === undefined) part.output = { error: reason };
  }
}

export function isInterruptedMessage(message: StoredMessage): boolean {
  return message.status === 'interrupted' || message.aborted === true || typeof message.error === 'string';
}

export function textFromParts(parts: StoredTurnPart[]): string {
  return parts
    .filter((part): part is Extract<StoredTurnPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

export interface AgentAccount {
  id: string;
  name?: string;
}

/** GET /api/agent/status response body. */
export interface AgentStatusPayload {
  ok: boolean;
  configured: boolean;
  model: string;
  gatewayId: string;
  oauth: {
    configured: boolean;
    connected: boolean;
    clientId: string | null;
    scopes: string[];
    user: unknown;
    accounts: AgentAccount[];
    accountId: string | null;
    expiresAt: number | null;
  };
  ownerToken: {
    configured: boolean;
    accountId: string | null;
    disabledByUserOAuthRequired: boolean;
  };
  connected: boolean;
  capabilities: string[];
}
