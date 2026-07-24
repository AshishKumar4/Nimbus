/**
 * session/ai.ts — the one path by which anything in Nimbus reaches a model.
 *
 * Two consumers, one implementation:
 *
 *   • Tools running inside the session (pi, opencode, a user script, curl)
 *     reach an OpenAI-compatible endpoint on session loopback,
 *     `http://127.0.0.1:<NIMBUS_AI_GATEWAY_PORT>/v1`, seeded into the session
 *     environment as OPENAI_BASE_URL / OPENAI_API_BASE / OPENAI_API_KEY.
 *   • The Nimbus agent (session/agent.ts) builds its AI-SDK provider with a
 *     `fetch` that calls straight into `handleSessionAiRequest`. Same code,
 *     no network hop.
 *
 * So this module is the single place that knows the Cloudflare AI base URL,
 * attaches `cf-aig-gateway-id`, resolves and refreshes the account credential,
 * and decides the default model. Nothing else may learn those things.
 *
 * Credential handling — the security contract
 * ───────────────────────────────────────────
 * The user's Cloudflare OAuth access token NEVER enters the sandbox. It lives
 * in Durable Object storage (`nimbus:ai:credential`), is attached to the
 * upstream request here in the supervisor, and the endpoint the session sees
 * needs no credential at all: loopback is already session-private, so
 * OPENAI_API_KEY is a fixed placeholder the gateway ignores.
 *
 * Why DO storage rather than the browser cookie the agent used to read: a
 * request originating inside the sandbox carries no cookie. The supervisor
 * must therefore hold a session-scoped credential of record for in-session
 * inference to be possible at all. The `nimbus_agent_oauth` cookie keeps its
 * job as the transport that carries the credential from the browser to the
 * session; `captureSessionAiCredential` is the one place it is read.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { z } from 'zod/v4';
import { NIMBUS_AI_GATEWAY_PORT } from '../constants.js';
import {
  NIMBUS_AGENT_AUTH_COOKIE,
  NIMBUS_CLOUDFLARE_API,
  fetchNimbusCloudflareAccounts,
  fetchNimbusCloudflareUserInfo,
  loadNimbusAgentOAuthFromRequest,
  readNimbusAgentCookieSecret,
  readNimbusAgentOAuthConfig,
  readNimbusCookie,
  requestNimbusCloudflareOAuthToken,
  type NimbusCloudflareAccount,
} from './agent-oauth.js';

export interface SessionAiHost {
  env: Record<string, unknown>;
  ctx: {
    storage: {
      get(key: string): Promise<unknown>;
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
    };
  };
}

/** DO storage key holding this session's Cloudflare credential of record. */
export const SESSION_AI_CREDENTIAL_KEY = 'nimbus:ai:credential';

/**
 * The value seeded as OPENAI_API_KEY. Not a secret and not checked: the
 * endpoint is loopback-only, so possession of it proves nothing. It exists
 * because OpenAI clients refuse to start with an empty key.
 */
export const SESSION_AI_PLACEHOLDER_KEY = 'nimbus-session';

export const DEFAULT_SESSION_AI_MODEL = '@cf/zai-org/glm-5.2';
export const DEFAULT_SESSION_AI_GATEWAY_ID = 'default';

/** Cloudflare's model catalogue task name for chat/completion models. */
const TEXT_GENERATION_TASK = 'Text Generation';
const MODEL_PAGE_SIZE = 50;
const MODEL_PAGE_LIMIT = 10;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const REFRESH_SKEW_MS = 60_000;

export interface SessionAiConfig {
  model: string;
  gatewayId: string;
  ownerAccountId: string;
  ownerToken: string;
  requireUserOAuth: boolean;
}

export interface ResolvedAiCredential {
  accessToken: string;
  accountId: string;
  source: 'session' | 'owner-token';
}

export interface SessionAiUnavailable {
  code: 'E_AI_NOT_CONNECTED' | 'E_AI_NO_ACCOUNT';
  message: string;
}

export type SessionAiResolution =
  | { ok: true; credential: ResolvedAiCredential }
  | { ok: false; reason: SessionAiUnavailable };

const StoredCredentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  accountId: z.string().min(1).nullable(),
  expiresAt: z.number().finite().nullable(),
});

type StoredCredential = z.infer<typeof StoredCredentialSchema>;

