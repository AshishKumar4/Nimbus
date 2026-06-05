/**
 * session/agent.ts - Nimbus session chat agent and Cloudflare OAuth flow.
 *
 * The agent lives in the session Durable Object because that is where the
 * VFS, shell, process table, port registry, and runtime package manager
 * already live. AI calls go through Cloudflare's account REST API so a
 * connected user can spend their own Workers AI quota instead of the
 * Nimbus deployment owner quota.
 */

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

interface StoredOAuthState extends OAuthStatePayload {
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
  user?: unknown;
  accounts: StoredAccount[];
  accountId: string | null;
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

const AUTH_KEY = 'nimbus:agent:auth';
const MESSAGES_KEY = 'nimbus:agent:messages';
const OAUTH_STATE_PREFIX = 'nimbus:agent:oauth-state:';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
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

export async function handleAgentRequest(self: Host, request: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/agent/status' && request.method === 'GET') {
    return json(await agentStatus(self, url));
  }

  if (path === '/api/agent/oauth/start' && request.method === 'POST') {
    return oauthStart(self, request, url);
  }

  if (path === '/api/agent/oauth/callback' && request.method === 'GET') {
    return oauthCallback(self, url);
  }

  if (path === '/api/agent/oauth/logout' && request.method === 'POST') {
    await self.ctx.storage.delete(AUTH_KEY);
    return json({ ok: true });
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

async function agentStatus(self: Host, url: URL) {
  const config = readConfig(self, url);
  const auth = await loadAuth(self);
  const ownerConfigured = !!(config.ownerAccountId && config.ownerToken);
  const oauthConfigured = !!config.oauthClientId;
  const connected = !!auth?.accessToken || ownerConfigured;
  return {
    ok: true,
    configured: oauthConfigured || ownerConfigured,
    model: config.model,
    gatewayId: config.gatewayId,
    oauth: {
      configured: oauthConfigured,
      connected: !!auth?.accessToken,
      clientId: oauthConfigured ? config.oauthClientId : null,
      scopes: config.oauthScopes,
      user: auth?.user ?? null,
      accounts: auth?.accounts ?? [],
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
  };
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
  const stored: StoredOAuthState = {
    ...payload,
    codeVerifier,
    redirectUri,
    createdAt: now,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };
  await self.ctx.storage.put(OAUTH_STATE_PREFIX + nonce, stored);

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

  return json({ ok: true, authUrl: authUrl.toString(), expiresAt: stored.expiresAt });
}

async function oauthCallback(self: Host, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const payload = parseAgentOAuthStateParam(url.searchParams.get('state'));
  if (error) return oauthResultHtml(false, 'Cloudflare authorization failed.', payload?.sessionId);
  if (!code || !payload) return oauthResultHtml(false, 'OAuth callback is missing code or state.', payload?.sessionId);

  const stateKey = OAUTH_STATE_PREFIX + payload.nonce;
  const stored = await self.ctx.storage.get(stateKey) as StoredOAuthState | undefined;
  await self.ctx.storage.delete(stateKey);
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
    const [user, accounts] = await Promise.all([
      fetchUserInfo(accessToken).catch((e) => ({ error: String(e?.message || e) })),
      fetchAccounts(accessToken).catch(() => [] as StoredAccount[]),
    ]);
    const auth: StoredAuth = {
      mode: 'oauth',
      accessToken,
      refreshToken: token.refresh_token ? String(token.refresh_token) : undefined,
      tokenType: token.token_type ? String(token.token_type) : 'Bearer',
      expiresAt: token.expires_in ? Date.now() + Math.max(0, Number(token.expires_in) - 30) * 1000 : null,
      connectedAt: Date.now(),
      user,
      accounts,
      accountId: accounts[0]?.id ?? null,
    };
    await self.ctx.storage.put(AUTH_KEY, auth);
    return oauthResultHtml(true, 'Cloudflare connected.', payload.sessionId);
  } catch (e: any) {
    return oauthResultHtml(false, e?.message || String(e), payload.sessionId);
  }
}

async function selectAccount(self: Host, request: Request): Promise<Response> {
  const body = await readJson(request);
  const accountId = String(body?.accountId || '');
  if (!isAccountId(accountId)) return json({ error: 'invalid account id' }, 400);
  const auth = await loadAuth(self);
  if (!auth) return json({ error: 'not connected' }, 409);
  if (!auth.accounts.some((a) => a.id === accountId)) {
    return json({ error: 'account is not available for this OAuth token' }, 400);
  }
  auth.accountId = accountId;
  await self.ctx.storage.put(AUTH_KEY, auth);
  return json({ ok: true, accountId });
}

async function agentChat(self: Host, request: Request, url: URL): Promise<Response> {
  const body = await readJson(request);
  const text = String(body?.message || '').trim();
  if (!text) return json({ error: 'message is required' }, 400);

  const credentials = await loadAiCredentials(self, url);
  if (!credentials) {
    return json({
      error: 'Connect Cloudflare or configure an owner API token before chatting.',
      code: 'E_AGENT_AI_NOT_CONFIGURED',
    }, 409);
  }

  const config = readConfig(self, url);
  const messages = await loadMessages(self);
  const userMessage = makeMessage('user', text);
  messages.push(userMessage);
  await saveMessages(self, messages);

  const apiMessages = buildModelMessages(messages);
  const toolEvents: StoredMessage[] = [];
  let assistantText = '';
  let finishReason = 'stop';

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await callChatCompletion(config, credentials, apiMessages);
      const choice = completion.choices?.[0] ?? null;
      const message = choice?.message ?? {};
      const content = message.content;
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      if (toolCalls.length === 0) {
        assistantText = typeof content === 'string' ? content : stringifyContent(content);
        finishReason = String(choice?.finish_reason || 'stop');
        break;
      }

      apiMessages.push({
        role: 'assistant',
        content: typeof content === 'string' ? content : '',
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const toolName = String(call?.function?.name || '');
        const argsText = String(call?.function?.arguments || '{}');
        const args = parseToolArgs(argsText);
        const result = await runTool(self, toolName, args);
        const contentText = truncate(JSON.stringify(result), MAX_TOOL_RESULT_CHARS);
        apiMessages.push({
          role: 'tool',
          tool_call_id: String(call?.id || toolName || 'tool'),
          name: toolName,
          content: contentText,
        });
        toolEvents.push(makeMessage('tool', contentText, toolName));
      }
    }
  } catch (e: any) {
    return json({
      error: e?.message || String(e),
      code: 'E_AGENT_TURN_FAILED',
      messages: trimMessagesForClient(messages),
    }, 502);
  }

  if (!assistantText) {
    assistantText = finishReason === 'stop'
      ? 'Done.'
      : 'I stopped after the tool limit. Send a follow-up to continue.';
  }

  const assistantMessage = makeMessage('assistant', assistantText);
  const nextMessages = [...messages, ...toolEvents, assistantMessage];
  await saveMessages(self, nextMessages);
  return json({
    ok: true,
    message: assistantMessage,
    toolEvents,
    messages: trimMessagesForClient(nextMessages),
  });
}

function buildModelMessages(messages: StoredMessage[]) {
  const modelMessages: any[] = [
    {
      role: 'system',
      content:
        'You are the Nimbus session agent. You can use tools to inspect and edit the session filesystem, run shell commands, install runtimes, manage processes, and inspect preview ports. Be concise. Use tools when needed. Do not claim a command ran unless a tool result proves it.',
    },
  ];
  const recent = messages.slice(-MAX_MODEL_MESSAGES);
  for (const message of recent) {
    if (message.role === 'tool') continue;
    modelMessages.push({ role: message.role, content: message.content });
  }
  return modelMessages;
}

async function callChatCompletion(config: ReturnType<typeof readConfig>, credentials: AiCredentials, messages: any[]) {
  const endpoint = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(credentials.accountId)}/ai/v1/chat/completions`;
  const headers = new Headers({
    Authorization: `Bearer ${credentials.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  if (config.gatewayId) headers.set('cf-aig-gateway-id', config.gatewayId);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: agentTools(),
      tool_choice: 'auto',
    }),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const detail = payload?.errors?.[0]?.message || payload?.error || payload?.message || response.statusText;
    throw new Error(`Cloudflare AI request failed: ${detail}`);
  }
  if (payload?.choices) return payload;
  if (payload?.result?.choices) return payload.result;
  if (typeof payload?.result?.response === 'string') {
    return { choices: [{ message: { content: payload.result.response }, finish_reason: 'stop' }] };
  }
  return payload;
}

