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
  isLoopFinished,
  jsonSchema,
  streamText,
  tool as aiTool,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { BASE_PATH_HEADER, TENANT_HEADER } from '../_shared/session-router.js';
import {
  decodeJsonBase64Url,
  encodeJsonBase64Url,
  pkceChallenge,
  randomBase64Url,
  sealJson,
  unsealJson,
} from '../_shared/crypto.js';
import {
  clearNimbusAgentOAuthCookie,
  createNimbusAgentOAuthCookie,
  fetchNimbusCloudflareAccounts,
  fetchNimbusCloudflareUserInfo,
  isNimbusCloudflareAccountId,
  isNimbusTenantSegment,
  loadNimbusAgentOAuthFromRequest,
  NIMBUS_CF_OAUTH_AUTH_URL,
  NIMBUS_CLOUDFLARE_API,
  readNimbusCookie,
  readNimbusAgentCookieSecret,
  requestNimbusCloudflareOAuthToken,
  serializeNimbusCookie,
  type NimbusAgentAuthCookieResult as AuthCookieResult,
  type NimbusAgentOAuthCookie as StoredAuth,
  type NimbusCloudflareAccount as StoredAccount,
} from './agent-oauth.js';
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
  type ProgrammaticHost,
} from './programmatic.js';
import { resolveVfsPath } from '../vfs/path.js';

interface AgentStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  deleteAll(): Promise<void>;
}

interface AgentVfs {
  exists(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean }): void;
  readFileString(path: string): string;
  readdir(path: string): Array<{ name: string; type: string }>;
  writeFile(path: string, content: string): void;
}

interface Host extends ProgrammaticHost {
  ctx: { storage: AgentStorage };
  env: ProgrammaticHost['env'] & Record<string, unknown>;
  sqliteFs: (ProgrammaticHost['sqliteFs'] & AgentVfs) | null;
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

type StoredTurnPart =
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

type StoredToolPart = Extract<StoredTurnPart, { type: 'tool' }>;
type StoredToolPartPatch = Omit<StoredToolPart, 'type'>;

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: number;
  name?: string;
  parts?: StoredTurnPart[];
}

type AgentStreamEvent =
  | { type: 'start'; messages: StoredMessage[] }
  | { type: 'message'; message: StoredMessage }
  | { type: 'assistant-start'; messageId: string; createdAt: number }
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; input: unknown; output: unknown; status: 'done' | 'error' }
  | { type: 'tool-error'; toolCallId: string; toolName: string; input: unknown; error: string }
  | { type: 'finish-step'; finishReason?: string; usage?: unknown }
  | { type: 'done'; message: StoredMessage; messages: StoredMessage[] }
  | { type: 'error'; error: string; code: string; messages: StoredMessage[] };

interface AiCredentials {
  mode: 'oauth' | 'owner-token';
  accessToken: string;
  accountId: string;
}