const ModelSearchResponseSchema = z.object({
  result: z.array(z.object({
    name: z.string().min(1),
    description: z.string().nullish(),
    created_at: z.string().nullish(),
  }).passthrough()).nullish(),
});

/**
 * Three different envelopes can come back from Cloudflare depending on which
 * layer rejected the request: the API frontend answers `{errors:[{message}]}`,
 * AI Gateway answers `{error:[{message}]}` plus a top-level `message`, and a
 * model-level failure can surface OpenAI's own `{error:{message}}`. Pull the
 * sentence out of whichever shape arrived.
 */
function extractUpstreamMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const body = payload as Record<string, unknown>;
  for (const candidate of [body.errors, body.error]) {
    if (Array.isArray(candidate)) {
      const found = candidate.find((entry) => messageOf(entry));
      if (found) return messageOf(found);
    }
    const direct = messageOf(candidate);
    if (direct) return direct;
  }
  return typeof body.message === 'string' ? body.message : '';
}

function messageOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/** Base URL of the in-session endpoint. The one true address of this gateway. */
export function sessionAiBaseUrl(): string {
  return `http://127.0.0.1:${NIMBUS_AI_GATEWAY_PORT}/v1`;
}

/**
 * The environment every session is seeded with, so any OpenAI-compatible tool
 * discovers the gateway without being told about it.
 */
export function sessionAiEnv(): Record<string, string> {
  const baseUrl = sessionAiBaseUrl();
  return {
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_BASE: baseUrl,
    OPENAI_API_KEY: SESSION_AI_PLACEHOLDER_KEY,
  };
}

export function readSessionAiConfig(env: Record<string, unknown>): SessionAiConfig {
  return {
    model: envString(env, 'NIMBUS_AGENT_MODEL') || DEFAULT_SESSION_AI_MODEL,
    gatewayId: envString(env, 'NIMBUS_AGENT_GATEWAY_ID') || DEFAULT_SESSION_AI_GATEWAY_ID,
    ownerAccountId: envString(env, 'NIMBUS_CLOUDFLARE_ACCOUNT_ID'),
    ownerToken: envString(env, 'NIMBUS_CLOUDFLARE_API_TOKEN'),
    requireUserOAuth: envBool(env, 'NIMBUS_AGENT_REQUIRE_USER_OAUTH'),
  };
}

// ── Credential lifecycle ──────────────────────────────────────────────────

/**
 * Adopt the credential the browser is carrying, if any. Called once at the top
 * of the session fetch handler: the `nimbus_agent_oauth` cookie is scoped to
 * `/s/<sid>`, so every page load, /ws upgrade and /api call delivers it, and
 * the gateway is live from the session's first request rather than only after
 * someone opens the agent panel.
 *
 * Cheap by construction — a header read, and an unseal only when the cookie
 * material differs from the last one this isolate saw.
 */
export async function captureSessionAiCredential(self: SessionAiHost, request: Request): Promise<void> {
  const raw = readNimbusCookie(request, NIMBUS_AGENT_AUTH_COOKIE);
  if (!raw || lastSeenCookie.get(self) === raw) return;

  let secret: string;
  try {
    secret = readNimbusAgentCookieSecret(self.env);
  } catch {
    return;
  }
  const auth = await loadNimbusAgentOAuthFromRequest(request, secret);
  if (!auth?.accessToken) return;
  lastSeenCookie.set(self, raw);

  const stored = await readStoredCredential(self);
  if (stored?.accessToken === auth.accessToken) return;
  await writeStoredCredential(self, {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    // A locally chosen account (agent panel → account picker) outranks the
    // account the cookie was minted with.
    accountId: stored?.accountId ?? auth.accountId,
    expiresAt: auth.expiresAt,
  });
}

/**
 * The session's credential, refreshed if it is about to expire. Falls back to
 * the deployment owner's API token when the embedder configured one and has
 * not required per-user OAuth.
 */