function agentTools() {
  return [
    tool('exec', 'Run a shell command in the Nimbus session.', {
      command: stringProp('Command line to execute.'),
      cwd: stringProp('Working directory. Defaults to /home/user.'),
      timeoutMs: numberProp('Command timeout in milliseconds.'),
    }, ['command']),
    tool('read_file', 'Read a UTF-8 file from the Nimbus VFS.', {
      path: stringProp('Absolute or /home/user-relative path.'),
    }, ['path']),
    tool('write_file', 'Write a UTF-8 file into the Nimbus VFS, creating parent directories.', {
      path: stringProp('Absolute or /home/user-relative path.'),
      content: stringProp('File content.'),
    }, ['path', 'content']),
    tool('list_files', 'List files in a Nimbus VFS directory.', {
      path: stringProp('Directory path. Defaults to /home/user.'),
    }, []),
    tool('install_runtime', 'Install or ensure a Nimbus runtime package.', {
      spec: stringProp('Runtime spec such as python, clang, or ruby.'),
    }, ['spec']),
    tool('ensure_runtime', 'Ensure a Nimbus runtime package is installed.', {
      spec: stringProp('Runtime spec such as python, clang, or ruby.'),
    }, ['spec']),
    tool('start_process', 'Start a long-running command and return process and port metadata.', {
      command: stringProp('Command line to start.'),
      cwd: stringProp('Working directory. Defaults to /home/user.'),
    }, ['command']),
    tool('list_processes', 'List session processes.', {}, []),
    tool('kill_process', 'Kill a session process by pid.', {
      pid: numberProp('Process id.'),
    }, ['pid']),
    tool('process_logs', 'Read recent process logs.', {
      pid: numberProp('Process id.'),
      lines: numberProp('Number of log lines. Defaults to 200.'),
    }, ['pid']),
    tool('list_ports', 'List exposed preview ports.', {}, []),
  ];
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

async function loadAiCredentials(self: Host, url: URL): Promise<AiCredentials | null> {
  const config = readConfig(self, url);
  const auth = await loadFreshAuth(self);
  if (auth?.accessToken && auth.accountId) {
    return {
      mode: 'oauth',
      accessToken: auth.accessToken,
      accountId: auth.accountId,
    };
  }
  if (config.ownerToken && config.ownerAccountId) {
    return {
      mode: 'owner-token',
      accessToken: config.ownerToken,
      accountId: config.ownerAccountId,
    };
  }
  return null;
}

async function loadFreshAuth(self: Host): Promise<StoredAuth | null> {
  const auth = await loadAuth(self);
  if (!auth) return null;
  if (!auth.expiresAt || auth.expiresAt > Date.now() + 60_000) return auth;
  if (!auth.refreshToken) {
    await self.ctx.storage.delete(AUTH_KEY);
    return null;
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
    await self.ctx.storage.put(AUTH_KEY, next);
    return next;
  } catch {
    await self.ctx.storage.delete(AUTH_KEY);
    return null;
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

async function loadAuth(self: Host): Promise<StoredAuth | null> {
  const auth = await self.ctx.storage.get(AUTH_KEY) as StoredAuth | undefined;
  return auth?.mode === 'oauth' ? auth : null;
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

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

function stringProp(description: string) {
  return { type: 'string', description };
}

function numberProp(description: string) {
  return { type: 'number', description };
}

function parseToolArgs(argsText: string): any {
  try {
    const parsed = JSON.parse(argsText);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyContent(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item?.text === 'string') return item.text;
      return typeof item === 'string' ? item : JSON.stringify(item);
    }).join('');
  }
  return JSON.stringify(value);
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

async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { return null; }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function oauthResultHtml(ok: boolean, message: string, sessionId?: string): Response {
  const sessionPath = sessionId && isSessionId(sessionId) ? `/s/${sessionId}/?agent=1` : '/';
  const safeMessage = escapeHtml(message);
  const safePath = escapeHtml(sessionPath);
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
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
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