const MESSAGES_KEY = 'nimbus:agent:messages';
const STATE_COOKIE = '__Host-nimbus_agent_oauth_state';
const STATE_COOKIE_PURPOSE = 'nimbus-agent-oauth-state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_MESSAGES = 80;
const MAX_TOOL_RESULT_CHARS = 8000;
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';
const DEFAULT_GATEWAY_ID = 'default';
const SYSTEM_PROMPT = [
  'You are Nimbus Agent, an autonomous software builder inside a persistent Nimbus cloud dev sandbox.',
  'Your job is to help the user build, change, debug, run, and preview software end-to-end in this workspace.',
  'Treat shell commands, file edits, runtime installs, processes, logs, and preview ports as instruments you operate on the user\'s behalf. Do not present them as chores for the user or as a generic feature menu.',
  'For greetings or vague requests, briefly say you can build or modify apps in this workspace and ask what they want to build. Do not dump a bullet list of raw tools.',
  'For concrete tasks, inspect the project first, edit files, run commands and tests, install missing runtimes when needed, start or manage dev servers, and surface preview ports or URLs when useful.',
  'Be concise and report verified outcomes. Do not claim a command ran, a file changed, or a preview exists unless a tool result proves it.',
].join('\n');

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
  if (!isNimbusTenantSegment(payload.tenantSegment)) return null;
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
      fetchNimbusCloudflareUserInfo(auth.accessToken).catch((e) => ({ error: String(e?.message || e) })),
      fetchNimbusCloudflareAccounts(auth.accessToken).catch(() => [] as StoredAccount[]),
    ]);
  }
  const ownerTokenPresent = !!(config.ownerAccountId && config.ownerToken);
  const ownerConfigured = !config.requireUserOAuth && ownerTokenPresent;
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
      disabledByUserOAuthRequired: config.requireUserOAuth && ownerTokenPresent,
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
  if (!isSessionId(sessionId) || !isNimbusTenantSegment(tenantSegment)) {
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

  const authUrl = new URL(NIMBUS_CF_OAUTH_AUTH_URL);
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
    const accounts = await fetchNimbusCloudflareAccounts(accessToken).catch(() => [] as StoredAccount[]);
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
  if (!isNimbusCloudflareAccountId(accountId)) return json({ error: 'invalid account id' }, 400);
  const authResult = await loadFreshAuth(self, request);
  const auth = authResult.auth;
  if (!auth) return json({ error: 'not connected' }, 409);
  const accounts = await fetchNimbusCloudflareAccounts(auth.accessToken).catch(() => [] as StoredAccount[]);
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

  if (body?.stream === false) {
    return agentChatJson(self, config, credentialResult, messages);
  }

  return agentChatStream(self, config, credentialResult, messages, userMessage);
}