export async function resolveSessionAiCredential(self: SessionAiHost): Promise<SessionAiResolution> {
  const config = readSessionAiConfig(self.env);
  const stored = await readStoredCredential(self);
  if (stored) {
    const fresh = await ensureFreshCredential(self, stored);
    if (fresh && fresh.accountId) {
      return { ok: true, credential: { accessToken: fresh.accessToken, accountId: fresh.accountId, source: 'session' } };
    }
    if (fresh) {
      return {
        ok: false,
        reason: {
          code: 'E_AI_NO_ACCOUNT',
          message: 'Nimbus AI gateway: a Cloudflare account is connected but none is selected for this session. Open the session in your browser and pick an account in the agent panel.',
        },
      };
    }
  }
  if (!config.requireUserOAuth && config.ownerToken && config.ownerAccountId) {
    return {
      ok: true,
      credential: { accessToken: config.ownerToken, accountId: config.ownerAccountId, source: 'owner-token' },
    };
  }
  return {
    ok: false,
    reason: {
      code: 'E_AI_NOT_CONNECTED',
      message: 'Nimbus AI gateway: no Cloudflare account is connected to this session, so no models are reachable. Open this session in your browser and connect Cloudflare from the agent panel, then retry.',
    },
  };
}

/**
 * Adopt a credential minted by this deployment's own OAuth callback. The
 * browser is not handed a copy: the session holds it, which is what makes
 * in-session inference possible.
 */
export async function storeSessionAiCredential(self: SessionAiHost, credential: {
  accessToken: string;
  refreshToken?: string;
  accountId: string | null;
  expiresAt: number | null;
}): Promise<void> {
  await writeStoredCredential(self, StoredCredentialSchema.parse(credential));
}

/**
 * What Cloudflare identity this session has, for the agent panel. Returns no
 * token — the credential stays inside this module, and callers that need to
 * reach Cloudflare do it through the functions here.
 */
export async function describeSessionAiConnection(self: SessionAiHost): Promise<{
  connected: boolean;
  accountId: string | null;
  expiresAt: number | null;
  accounts: NimbusCloudflareAccount[];
  user: unknown;
}> {
  const stored = await readStoredCredential(self);
  const fresh = stored ? await ensureFreshCredential(self, stored) : null;
  if (!fresh) return { connected: false, accountId: null, expiresAt: null, accounts: [], user: null };
  const [user, accounts] = await Promise.all([
    fetchNimbusCloudflareUserInfo(fresh.accessToken).catch((e: unknown) => ({ error: String((e as Error)?.message || e) })),
    fetchNimbusCloudflareAccounts(fresh.accessToken).catch(() => [] as NimbusCloudflareAccount[]),
  ]);
  return { connected: true, accountId: fresh.accountId, expiresAt: fresh.expiresAt, accounts, user };
}

/**
 * True when `accountId` is one the session's credential may actually use.
 * Checked before recording a pick so the panel cannot select into a 404.
 */
export async function sessionAiAccountIsAvailable(self: SessionAiHost, accountId: string): Promise<boolean> {
  const stored = await readStoredCredential(self);
  const fresh = stored ? await ensureFreshCredential(self, stored) : null;
  if (!fresh) return false;
  const accounts = await fetchNimbusCloudflareAccounts(fresh.accessToken).catch(() => [] as NimbusCloudflareAccount[]);
  return accounts.some((account) => account.id === accountId);
}

/**
 * The model the Nimbus agent talks to. Built on the same gateway the session's
 * tools use: `fetch` goes straight into `handleSessionAiRequest` rather than
 * over the network, so credential minting, the gateway header, the base URL and
 * the default model have exactly one implementation between them.
 */
export function createSessionAiModel(self: SessionAiHost): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'nimbus',
    apiKey: SESSION_AI_PLACEHOLDER_KEY,
    baseURL: sessionAiBaseUrl(),
    fetch: (input, init) => handleSessionAiRequest(self, new Request(input as RequestInfo, init)),
  });
  return provider.chatModel(readSessionAiConfig(self.env).model);
}

/** Record the account the user picked. Storage is the only copy that decides. */
export async function setSessionAiAccount(self: SessionAiHost, accountId: string): Promise<boolean> {
  const stored = await readStoredCredential(self);
  if (!stored) return false;
  await writeStoredCredential(self, { ...stored, accountId });
  return true;
}

/** Forget this session's credential (agent logout). */
export async function clearSessionAiCredential(self: SessionAiHost): Promise<void> {
  lastSeenCookie.delete(self);
  await self.ctx.storage.delete(SESSION_AI_CREDENTIAL_KEY);
}

