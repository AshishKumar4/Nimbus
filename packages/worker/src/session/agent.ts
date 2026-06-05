/**
 * session/agent.ts - Nimbus session chat agent and Cloudflare OAuth flow.
 *
 * The agent lives in the session Durable Object because that is where the
 * VFS, shell, process table, port registry, and runtime package manager
 * already live. AI calls go through Cloudflare's account REST API so a
 * connected user can spend their own Workers AI quota instead of the
 * Nimbus deployment owner quota.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateText,
  jsonSchema,
  stepCountIs,
  tool as aiTool,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { BASE_PATH_HEADER, TENANT_HEADER } from '../_shared/session-router.js';
import {
  ensureProgrammaticReady,
  rpcExec,
  rpcEnsureRuntimes,
  rpcInstallRuntime,
  rpcKillProcess,
  rpcListPorts,
  rpcListProcesses,
  rpcProcessLogs,
  rpcStartProcess,
} from './programmatic.js';

interface AgentStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface AgentVfs {
  exists(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean }): void;
  readFileString(path: string): string;
  readdir(path: string): Array<{ name: string; type: string }>;
  writeFile(path: string, content: string): void;
}

interface Host {
  ctx: { storage: AgentStorage };
  env: Record<string, unknown>;
  sqliteFs?: AgentVfs | null;
}

interface OAuthStatePayload {
  v: 1;
  nonce: string;
  sessionId: string;
  tenantSegment: string;
}

interface OAuthStateCookie extends OAuthStatePayload {
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredAccount {
  id: string;
  name: string;
}

interface StoredAuth {
  mode: 'oauth';
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: number | null;
  connectedAt: number;
  accountId: string | null;
  sessionId: string;
  tenantSegment: string;
}

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: number;
  name?: string;
}

interface AiCredentials {
  mode: 'oauth' | 'owner-token';
  accessToken: string;
  accountId: string;
}

const MESSAGES_KEY = 'nimbus:agent:messages';
const AUTH_COOKIE = 'nimbus_agent_oauth';
const STATE_COOKIE = '__Host-nimbus_agent_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const AUTH_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_STORED_MESSAGES = 80;
const MAX_MODEL_MESSAGES = 24;
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 8000;
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';
const DEFAULT_GATEWAY_ID = 'default';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const CF_OAUTH_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth';
const CF_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const CF_OAUTH_USERINFO_URL = 'https://dash.cloudflare.com/oauth2/userinfo';
const SYSTEM_PROMPT =
  'You are the Nimbus session agent. You can inspect and edit the session filesystem, run shell commands, install runtimes, manage processes, and inspect preview ports. Be concise. Use tools when needed. Do not claim a command ran unless a tool result proves it.';

export async function handleAgentRequest(self: Host, request: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/agent/status' && request.method === 'GET') {
    return agentStatus(self, request, url);
  }

  if (path === '/api/agent/oauth/start' && request.method === 'POST') {
    return oauthStart(self, request, url);
  }

  if (path === '/api/agent/oauth/callback' && request.method === 'GET') {
    return oauthCallback(self, request, url);
  }

  if (path === '/api/agent/oauth/logout' && request.method === 'POST') {
    const headers = new Headers();
    appendCookie(headers, clearAuthCookie(request));
    appendCookie(headers, clearStateCookie());
    return json({ ok: true }, 200, headers);
  }

  if (path === '/api/agent/account' && request.method === 'POST') {
    return selectAccount(self, request);
  }

  if (path === '/api/agent/messages' && request.method === 'GET') {
    return json({ messages: await loadMessages(self) });
  }

  if (path === '/api/agent/messages' && request.method === 'DELETE') {
    await self.ctx.storage.delete(MESSAGES_KEY);
    return json({ ok: true, messages: [] });
  }

  if (path === '/api/agent/messages' && request.method === 'POST') {
    return agentChat(self, request, url);
  }

  return json({ error: 'unknown agent endpoint' }, 404);
}

export function parseAgentOAuthStateParam(state: string | null): OAuthStatePayload | null {
  if (!state) return null;
  const payload = decodeState(state);
  if (!payload || payload.v !== 1) return null;
  if (!isSessionId(payload.sessionId)) return null;
  if (!isTenantSegment(payload.tenantSegment)) return null;
  if (!isNonce(payload.nonce)) return null;
  return payload;
}

async function agentStatus(self: Host, request: Request, url: URL): Promise<Response> {
  const config = readConfig(self, url);
  const authResult = await loadFreshAuth(self, request);
  const auth = authResult.auth;
  let user: unknown = null;
  let accounts: StoredAccount[] = [];
  if (auth?.accessToken) {
    [user, accounts] = await Promise.all([
      fetchUserInfo(auth.accessToken).catch((e) => ({ error: String(e?.message || e) })),
      fetchAccounts(auth.accessToken).catch(() => [] as StoredAccount[]),
    ]);
  }
  const ownerConfigured = !!(config.ownerAccountId && config.ownerToken);
  const oauthConfigured = !!config.oauthClientId;
  const connected = !!auth?.accessToken || ownerConfigured;
  const headers = new Headers();
  applyAuthCookieResult(headers, authResult);
  return json({
    ok: true,
    configured: oauthConfigured || ownerConfigured,
    model: config.model,
    gatewayId: config.gatewayId,
    oauth: {
      configured: oauthConfigured,
      connected: !!auth?.accessToken,
      clientId: oauthConfigured ? config.oauthClientId : null,
      scopes: config.oauthScopes,
      user,
      accounts,
      accountId: auth?.accountId ?? null,
      expiresAt: auth?.expiresAt ?? null,
    },
    ownerToken: {
      configured: ownerConfigured,
      accountId: ownerConfigured ? config.ownerAccountId : null,
    },
    connected,
    capabilities: [
      'chat',
      'exec',
      'files',
      'runtimes',
      'processes',
      'ports',
    ],
  }, 200, headers);
}

async function oauthStart(self: Host, request: Request, url: URL): Promise<Response> {
  const config = readConfig(self, url);
  if (!config.oauthClientId) {
    return json({
      error: 'Cloudflare OAuth is not configured',
      code: 'E_AGENT_OAUTH_NOT_CONFIGURED',
    }, 409);
  }

  const basePath = request.headers.get(BASE_PATH_HEADER) || '';
  const sessionId = basePath.startsWith('/s/') ? basePath.slice(3) : '';
  const tenantSegment = request.headers.get(TENANT_HEADER) || 'legacy:public:_';
  if (!isSessionId(sessionId) || !isTenantSegment(tenantSegment)) {
    return json({ error: 'invalid session route', code: 'E_AGENT_SESSION' }, 400);
  }

  const nonce = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const redirectUri = config.redirectUri;
  const payload: OAuthStatePayload = { v: 1, nonce, sessionId, tenantSegment };
  const state = encodeState(payload);
  const now = Date.now();
  const stored: OAuthStateCookie = {
    ...payload,
    codeVerifier,
    redirectUri,
    createdAt: now,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };

  const authUrl = new URL(CF_OAUTH_AUTH_URL);
  authUrl.searchParams.set('client_id', config.oauthClientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (config.oauthScopes.length > 0) {
    authUrl.searchParams.set('scope', config.oauthScopes.join(' '));
  }

  const headers = new Headers();
  try {
    appendCookie(headers, await sealStateCookie(self, stored));
  } catch (e: any) {
    return json({
      error: e?.message || String(e),
      code: 'E_AGENT_COOKIE_SECRET',
    }, 409);
  }
  return json({ ok: true, authUrl: authUrl.toString(), expiresAt: stored.expiresAt }, 200, headers);
}

async function oauthCallback(self: Host, request: Request, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const payload = parseAgentOAuthStateParam(url.searchParams.get('state'));
  if (error) return oauthResultHtml(false, 'Cloudflare authorization failed.', payload?.sessionId);
  if (!code || !payload) return oauthResultHtml(false, 'OAuth callback is missing code or state.', payload?.sessionId);

  const stored = await loadStateCookie(self, request);
  if (!stored || stored.expiresAt < Date.now()) {
    return oauthResultHtml(false, 'OAuth session expired. Connect again.', payload.sessionId);
  }
  if (
    stored.sessionId !== payload.sessionId ||
    stored.tenantSegment !== payload.tenantSegment ||
    stored.nonce !== payload.nonce
  ) {
    return oauthResultHtml(false, 'OAuth state did not match this session.', payload.sessionId);
  }

  try {
    const token = await exchangeCode(self, code, stored.codeVerifier, stored.redirectUri);
    const accessToken = String(token.access_token || '');
    if (!accessToken) throw new Error('Cloudflare did not return an access token');
    const accounts = await fetchAccounts(accessToken).catch(() => [] as StoredAccount[]);
    const auth: StoredAuth = {
      mode: 'oauth',
      accessToken,
      refreshToken: token.refresh_token ? String(token.refresh_token) : undefined,
      tokenType: token.token_type ? String(token.token_type) : 'Bearer',
      expiresAt: token.expires_in ? Date.now() + Math.max(0, Number(token.expires_in) - 30) * 1000 : null,
      connectedAt: Date.now(),
      accountId: accounts[0]?.id ?? null,
      sessionId: payload.sessionId,
      tenantSegment: payload.tenantSegment,
    };
    const headers = new Headers();
    appendCookie(headers, clearStateCookie());
    appendCookie(headers, await sealAuthCookie(self, request, auth));
    return oauthResultHtml(true, 'Cloudflare connected.', payload.sessionId, headers);
  } catch (e: any) {
    const headers = new Headers();
    appendCookie(headers, clearStateCookie());
    return oauthResultHtml(false, e?.message || String(e), payload.sessionId, headers);
  }
}

async function selectAccount(self: Host, request: Request): Promise<Response> {
  const body = await readJson(request);
  const accountId = String(body?.accountId || '');
  if (!isAccountId(accountId)) return json({ error: 'invalid account id' }, 400);
  const authResult = await loadFreshAuth(self, request);
  const auth = authResult.auth;
  if (!auth) return json({ error: 'not connected' }, 409);
  const accounts = await fetchAccounts(auth.accessToken).catch(() => [] as StoredAccount[]);
  if (!accounts.some((a) => a.id === accountId)) {
    return json({ error: 'account is not available for this OAuth token' }, 400);
  }
  const next = { ...auth, accountId };
  const headers = new Headers();
  applyAuthCookieResult(headers, authResult);
  appendCookie(headers, await sealAuthCookie(self, request, next));
  return json({ ok: true, accountId }, 200, headers);
}

async function agentChat(self: Host, request: Request, url: URL): Promise<Response> {
  const body = await readJson(request);
  const text = String(body?.message || '').trim();
  if (!text) return json({ error: 'message is required' }, 400);

  const credentialResult = await loadAiCredentials(self, request, url);
  if (!credentialResult.credentials) {
    const headers = new Headers();
    applyAuthCookieResult(headers, credentialResult.authResult);
    return json({
      error: 'Connect Cloudflare or configure an owner API token before chatting.',
      code: 'E_AGENT_AI_NOT_CONFIGURED',
    }, 409, headers);
  }

  const config = readConfig(self, url);
  const messages = await loadMessages(self);
  const userMessage = makeMessage('user', text);
  messages.push(userMessage);
  await saveMessages(self, messages);

  try {
    const result = await runAiSdkTurn(self, config, credentialResult.credentials, messages);
    const assistantText = result.text || 'Done.';
    const assistantMessage = makeMessage('assistant', assistantText);
    const nextMessages = [...messages, ...result.toolEvents, assistantMessage];
    await saveMessages(self, nextMessages);
    const headers = new Headers();
    applyAuthCookieResult(headers, credentialResult.authResult);
    return json({
      ok: true,
      message: assistantMessage,
      toolEvents: result.toolEvents,
      messages: trimMessagesForClient(nextMessages),
    }, 200, headers);
  } catch (e: any) {
    const headers = new Headers();
    applyAuthCookieResult(headers, credentialResult.authResult);
    return json({
      error: e?.message || String(e),
      code: 'E_AGENT_TURN_FAILED',
      messages: trimMessagesForClient(messages),
    }, 502, headers);
  }
}

async function runAiSdkTurn(
  self: Host,
  config: ReturnType<typeof readConfig>,
  credentials: AiCredentials,
  messages: StoredMessage[],
): Promise<{ text: string; toolEvents: StoredMessage[] }> {
  const model = createCloudflareModel(config, credentials);
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: buildModelMessages(messages),
    tools: createAiSdkTools(self),
    stopWhen: stepCountIs(MAX_TOOL_ROUNDS),
    maxRetries: 0,
  });
  const toolEvents = collectToolEvents(result);
  return {
    text: String(result.text || '').trim() || summarizeToolEvents(toolEvents),
    toolEvents,
  };
}

function createCloudflareModel(config: ReturnType<typeof readConfig>, credentials: AiCredentials) {
  const headers: Record<string, string> = {};
  if (config.gatewayId) headers['cf-aig-gateway-id'] = config.gatewayId;
  const provider = createOpenAICompatible({
    name: 'nimbusCloudflare',
    apiKey: credentials.accessToken,
    baseURL: `${CLOUDFLARE_API}/accounts/${encodeURIComponent(credentials.accountId)}/ai/v1`,
    headers,
  });
  return provider.chatModel(config.model);
}

function buildModelMessages(messages: StoredMessage[]): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  const recent = messages.slice(-MAX_MODEL_MESSAGES);
  for (const message of recent) {
    if (message.role === 'tool') continue;
    modelMessages.push({ role: message.role, content: message.content });
  }
  return modelMessages;
}

function createAiSdkTools(self: Host): ToolSet {
  return {
    exec: aiTool({
      description: 'Run a shell command in the Nimbus session.',
      inputSchema: toolSchema({
        command: stringProp('Command line to execute.'),
        cwd: stringProp('Working directory. Defaults to /home/user.'),
        timeoutMs: numberProp('Command timeout in milliseconds.'),
      }, ['command']),
      execute: async (args: any) => runTool(self, 'exec', args),
    }),
    read_file: aiTool({
      description: 'Read a UTF-8 file from the Nimbus VFS.',
      inputSchema: toolSchema({
        path: stringProp('Absolute or /home/user-relative path.'),
      }, ['path']),
      execute: async (args: any) => runTool(self, 'read_file', args),
    }),
    write_file: aiTool({
      description: 'Write a UTF-8 file into the Nimbus VFS, creating parent directories.',
      inputSchema: toolSchema({
        path: stringProp('Absolute or /home/user-relative path.'),
        content: stringProp('File content.'),
      }, ['path', 'content']),
      execute: async (args: any) => runTool(self, 'write_file', args),
    }),
    list_files: aiTool({
      description: 'List files in a Nimbus VFS directory.',
      inputSchema: toolSchema({
        path: stringProp('Directory path. Defaults to /home/user.'),
      }, []),
      execute: async (args: any) => runTool(self, 'list_files', args),
    }),
    install_runtime: aiTool({
      description: 'Install or ensure a Nimbus runtime package.',
      inputSchema: toolSchema({
        spec: stringProp('Runtime spec such as python, clang, or ruby.'),
      }, ['spec']),
      execute: async (args: any) => runTool(self, 'install_runtime', args),
    }),
    ensure_runtime: aiTool({
      description: 'Ensure a Nimbus runtime package is installed.',
      inputSchema: toolSchema({
        spec: stringProp('Runtime spec such as python, clang, or ruby.'),
      }, ['spec']),
      execute: async (args: any) => runTool(self, 'ensure_runtime', args),
    }),
    start_process: aiTool({
      description: 'Start a long-running command and return process and port metadata.',
      inputSchema: toolSchema({
        command: stringProp('Command line to start.'),
        cwd: stringProp('Working directory. Defaults to /home/user.'),
      }, ['command']),
      execute: async (args: any) => runTool(self, 'start_process', args),
    }),
    list_processes: aiTool({
      description: 'List session processes.',
      inputSchema: toolSchema({}, []),
      execute: async (args: any) => runTool(self, 'list_processes', args),
    }),
    kill_process: aiTool({
      description: 'Kill a session process by pid.',
      inputSchema: toolSchema({
        pid: numberProp('Process id.'),
      }, ['pid']),
      execute: async (args: any) => runTool(self, 'kill_process', args),
    }),
    process_logs: aiTool({
      description: 'Read recent process logs.',
      inputSchema: toolSchema({
        pid: numberProp('Process id.'),
        lines: numberProp('Number of log lines. Defaults to 200.'),
      }, ['pid']),
      execute: async (args: any) => runTool(self, 'process_logs', args),
    }),
    list_ports: aiTool({
      description: 'List exposed preview ports.',
      inputSchema: toolSchema({}, []),
      execute: async (args: any) => runTool(self, 'list_ports', args),
    }),
  };
}

function collectToolEvents(result: { steps?: Array<{ toolResults?: any[] }> }): StoredMessage[] {
  const events: StoredMessage[] = [];
  for (const step of result.steps || []) {
    for (const toolResult of step.toolResults || []) {
      const toolName = String(toolResult?.toolName || 'tool');
      const payload = {
        tool: toolName,
        input: toolResult?.input,
        output: toolResult?.output,
      };
      events.push(makeMessage('tool', truncate(safeJsonStringify(payload), MAX_TOOL_RESULT_CHARS), toolName));
    }
  }
  return events;
}

function summarizeToolEvents(events: StoredMessage[]): string {
  return events.length > 0 ? 'Done.' : '';
}

function toolSchema(properties: Record<string, unknown>, required: string[]) {
  return jsonSchema({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
}

async function runTool(self: Host, name: string, args: any): Promise<unknown> {
  try {
    if (name === 'exec') {
      return rpcExec(self, String(args.command || ''), {
        cwd: args.cwd ? String(args.cwd) : '/home/user',
        timeoutMs: clampNumber(args.timeoutMs, 1_000, 120_000, 30_000),
      });
    }
    if (name === 'read_file') {
      await ensureProgrammaticReady(self);
      const path = normalizeVfsPath(args.path || '/home/user');
      return { path: '/' + path, content: self.sqliteFs!.readFileString(path) };
    }
    if (name === 'write_file') {
      await ensureProgrammaticReady(self);
      const path = normalizeVfsPath(args.path || '/home/user/file.txt');
      ensureParentDirs(self.sqliteFs!, path);
      self.sqliteFs!.writeFile(path, String(args.content ?? ''));
      return { ok: true, path: '/' + path, bytes: String(args.content ?? '').length };
    }
    if (name === 'list_files') {
      await ensureProgrammaticReady(self);
      const path = normalizeVfsPath(args.path || '/home/user');
      const base = trimTrailingSlash(path);
      const entries = self.sqliteFs!.readdir(path).map((entry: any) => ({
        name: entry.name,
        type: entry.type,
        path: '/' + base + '/' + entry.name,
      }));
      return { path: '/' + path, entries };
    }
    if (name === 'install_runtime') {
      const spec = String(args.spec || '').trim();
      if (!spec) return { error: 'spec is required' };
      return rpcInstallRuntime(self, spec);
    }
    if (name === 'ensure_runtime') {
      const spec = String(args.spec || '').trim();
      if (!spec) return { error: 'spec is required' };
      return rpcEnsureRuntimes(self, [spec]);
    }
    if (name === 'start_process') {
      return rpcStartProcess(self, String(args.command || ''), {
        cwd: args.cwd ? String(args.cwd) : '/home/user',
      });
    }
    if (name === 'list_processes') return rpcListProcesses(self);
    if (name === 'kill_process') return rpcKillProcess(self, Number(args.pid));
    if (name === 'process_logs') {
      return rpcProcessLogs(self, Number(args.pid), {
        lines: clampNumber(args.lines, 1, 1000, 200),
      });
    }
    if (name === 'list_ports') return rpcListPorts(self);
    return { error: `unknown tool: ${name}` };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

interface AuthCookieResult {
  auth: StoredAuth | null;
  setCookie?: string;
  clearCookie?: string;
}

async function loadAiCredentials(
  self: Host,
  request: Request,
  url: URL,
): Promise<{ credentials: AiCredentials | null; authResult: AuthCookieResult | null }> {
  const config = readConfig(self, url);
  const authResult = await loadFreshAuth(self, request);
  const auth = authResult.auth;
  if (auth?.accessToken && auth.accountId) {
    return {
      authResult,
      credentials: {
        mode: 'oauth',
        accessToken: auth.accessToken,
        accountId: auth.accountId,
      },
    };
  }
  if (config.ownerToken && config.ownerAccountId) {
    return {
      authResult,
      credentials: {
        mode: 'owner-token',
        accessToken: config.ownerToken,
        accountId: config.ownerAccountId,
      },
    };
  }
  return { credentials: null, authResult };
}

async function loadFreshAuth(self: Host, request: Request): Promise<AuthCookieResult> {
  const auth = await loadAuth(self, request);
  if (!auth) return { auth: null };
  if (!auth.expiresAt || auth.expiresAt > Date.now() + 60_000) return { auth };
  if (!auth.refreshToken) {
    return { auth: null, clearCookie: clearAuthCookie(request) };
  }
  try {
    const token = await refreshToken(self, auth.refreshToken);
    const next: StoredAuth = {
      ...auth,
      accessToken: String(token.access_token || auth.accessToken),
      refreshToken: token.refresh_token ? String(token.refresh_token) : auth.refreshToken,
      tokenType: token.token_type ? String(token.token_type) : auth.tokenType,
      expiresAt: token.expires_in ? Date.now() + Math.max(0, Number(token.expires_in) - 30) * 1000 : auth.expiresAt,
    };
    return {
      auth: next,
      setCookie: await sealAuthCookie(self, request, next),
    };
  } catch {
    return { auth: null, clearCookie: clearAuthCookie(request) };
  }
}

async function exchangeCode(self: Host, code: string, codeVerifier: string, redirectUri: string): Promise<any> {
  const config = readConfig(self, new URL(redirectUri));
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

async function refreshToken(self: Host, refreshTokenValue: string): Promise<any> {
  const config = readConfig(self, null);
  return tokenRequest(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
  });
}

async function tokenRequest(config: ReturnType<typeof readConfig>, fields: Record<string, string>): Promise<any> {
  if (!config.oauthClientId) throw new Error('OAuth client id is not configured');
  const body = new URLSearchParams({
    client_id: config.oauthClientId,
    ...fields,
  });
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  });
  if (config.oauthClientSecret) {
    headers.set('Authorization', 'Basic ' + base64(`${config.oauthClientId}:${config.oauthClientSecret}`));
  }
  const response = await fetch(CF_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const detail = payload?.error_description || payload?.error || response.statusText;
    throw new Error(`Cloudflare token exchange failed: ${detail}`);
  }
  return payload;
}

async function fetchUserInfo(accessToken: string): Promise<unknown> {
  const response = await fetch(CF_OAUTH_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('userinfo request failed');
  return response.json();
}

async function fetchAccounts(accessToken: string): Promise<StoredAccount[]> {
  const response = await fetch(`${CLOUDFLARE_API}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error('accounts request failed');
  const accounts = Array.isArray(payload?.result) ? payload.result : [];
  return accounts
    .map((account: any) => ({ id: String(account.id || ''), name: String(account.name || account.id || '') }))
    .filter((account: StoredAccount) => isAccountId(account.id));
}

async function loadAuth(self: Host, request: Request): Promise<StoredAuth | null> {
  const value = readCookie(request, AUTH_COOKIE);
  if (!value) return null;
  const auth = await unsealCookie<StoredAuth>(self, value).catch(() => null);
  if (!auth || auth.mode !== 'oauth' || !auth.accessToken) return null;
  const route = routeContext(request);
  if (
    auth.sessionId !== route.sessionId ||
    auth.tenantSegment !== route.tenantSegment
  ) {
    return null;
  }
  return auth;
}

async function loadStateCookie(self: Host, request: Request): Promise<OAuthStateCookie | null> {
  const value = readCookie(request, STATE_COOKIE);
  if (!value) return null;
  const state = await unsealCookie<OAuthStateCookie>(self, value).catch(() => null);
  if (!state || state.v !== 1 || !isNonce(state.nonce)) return null;
  if (!isSessionId(state.sessionId) || !isTenantSegment(state.tenantSegment)) return null;
  if (!state.codeVerifier || !state.redirectUri) return null;
  return state;
}

async function sealStateCookie(self: Host, state: OAuthStateCookie): Promise<string> {
  return serializeCookie(STATE_COOKIE, await sealCookie(self, state), {
    path: '/',
    maxAge: Math.ceil(OAUTH_STATE_TTL_MS / 1000),
  });
}

async function sealAuthCookie(self: Host, request: Request, auth: StoredAuth): Promise<string> {
  return serializeCookie(AUTH_COOKIE, await sealCookie(self, auth), {
    path: authCookiePath(request),
    maxAge: AUTH_COOKIE_TTL_SECONDS,
  });
}

function clearStateCookie(): string {
  return serializeCookie(STATE_COOKIE, '', { path: '/', maxAge: 0 });
}

function clearAuthCookie(request: Request): string {
  return serializeCookie(AUTH_COOKIE, '', { path: authCookiePath(request), maxAge: 0 });
}

function applyAuthCookieResult(headers: Headers, result: AuthCookieResult | null | undefined): void {
  if (!result) return;
  if (result.clearCookie) appendCookie(headers, result.clearCookie);
  if (result.setCookie) appendCookie(headers, result.setCookie);
}

function appendCookie(headers: Headers, cookie: string): void {
  headers.append('Set-Cookie', cookie);
}

async function sealCookie(self: Host, value: unknown): Promise<string> {
  const key = await cookieCryptoKey(self);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return 'v1.' + base64Url(packed);
}

async function unsealCookie<T>(self: Host, value: string): Promise<T | null> {
  if (!value.startsWith('v1.')) return null;
  const packed = base64UrlDecode(value.slice(3));
  if (packed.length <= 12) return null;
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const key = await cookieCryptoKey(self);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function cookieCryptoKey(self: Host): Promise<CryptoKey> {
  const env = self.env as any;
  const secret = envString(env, 'NIMBUS_AGENT_COOKIE_SECRET') || envString(env, 'JWT_SECRET');
  if (!secret || secret.length < 32) {
    throw new Error('Set NIMBUS_AGENT_COOKIE_SECRET or JWT_SECRET to a 32+ character value before enabling Cloudflare OAuth');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function serializeCookie(
  name: string,
  value: string,
  opts: { path: string; maxAge: number },
): string {
  return [
    `${name}=${value}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const target = name + '=';
  for (const part of header.split(';')) {
    const item = part.trim();
    if (item.startsWith(target)) return item.slice(target.length);
  }
  return null;
}

function authCookiePath(request: Request): string {
  const base = request.headers.get(BASE_PATH_HEADER) || '';
  return base.startsWith('/s/') ? base : '/s';
}

function routeContext(request: Request): { sessionId: string; tenantSegment: string } {
  const base = request.headers.get(BASE_PATH_HEADER) || '';
  const sessionId = base.startsWith('/s/') ? base.slice(3).split('/')[0] : '';
  return {
    sessionId,
    tenantSegment: request.headers.get(TENANT_HEADER) || 'legacy:public:_',
  };
}

async function loadMessages(self: Host): Promise<StoredMessage[]> {
  const messages = await self.ctx.storage.get(MESSAGES_KEY) as StoredMessage[] | undefined;
  return Array.isArray(messages) ? messages : [];
}

async function saveMessages(self: Host, messages: StoredMessage[]): Promise<void> {
  await self.ctx.storage.put(MESSAGES_KEY, trimMessagesForClient(messages));
}

function trimMessagesForClient(messages: StoredMessage[]): StoredMessage[] {
  return messages.slice(-MAX_STORED_MESSAGES);
}

function makeMessage(role: StoredMessage['role'], content: string, name?: string): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    ...(name ? { name } : {}),
  };
}

function readConfig(self: Host, url: URL | null) {
  const env = self.env as any;
  const origin = url?.origin || '';
  const redirectUri = envString(env, 'NIMBUS_CF_OAUTH_REDIRECT_URI')
    || (origin ? `${origin}/api/nimbus/oauth/callback` : '');
  return {
    oauthClientId: envString(env, 'NIMBUS_CF_OAUTH_CLIENT_ID'),
    oauthClientSecret: envString(env, 'NIMBUS_CF_OAUTH_CLIENT_SECRET'),
    oauthScopes: splitWords(envString(env, 'NIMBUS_CF_OAUTH_SCOPES')),
    redirectUri,
    ownerAccountId: envString(env, 'NIMBUS_CLOUDFLARE_ACCOUNT_ID'),
    ownerToken: envString(env, 'NIMBUS_CLOUDFLARE_API_TOKEN'),
    model: envString(env, 'NIMBUS_AGENT_MODEL') || DEFAULT_MODEL,
    gatewayId: envString(env, 'NIMBUS_AGENT_GATEWAY_ID') || DEFAULT_GATEWAY_ID,
  };
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function splitWords(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function stringProp(description: string) {
  return { type: 'string', description };
}

function numberProp(description: string) {
  return { type: 'number', description };
}

function normalizeVfsPath(input: unknown): string {
  const raw = String(input || '/home/user').trim() || '/home/user';
  const absolute = raw.startsWith('/') ? raw : '/home/user/' + raw;
  const parts = absolute.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/') || 'home/user';
}

function ensureParentDirs(vfs: any, path: string): void {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (dir && !vfs.exists(dir)) vfs.mkdir(dir, { recursive: true });
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function truncate(value: string, maxChars: number): string {
  const text = String(value);
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n[truncated]';
}

function safeJsonStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { return null; }
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'no-store');
  return Response.json(body, {
    status,
    headers: responseHeaders,
  });
}

function oauthResultHtml(
  ok: boolean,
  message: string,
  sessionId?: string,
  headers?: HeadersInit,
): Response {
  const sessionPath = sessionId && isSessionId(sessionId) ? `/s/${sessionId}/?agent=1` : '/';
  const safeMessage = escapeHtml(message);
  const safePath = escapeHtml(sessionPath);
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  return new Response(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nimbus Agent</title>
<style>
body{margin:0;background:#0d1117;color:#c9d1d9;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:520px;padding:28px;text-align:center}
h1{font-size:20px;color:${ok ? '#3fb950' : '#ff7b72'};margin:0 0 10px}
a{color:#58a6ff}
</style></head><body><main>
<h1>${ok ? 'Connected' : 'Connection failed'}</h1>
<p>${safeMessage}</p>
<p><a href="${safePath}">Return to Nimbus</a></p>
</main>
<script>
try { if (window.opener) window.opener.postMessage({ type: 'nimbus-agent-oauth', ok: ${ok ? 'true' : 'false'} }, location.origin); } catch {}
setTimeout(function(){ try { window.close(); } catch {} }, 700);
</script>
</body></html>`, {
    status: ok ? 200 : 400,
    headers: responseHeaders,
  });
}

function encodeState(payload: OAuthStatePayload): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeState(state: string): OAuthStatePayload | null {
  try {
    const bytes = base64UrlDecode(state);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): Uint8Array {
  let normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  while (normalized.length % 4 !== 0) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

function isSessionId(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    const ok =
      (ch >= 48 && ch <= 57) ||
      (ch >= 97 && ch <= 122) ||
      ch === 45;
    if (!ok) return false;
  }
  return true;
}

function isTenantSegment(value: string): boolean {
  if (value.length < 3 || value.length > 256) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    const ok =
      (ch >= 48 && ch <= 57) ||
      (ch >= 65 && ch <= 90) ||
      (ch >= 97 && ch <= 122) ||
      ch === 45 || ch === 46 || ch === 58 || ch === 95;
    if (!ok) return false;
  }
  return true;
}

function isNonce(value: string): boolean {
  if (value.length < 16 || value.length > 128) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    const ok =
      (ch >= 48 && ch <= 57) ||
      (ch >= 65 && ch <= 90) ||
      (ch >= 97 && ch <= 122) ||
      ch === 45 || ch === 95;
    if (!ok) return false;
  }
  return true;
}

function isAccountId(value: string): boolean {
  if (value.length < 16 || value.length > 64) return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    const ok =
      (ch >= 48 && ch <= 57) ||
      (ch >= 65 && ch <= 70) ||
      (ch >= 97 && ch <= 102);
    if (!ok) return false;
  }
  return true;
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