async function agentChatJson(
  self: Host,
  config: ReturnType<typeof readConfig>,
  credentialResult: Awaited<ReturnType<typeof loadAiCredentials>>,
  messages: StoredMessage[],
): Promise<Response> {
  try {
    const result = await runAiSdkTurn(self, config, credentialResult.credentials!, messages);
    const assistantMessage = makeMessage('assistant', result.text || 'Done.');
    assistantMessage.parts = result.parts;
    const nextMessages = [...messages, assistantMessage];
    await saveMessages(self, nextMessages);
    const headers = new Headers();
    applyAuthCookieResult(headers, credentialResult.authResult);
    return json({
      ok: true,
      message: assistantMessage,
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

function agentChatStream(
  self: Host,
  config: ReturnType<typeof readConfig>,
  credentialResult: Awaited<ReturnType<typeof loadAiCredentials>>,
  messages: StoredMessage[],
  userMessage: StoredMessage,
): Response {
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
  applyAuthCookieResult(headers, credentialResult.authResult);

  const credentials = credentialResult.credentials!;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: AgentStreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };

      const parts: StoredTurnPart[] = [];
      const assistantMessageId = crypto.randomUUID();
      const assistantCreatedAt = Date.now();

      emit({ type: 'start', messages: trimMessagesForClient(messages) });
      emit({ type: 'message', message: userMessage });
      emit({ type: 'assistant-start', messageId: assistantMessageId, createdAt: assistantCreatedAt });

      try {
        const result = streamText({
          model: createCloudflareModel(config, credentials),
          system: SYSTEM_PROMPT,
          messages: buildModelMessages(messages),
          tools: createAiSdkTools(self),
          stopWhen: isLoopFinished(),
          maxRetries: 0,
        });

        for await (const chunk of result.fullStream) {
          if (chunk.type === 'text-delta') {
            appendTextPart(parts, 'text', chunk.text);
            emit({ type: 'text-delta', delta: chunk.text });
          } else if (chunk.type === 'reasoning-delta') {
            appendTextPart(parts, 'reasoning', chunk.text);
            emit({ type: 'reasoning-delta', delta: chunk.text });
          } else if (chunk.type === 'tool-call') {
            upsertToolPart(parts, {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              status: 'running',
              startedAt: Date.now(),
            });
            emit({
              type: 'tool-call',
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
            });
          } else if (chunk.type === 'tool-result') {
            const output = compactStreamValue(chunk.output);
            const status = isToolOutputFailure(output) ? 'error' : 'done';
            upsertToolPart(parts, {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              output,
              status,
            });
            emit({
              type: 'tool-result',
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              output,
              status,
            });
          } else if (chunk.type === 'tool-error') {
            const error = stringifyError(chunk.error);
            upsertToolPart(parts, {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              output: { error },
              error,
              status: 'error',
            });
            emit({
              type: 'tool-error',
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: chunk.input,
              error,
            });
          } else if (chunk.type === 'finish-step') {
            emit({
              type: 'finish-step',
              finishReason: chunk.finishReason,
              usage: chunk.usage,
            });
          }
        }

        const assistantMessage = {
          id: assistantMessageId,
          role: 'assistant' as const,
          content: textFromParts(parts) || 'Done.',
          createdAt: assistantCreatedAt,
          parts,
        };
        const nextMessages = [...messages, assistantMessage];
        await saveMessages(self, nextMessages);
        emit({
          type: 'done',
          message: assistantMessage,
          messages: trimMessagesForClient(nextMessages),
        });
      } catch (e: any) {
        emit({
          type: 'error',
          error: e?.message || String(e),
          code: 'E_AGENT_TURN_FAILED',
          messages: trimMessagesForClient(messages),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers });
}

async function runAiSdkTurn(
  self: Host,
  config: ReturnType<typeof readConfig>,
  credentials: AiCredentials,
  messages: StoredMessage[],
): Promise<{ text: string; parts: StoredTurnPart[] }> {
  const model = createCloudflareModel(config, credentials);
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages: buildModelMessages(messages),
    tools: createAiSdkTools(self),
    stopWhen: isLoopFinished(),
    maxRetries: 0,
  });
  const parts = collectTurnParts(result);
  return {
    text: textFromParts(parts) || String(result.text || '').trim(),
    parts,
  };
}

function createCloudflareModel(config: ReturnType<typeof readConfig>, credentials: AiCredentials) {
  const headers: Record<string, string> = {};
  if (config.gatewayId) headers['cf-aig-gateway-id'] = config.gatewayId;
  const provider = createOpenAICompatible({
    name: 'nimbusCloudflare',
    apiKey: credentials.accessToken,
    baseURL: `${NIMBUS_CLOUDFLARE_API}/accounts/${encodeURIComponent(credentials.accountId)}/ai/v1`,
    headers,
  });
  return provider.chatModel(config.model);
}

function buildModelMessages(messages: StoredMessage[]): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      modelMessages.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      appendAssistantModelMessages(modelMessages, message);
      continue;
    }
    if (message.role === 'tool') {
      const payload = parseLegacyToolPayload(message);
      modelMessages.push({
        role: 'assistant',
        content: `Tool ${payload.tool || message.name || 'tool'} result:\n${safeJsonStringify(payload.output ?? message.content)}`,
      });
    }
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

function collectTurnParts(result: { text?: string; steps?: Array<{ content?: any[] }> }): StoredTurnPart[] {
  const parts: StoredTurnPart[] = [];
  for (const step of result.steps || []) {
    for (const part of step.content || []) {
      if (part?.type === 'text') {
        appendTextPart(parts, 'text', String(part.text || ''));
      } else if (part?.type === 'reasoning') {
        appendTextPart(parts, 'reasoning', String(part.text || ''));
      } else if (part?.type === 'tool-call') {
        upsertToolPart(parts, {
          toolCallId: String(part.toolCallId || crypto.randomUUID()),
          toolName: String(part.toolName || 'tool'),
          input: part.input,
          status: 'running',
        });
      } else if (part?.type === 'tool-result') {
        const output = compactStreamValue(part.output);
        upsertToolPart(parts, {
          toolCallId: String(part.toolCallId || crypto.randomUUID()),
          toolName: String(part.toolName || 'tool'),
          input: part.input,
          output,
          status: isToolOutputFailure(output) ? 'error' : 'done',
        });
      } else if (part?.type === 'tool-error') {
        const error = stringifyError(part.error);
        upsertToolPart(parts, {
          toolCallId: String(part.toolCallId || crypto.randomUUID()),
          toolName: String(part.toolName || 'tool'),
          input: part.input,
          output: { error },
          error,
          status: 'error',
        });
      }
    }
  }
  if (parts.length === 0 && result.text) appendTextPart(parts, 'text', String(result.text));
  return parts;
}

function appendTextPart(parts: StoredTurnPart[], type: 'text' | 'reasoning', delta: string): void {
  if (!delta) return;
  const last = parts[parts.length - 1];
  if (last?.type === type) {
    last.text += delta;
    return;
  }
  parts.push({ type, text: delta });
}

function upsertToolPart(parts: StoredTurnPart[], patch: StoredToolPartPatch): StoredToolPart {
  let part = parts.find((item): item is StoredToolPart => (
    item.type === 'tool' && item.toolCallId === patch.toolCallId
  ));
  if (!part) {
    part = {
      type: 'tool',
      toolCallId: patch.toolCallId,
      toolName: patch.toolName,
      status: patch.status || 'running',
    };
    parts.push(part);
  }
  const startedAt = part.startedAt;
  Object.assign(part, patch);
  if (startedAt && patch.status && patch.status !== 'running' && !part.durationMs) {
    part.durationMs = Date.now() - startedAt;
  }
  return part;
}

function textFromParts(parts: StoredTurnPart[]): string {
  return parts
    .filter((part): part is Extract<StoredTurnPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

function appendAssistantModelMessages(modelMessages: ModelMessage[], message: StoredMessage): void {
  const parts = normalizeMessageParts(message);
  if (parts.length === 0) {
    if (message.content) modelMessages.push({ role: 'assistant', content: message.content });
    return;
  }

  let assistantContent: any[] = [];
  let toolContent: any[] = [];
  const flush = () => {
    if (assistantContent.length > 0) {
      modelMessages.push({ role: 'assistant', content: assistantContent });
      assistantContent = [];
    }
    if (toolContent.length > 0) {
      modelMessages.push({ role: 'tool', content: toolContent });
      toolContent = [];
    }
  };

  for (const part of parts) {
    if (part.type === 'text') {
      if (toolContent.length > 0) flush();
      if (part.text) assistantContent.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'reasoning') {
      if (toolContent.length > 0) flush();
      if (part.text) assistantContent.push({ type: 'reasoning', text: part.text });
      continue;
    }
    if (part.type !== 'tool' || !part.toolCallId || !part.toolName) continue;

    assistantContent.push({
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input ?? {},
    });
    if (part.output !== undefined || part.error) {
      toolContent.push({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: toToolModelOutput(part.output ?? { error: part.error }, part.status === 'error' || !!part.error),
      });
    }
  }
  flush();
}

function normalizeMessageParts(message: StoredMessage): StoredTurnPart[] {
  if (Array.isArray(message.parts)) return message.parts.filter((part) => part && typeof part === 'object');
  if (message.role !== 'assistant' || !message.content) return [];
  return [{ type: 'text', text: message.content }];
}

function toToolModelOutput(value: unknown, error: boolean): unknown {
  if (error) return { type: 'error-text', value: stringifyError(value) };
  if (typeof value === 'string') return { type: 'text', value };
  return { type: 'json', value: value === undefined ? null : value };
}

function parseLegacyToolPayload(message: StoredMessage): { tool?: string; input?: unknown; output?: unknown } {
  try {
    const parsed = JSON.parse(message.content || '{}');
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { tool: message.name || 'tool', output: message.content || '' };
}

function isToolOutputFailure(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const record = output as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) return true;
  if (record.success === false) return true;
  if (typeof record.exitCode === 'number' && record.exitCode !== 0) return true;
  if (record.exit && typeof record.exit === 'object') {
    const exit = record.exit as Record<string, unknown>;
    if (typeof exit.code === 'number' && exit.code !== 0) return true;
  }
  return false;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    try { return JSON.stringify(error); } catch {}
  }
  return String(error);
}

function compactStreamValue(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value, MAX_TOOL_RESULT_CHARS);
  const text = safeJsonStringify(value);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return value;
  return truncate(text, MAX_TOOL_RESULT_CHARS);
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
      const path = normalizeAgentVfsPath(args.path || '/home/user');
      return { path: '/' + path, content: self.sqliteFs!.readFileString(path) };
    }
    if (name === 'write_file') {
      await ensureProgrammaticReady(self);
      const path = normalizeAgentVfsPath(args.path || '/home/user/file.txt');
      ensureParentDirs(self.sqliteFs!, path);
      self.sqliteFs!.writeFile(path, String(args.content ?? ''));
      return { ok: true, path: '/' + path, bytes: String(args.content ?? '').length };
    }
    if (name === 'list_files') {
      await ensureProgrammaticReady(self);
      const path = normalizeAgentVfsPath(args.path || '/home/user');
      const base = trimTrailingSlash(path);
      const entries = self.sqliteFs!.readdir(path).map((entry) => ({
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
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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
  if (!config.requireUserOAuth && config.ownerToken && config.ownerAccountId) {
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
  return requestNimbusCloudflareOAuthToken(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

async function refreshToken(self: Host, refreshTokenValue: string): Promise<any> {
  const config = readConfig(self, null);
  return requestNimbusCloudflareOAuthToken(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
  });
}

async function loadAuth(self: Host, request: Request): Promise<StoredAuth | null> {
  return loadNimbusAgentOAuthFromRequest(request, cookieSecret(self));
}

async function loadStateCookie(self: Host, request: Request): Promise<OAuthStateCookie | null> {
  const value = readNimbusCookie(request, STATE_COOKIE);
  if (!value) return null;
  const state = await unsealCookie<OAuthStateCookie>(self, value, STATE_COOKIE_PURPOSE).catch(() => null);
  if (!state || state.v !== 1 || !isNonce(state.nonce)) return null;
  if (!isSessionId(state.sessionId) || !isNimbusTenantSegment(state.tenantSegment)) return null;
  if (!state.codeVerifier || !state.redirectUri) return null;
  return state;
}

async function sealStateCookie(self: Host, state: OAuthStateCookie): Promise<string> {
  return serializeNimbusCookie(STATE_COOKIE, await sealCookie(self, state, STATE_COOKIE_PURPOSE), {
    path: '/',
    maxAge: Math.ceil(OAUTH_STATE_TTL_MS / 1000),
  });
}

async function sealAuthCookie(self: Host, request: Request, auth: StoredAuth): Promise<string> {
  return createNimbusAgentOAuthCookie(auth, cookieSecret(self), request);
}

function clearStateCookie(): string {
  return serializeNimbusCookie(STATE_COOKIE, '', { path: '/', maxAge: 0 });
}

function clearAuthCookie(request: Request): string {
  return clearNimbusAgentOAuthCookie(request);
}

function applyAuthCookieResult(headers: Headers, result: AuthCookieResult | null | undefined): void {
  if (!result) return;
  if (result.clearCookie) appendCookie(headers, result.clearCookie);
  if (result.setCookie) appendCookie(headers, result.setCookie);
}

function appendCookie(headers: Headers, cookie: string): void {
  headers.append('Set-Cookie', cookie);
}

async function sealCookie(self: Host, value: unknown, purpose: string): Promise<string> {
  return sealJson(value, cookieSecret(self), { purpose });
}

async function unsealCookie<T>(self: Host, value: string, purpose: string): Promise<T | null> {
  return unsealJson<T>(value, cookieSecret(self), { purpose });
}

function cookieSecret(self: Host): string {
  return readNimbusAgentCookieSecret(self.env as any);
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
    requireUserOAuth: envBool(env, 'NIMBUS_AGENT_REQUIRE_USER_OAUTH'),
    model: envString(env, 'NIMBUS_AGENT_MODEL') || DEFAULT_MODEL,
    gatewayId: envString(env, 'NIMBUS_AGENT_GATEWAY_ID') || DEFAULT_GATEWAY_ID,
  };
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function envBool(env: Record<string, unknown>, key: string): boolean {
  const value = envString(env, key).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
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

function normalizeAgentVfsPath(input: unknown): string {
  const raw = String(input || '/home/user').trim() || '/home/user';
  return resolveVfsPath(raw, '/home/user') || 'home/user';
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
  return encodeJsonBase64Url(payload);
}

function decodeState(state: string): OAuthStatePayload | null {
  try {
    return decodeJsonBase64Url<OAuthStatePayload>(state);
  } catch {
    return null;
  }
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

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