/** The stored credential, for surfaces that report connection state. */
export async function readSessionAiCredential(self: SessionAiHost): Promise<StoredCredential | null> {
  return readStoredCredential(self);
}

// ── The OpenAI-compatible endpoint ────────────────────────────────────────

/**
 * Serve one OpenAI-compatible request. This is the whole gateway: the loopback
 * router calls it for the session's tools, and agent.ts calls it directly for
 * the Nimbus agent.
 */
export async function handleSessionAiRequest(self: SessionAiHost, request: Request): Promise<Response> {
  const path = normalizeAiPath(new URL(request.url).pathname);
  const method = request.method.toUpperCase();

  const route = matchRoute(path, method);
  if (!route) {
    return openAiError(
      `Nimbus AI gateway: no such endpoint ${method} ${path}. Supported: GET /v1/models, POST /v1/chat/completions, POST /v1/embeddings.`,
      404,
      'invalid_request_error',
      'unknown_endpoint',
    );
  }

  const resolution = await resolveSessionAiCredential(self);
  if (!resolution.ok) {
    return openAiError(resolution.reason.message, 503, 'nimbus_gateway_error', resolution.reason.code);
  }
  const config = readSessionAiConfig(self.env);

  return route === 'models'
    ? listModels(resolution.credential, config, request.signal)
    : proxyUpstream(resolution.credential, config, route, request);
}

function matchRoute(path: string, method: string): 'models' | '/chat/completions' | '/embeddings' | null {
  if (path === '/models' && (method === 'GET' || method === 'HEAD')) return 'models';
  if (path === '/chat/completions' && method === 'POST') return '/chat/completions';
  if (path === '/embeddings' && method === 'POST') return '/embeddings';
  return null;
}

/**
 * Clients disagree about whether the `/v1` lives in the base URL or in the
 * path, and a base URL that already ends in `/v1` plus a client that adds its
 * own yields `/v1/v1/models`. Strip every leading `/v1` and route on what is
 * left, so both conventions land on the same handler.
 */
function normalizeAiPath(pathname: string): string {
  let path = pathname || '/';
  while (path === '/v1' || path.startsWith('/v1/')) path = path.slice(3) || '/';
  return path;
}

/**
 * `GET /v1/models`, the endpoint tools use to discover what they can run.
 * Cloudflare's OpenAI-compatible surface does not implement it (a GET under
 * `/ai/v1` answers 405 "GET not supported for requested URI"), so the account's
 * catalogue is enumerated from the Workers AI model search API and mapped into
 * OpenAI's shape. The list is the account's, never a hardcoded one.
 */
