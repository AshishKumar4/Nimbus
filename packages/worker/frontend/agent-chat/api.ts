/**
 * api.ts - Session-scoped agent endpoint client. The island is served on
 * `/s/<session-id>/`, and every agent route lives under that same prefix.
 */

import type { AgentStatusPayload, StoredMessage } from '../../src/session/agent-contract.js';

const SESSION_PREFIX = (() => {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[0] === 's' && parts[1] ? `/s/${parts[1]}` : '';
})();

const STATUS_URL = `${SESSION_PREFIX}/api/agent/status`;
const MESSAGES_URL = `${SESSION_PREFIX}/api/agent/messages`;
const OAUTH_START_URL = `${SESSION_PREFIX}/api/agent/oauth/start`;
const OAUTH_LOGOUT_URL = `${SESSION_PREFIX}/api/agent/oauth/logout`;
const ACCOUNT_URL = `${SESSION_PREFIX}/api/agent/account`;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers || {}) },
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (payload as { error?: string })?.error;
    throw new Error(error || `Request failed (${response.status})`);
  }
  return payload as T;
}

export function fetchStatus(): Promise<AgentStatusPayload> {
  return requestJson<AgentStatusPayload>(STATUS_URL);
}

export async function fetchMessages(): Promise<StoredMessage[]> {
  const payload = await requestJson<{ messages?: StoredMessage[] }>(MESSAGES_URL);
  return Array.isArray(payload.messages) ? payload.messages : [];
}

export async function clearMessages(): Promise<void> {
  await requestJson<{ ok: boolean }>(MESSAGES_URL, { method: 'DELETE' });
}

export async function startOAuth(): Promise<string> {
  const payload = await requestJson<{ authUrl?: string }>(OAUTH_START_URL, { method: 'POST' });
  if (!payload.authUrl) throw new Error('OAuth start failed');
  return payload.authUrl;
}

export async function logoutOAuth(): Promise<void> {
  await requestJson<{ ok: boolean }>(OAUTH_LOGOUT_URL, { method: 'POST' });
}

export async function selectAccount(accountId: string): Promise<void> {
  await requestJson<{ ok: boolean }>(ACCOUNT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
}

export type ChatRequestBody = { message: string; stream: true } | { retry: true; stream: true };

/** POST a chat turn; the caller consumes the NDJSON body via stream.ts. */
export async function postChatTurn(body: ChatRequestBody, signal: AbortSignal): Promise<Response> {
  const response = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const payload: unknown = await response.json().catch(() => ({}));
    const error = (payload as { error?: string })?.error;
    throw new Error(error || `Agent request failed (${response.status})`);
  }
  return response;
}