async function listModels(
  credential: ResolvedAiCredential,
  config: SessionAiConfig,
  signal: AbortSignal,
): Promise<Response> {
  const cached = modelCache.get(credential.accountId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return modelListResponse(cached.models, config);

  const models: OpenAiModel[] = [];
  for (let page = 1; page <= MODEL_PAGE_LIMIT; page++) {
    const url = new URL(`${NIMBUS_CLOUDFLARE_API}/accounts/${encodeURIComponent(credential.accountId)}/ai/models/search`);
    url.searchParams.set('task', TEXT_GENERATION_TASK);
    url.searchParams.set('per_page', String(MODEL_PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' },
      signal,
    });
    if (!response.ok) return translateUpstreamError(response);
    const parsed = ModelSearchResponseSchema.safeParse(await response.json().catch(() => null));
    const batch = parsed.success ? (parsed.data.result ?? []) : [];
    for (const entry of batch) {
      models.push({
        id: entry.name,
        object: 'model',
        created: Math.floor(Date.parse(entry.created_at || '') / 1000) || 0,
        owned_by: 'cloudflare',
      });
    }
    if (batch.length < MODEL_PAGE_SIZE) break;
  }

  modelCache.set(credential.accountId, { models, expiresAt: now + MODEL_CACHE_TTL_MS });
  return modelListResponse(models, config);
}

interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/**
 * The configured default is listed first: clients that pick `data[0]` when the
 * user has not chosen a model then get the model Nimbus would have chosen.
 */
function modelListResponse(models: OpenAiModel[], config: SessionAiConfig): Response {
  const ordered = [...models].sort((a, b) => Number(b.id === config.model) - Number(a.id === config.model));
  return Response.json({ object: 'list', data: ordered }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function proxyUpstream(
  credential: ResolvedAiCredential,
  config: SessionAiConfig,
  path: string,
  request: Request,
): Promise<Response> {
  // Headers are built from scratch, never forwarded: whatever the caller put in
  // its own Authorization (the placeholder key, or anything else) must not
  // reach Cloudflare, and Workers AI requests always require a gateway id.
  const headers = new Headers({
    Authorization: `Bearer ${credential.accessToken}`,
    'Content-Type': request.headers.get('Content-Type') || 'application/json',
    Accept: request.headers.get('Accept') || 'application/json',
    'cf-aig-gateway-id': config.gatewayId,
  });

  const upstream = await fetch(
    `${NIMBUS_CLOUDFLARE_API}/accounts/${encodeURIComponent(credential.accountId)}/ai/v1${path}`,
    // The caller's signal is forwarded, so a client that stops mid-stream (the
    // agent's Stop button, a tool that gives up) also stops the upstream turn
    // instead of leaving it running and billing against the account.
    { method: request.method, headers, body: request.body, duplex: 'half', signal: request.signal } as RequestInit,
  );
  if (!upstream.ok) return translateUpstreamError(upstream);

  // Body is handed back as a stream so `"stream": true` SSE reaches the caller
  // token by token instead of arriving all at once at end of turn.
  const out = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    'Cache-Control': 'no-store',
  });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * Cloudflare answers errors in its own envelope
 * (`{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`),
 * which an OpenAI client cannot read — it looks for `error.message` and reports
 * something unhelpful instead. Translate at the boundary so failures arrive as
 * a sentence the user can act on.
 */
async function translateUpstreamError(response: Response): Promise<Response> {
  const body = await response.text().catch(() => '');
  const detail = extractUpstreamMessage(safeJsonParse(body));
  const message = response.status === 401 || response.status === 403
    ? `Nimbus AI gateway: Cloudflare rejected the session credential (${detail || response.statusText || response.status}). Reconnect Cloudflare from the agent panel in your browser.`
    : `Nimbus AI gateway: Cloudflare returned ${response.status} ${detail || response.statusText}`.trim();
  return openAiError(message, response.status, 'nimbus_gateway_error', `cf_${response.status}`);
}

function openAiError(message: string, status: number, type: string, code: string): Response {
  return Response.json({ error: { message, type, code, param: null } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// ── Storage ───────────────────────────────────────────────────────────────

/** Per-isolate memo of the last cookie inspected, so the hot path stays a header read. */
const lastSeenCookie = new WeakMap<SessionAiHost, string>();
const modelCache = new Map<string, { models: OpenAiModel[]; expiresAt: number }>();

async function readStoredCredential(self: SessionAiHost): Promise<StoredCredential | null> {
  const parsed = StoredCredentialSchema.safeParse(await self.ctx.storage.get(SESSION_AI_CREDENTIAL_KEY));
  return parsed.success ? parsed.data : null;
}

async function writeStoredCredential(self: SessionAiHost, credential: StoredCredential): Promise<void> {
  await self.ctx.storage.put(SESSION_AI_CREDENTIAL_KEY, credential);
}

/**
 * Refresh when the access token is inside the expiry skew. A refresh that fails
 * means the grant is gone for good, so the credential is dropped rather than
 * retried on every request — the caller then reports "not connected", which is
 * the actionable truth.
 */
async function ensureFreshCredential(
  self: SessionAiHost,
  stored: StoredCredential,
): Promise<StoredCredential | null> {
  if (!stored.expiresAt || stored.expiresAt > Date.now() + REFRESH_SKEW_MS) return stored;
  if (!stored.refreshToken) {
    await clearSessionAiCredential(self);
    return null;
  }
  try {
    const config = readNimbusAgentOAuthConfig(self.env, '');
    const token = await requestNimbusCloudflareOAuthToken(config, {
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    });
    const next: StoredCredential = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || stored.refreshToken,
      accountId: stored.accountId,
      expiresAt: token.expires_in
        ? Date.now() + Math.max(0, token.expires_in - 30) * 1000
        : stored.expiresAt,
    };
    await writeStoredCredential(self, next);
    return next;
  } catch {
    await clearSessionAiCredential(self);
    return null;
  }
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function envBool(env: Record<string, unknown>, key: string): boolean {
  const value = envString(env, key).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
