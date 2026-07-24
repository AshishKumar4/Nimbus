/**
 * session/agent.ts - Nimbus session chat agent and Cloudflare OAuth flow.
 *
 * The agent lives in the session Durable Object because that is where the
 * VFS, shell, process table, port registry, and runtime package manager
 * already live. AI calls go through Cloudflare's account REST API so a
 * connected user can spend their own Workers AI quota instead of the
 * Nimbus deployment owner quota.
 */
import { generateText, isLoopFinished, jsonSchema, streamText, tool as aiTool, } from 'ai';
import { BASE_PATH_HEADER, TENANT_HEADER } from '../_shared/session-router.js';
import { decodeJsonBase64Url, encodeJsonBase64Url, pkceChallenge, randomBase64Url, sealJson, unsealJson, } from '../_shared/crypto.js';
import { clearNimbusAgentOAuthCookie, fetchNimbusCloudflareAccounts, isNimbusCloudflareAccountId, isNimbusTenantSegment, NIMBUS_CF_OAUTH_AUTH_URL, readNimbusCookie, readNimbusAgentCookieSecret, readNimbusAgentOAuthConfig, requestNimbusCloudflareOAuthToken, serializeNimbusCookie, } from './agent-oauth.js';
import { clearSessionAiCredential, createSessionAiModel, describeSessionAiConnection, readSessionAiConfig, resolveSessionAiCredential, sessionAiAccountIsAvailable, setSessionAiAccount, storeSessionAiCredential, } from './ai.js';
import { ensureProgrammaticReady, rpcExec, rpcEnsureRuntimes, rpcInstallRuntime, rpcKillProcess, rpcListPorts, rpcListProcesses, rpcProcessLogs, rpcStartProcess, } from './programmatic.js';
import { resolveVfsPath } from '../vfs/path.js';
import { appendTextPart, interruptRunningTools, textFromParts, upsertStoredMessage, upsertToolPart, } from './agent-contract.js';
import { CRED_KERNEL } from '../runtime/os-contracts.js';
const MESSAGES_KEY = 'nimbus:agent:messages';
const STATE_COOKIE = '__Host-nimbus_agent_oauth_state';
const STATE_COOKIE_PURPOSE = 'nimbus-agent-oauth-state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_MESSAGES = 80;
const MAX_TOOL_RESULT_CHARS = 8000;
const STREAMING_TEXT_FLUSH_MS = 500;
const STREAMING_TEXT_FLUSH_BYTES = 1024;
const activeAssistantMessages = new WeakMap();
const SYSTEM_PROMPT = [
    'You are Nimbus Agent, an autonomous software builder inside a persistent Nimbus cloud dev sandbox.',
    'Your job is to help the user build, change, debug, run, and preview software end-to-end in this workspace.',
    'Treat shell commands, file edits, runtime installs, processes, logs, and preview ports as instruments you operate on the user\'s behalf. Do not present them as chores for the user or as a generic feature menu.',
    'For greetings or vague requests, briefly say you can build or modify apps in this workspace and ask what they want to build. Do not dump a bullet list of raw tools.',
    'For concrete tasks, inspect the project first, edit files, run commands and tests, install missing runtimes when needed, start or manage dev servers, and surface preview ports or URLs when useful.',
    'Be concise and report verified outcomes. Do not claim a command ran, a file changed, or a preview exists unless a tool result proves it.',
].join('\n');
export async function handleAgentRequest(self, request, url) {
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
        await clearSessionAiCredential(self);
        // The browser copy goes too: it is the transport that would otherwise
        // re-seed the session on the very next request.
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
export function parseAgentOAuthStateParam(state) {
    if (!state)
        return null;
    const payload = decodeState(state);
    if (!payload || payload.v !== 1)
        return null;
    if (!isSessionId(payload.sessionId))
        return null;
    if (!isNimbusTenantSegment(payload.tenantSegment))
        return null;
    if (!isNonce(payload.nonce))
        return null;
    return payload;
}
async function agentStatus(self, request, url) {
    const config = readSessionAiConfig(self.env);
    const oauthConfig = readNimbusAgentOAuthConfig(self.env, url.origin);
    const connection = await describeSessionAiConnection(self);
    const ownerTokenPresent = !!(config.ownerAccountId && config.ownerToken);
    const ownerConfigured = !config.requireUserOAuth && ownerTokenPresent;
    const oauthConfigured = !!oauthConfig.oauthClientId;
    const payload = {
        ok: true,
        configured: oauthConfigured || ownerConfigured,
        model: config.model,
        gatewayId: config.gatewayId,
        oauth: {
            configured: oauthConfigured,
            connected: connection.connected,
            clientId: oauthConfigured ? oauthConfig.oauthClientId : null,
            scopes: oauthConfig.oauthScopes,
            user: connection.user,
            accounts: connection.accounts,
            accountId: connection.accountId,
            expiresAt: connection.expiresAt,
        },
        ownerToken: {
            configured: ownerConfigured,
            accountId: ownerConfigured ? config.ownerAccountId : null,
            disabledByUserOAuthRequired: config.requireUserOAuth && ownerTokenPresent,
        },
        connected: connection.connected || ownerConfigured,
        capabilities: [
            'chat',
            'exec',
            'files',
            'runtimes',
            'processes',
            'ports',
        ],
    };
    return json(payload);
}
async function oauthStart(self, request, url) {
    const config = readNimbusAgentOAuthConfig(self.env, url.origin);
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
    const payload = { v: 1, nonce, sessionId, tenantSegment };
    const state = encodeState(payload);
    const now = Date.now();
    const stored = {
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
    }
    catch (e) {
        return json({
            error: e?.message || String(e),
            code: 'E_AGENT_COOKIE_SECRET',
        }, 409);
    }
    return json({ ok: true, authUrl: authUrl.toString(), expiresAt: stored.expiresAt }, 200, headers);
}
async function oauthCallback(self, request, url) {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const payload = parseAgentOAuthStateParam(url.searchParams.get('state'));
    if (error)
        return oauthResultHtml(false, 'Cloudflare authorization failed.', payload?.sessionId);
    if (!code || !payload)
        return oauthResultHtml(false, 'OAuth callback is missing code or state.', payload?.sessionId);
    const stored = await loadStateCookie(self, request);
    if (!stored || stored.expiresAt < Date.now()) {
        return oauthResultHtml(false, 'OAuth session expired. Connect again.', payload.sessionId);
    }
    if (stored.sessionId !== payload.sessionId ||
        stored.tenantSegment !== payload.tenantSegment ||
        stored.nonce !== payload.nonce) {
        return oauthResultHtml(false, 'OAuth state did not match this session.', payload.sessionId);
    }
    try {
        const token = await exchangeCode(self, code, stored.codeVerifier, stored.redirectUri);
        const accessToken = String(token.access_token || '');
        if (!accessToken)
            throw new Error('Cloudflare did not return an access token');
        const accounts = await fetchNimbusCloudflareAccounts(accessToken).catch(() => []);
        // Straight into the session, not into a cookie: this callback is already
        // being served by the session itself, and the session is what needs the
        // credential in order to answer in-session inference.
        await storeSessionAiCredential(self, {
            accessToken,
            refreshToken: token.refresh_token ? String(token.refresh_token) : undefined,
            accountId: accounts[0]?.id ?? null,
            expiresAt: token.expires_in ? Date.now() + Math.max(0, Number(token.expires_in) - 30) * 1000 : null,
        });
        const headers = new Headers();
        appendCookie(headers, clearStateCookie());
        return oauthResultHtml(true, 'Cloudflare connected.', payload.sessionId, headers);
    }
    catch (e) {
        const headers = new Headers();
        appendCookie(headers, clearStateCookie());
        return oauthResultHtml(false, e?.message || String(e), payload.sessionId, headers);
    }
}
async function selectAccount(self, request) {
    const body = await readJson(request);
    const accountId = String(body?.accountId || '');
    if (!isNimbusCloudflareAccountId(accountId))
        return json({ error: 'invalid account id' }, 400);
    if (!await sessionAiAccountIsAvailable(self, accountId)) {
        return json({ error: 'account is not available for this OAuth token' }, 400);
    }
    if (!await setSessionAiAccount(self, accountId))
        return json({ error: 'not connected' }, 409);
    return json({ ok: true, accountId });
}
async function agentChat(self, request, url) {
    const body = await readJson(request);
    const retry = body?.retry === true;
    const text = String(body?.message || '').trim();
    if (!retry && !text)
        return json({ error: 'message is required' }, 400);
    const resolution = await resolveSessionAiCredential(self);
    if (!resolution.ok) {
        return json({
            error: resolution.reason.message,
            code: 'E_AGENT_AI_NOT_CONFIGURED',
        }, 409);
    }
    const messages = await loadMessages(self);
    let userMessage;
    if (retry) {
        // Re-run the last user turn: drop the trailing assistant answer (if
        // any) and stream a fresh one. No duplicate user message is stored.
        if (messages[messages.length - 1]?.role === 'assistant')
            messages.pop();
        const last = messages[messages.length - 1];
        if (!last || last.role !== 'user') {
            return json({ error: 'nothing to retry', code: 'E_AGENT_NOTHING_TO_RETRY' }, 400);
        }
        userMessage = last;
        await saveMessages(self, messages);
    }
    else {
        userMessage = makeMessage('user', text);
        messages.push(userMessage);
        await saveMessages(self, messages);
    }
    if (body?.stream === false) {
        return agentChatJson(self, messages);
    }
    return agentChatStream(self, messages, userMessage);
}
async function agentChatJson(self, messages) {
    try {
        const result = await runAiSdkTurn(self, messages);
        const assistantMessage = makeMessage('assistant', result.text || 'Done.');
        assistantMessage.parts = result.parts;
        assistantMessage.status = 'complete';
        const nextMessages = [...messages, assistantMessage];
        await saveMessages(self, nextMessages);
        return json({
            ok: true,
            message: assistantMessage,
            messages: trimMessagesForClient(nextMessages),
        });
    }
    catch (e) {
        return json({
            error: e?.message || String(e),
            code: 'E_AGENT_TURN_FAILED',
            messages: trimMessagesForClient(messages),
        }, 502);
    }
}
function agentChatStream(self, messages, userMessage) {
    const headers = new Headers();
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Client cancel (Stop button, closed tab) aborts the model turn and
    // persists the partial assistant message so history stays truthful.
    const abort = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            const emit = (event) => {
                if (cancelled)
                    return;
                try {
                    controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
                }
                catch {
                    // The consumer is gone; the abort path below persists the turn.
                    cancelled = true;
                    abort.abort();
                }
            };
            const parts = [];
            const assistantMessageId = crypto.randomUUID();
            const assistantCreatedAt = Date.now();
            const activeMessages = activeAssistantMessages.get(self) ?? new Set();
            activeAssistantMessages.set(self, activeMessages);
            activeMessages.add(assistantMessageId);
            let textBytesSinceFlush = 0;
            let textFlushTimer = null;
            let persistenceQueue = Promise.resolve();
            let persistenceError = null;
            const assistantSnapshot = (status, reason) => ({
                id: assistantMessageId,
                role: 'assistant',
                content: textFromParts(parts),
                createdAt: assistantCreatedAt,
                parts: structuredClone(parts),
                status,
                ...reason,
            });
            const enqueueStreamingPersistence = () => {
                const message = assistantSnapshot('streaming');
                upsertStoredMessage(messages, message);
                const snapshot = structuredClone(messages);
                const write = persistenceQueue.then(() => saveMessages(self, snapshot));
                persistenceQueue = write.catch((error) => {
                    persistenceError ??= error;
                });
                return write;
            };
            const clearTextFlush = () => {
                if (textFlushTimer !== null)
                    clearTimeout(textFlushTimer);
                textFlushTimer = null;
                textBytesSinceFlush = 0;
            };
            const flushStreamingTurn = () => {
                clearTextFlush();
                return parts.length > 0 ? enqueueStreamingPersistence() : persistenceQueue;
            };
            const scheduleTextFlush = (delta) => {
                textBytesSinceFlush += encoder.encode(delta).byteLength;
                if (textBytesSinceFlush >= STREAMING_TEXT_FLUSH_BYTES)
                    return flushStreamingTurn();
                if (textFlushTimer === null) {
                    textFlushTimer = setTimeout(() => {
                        textFlushTimer = null;
                        textBytesSinceFlush = 0;
                        void enqueueStreamingPersistence().catch(() => { });
                    }, STREAMING_TEXT_FLUSH_MS);
                }
                return null;
            };
            // Persist whatever the turn produced before terminating abnormally
            // (client Stop or terminal stream error) so history stays truthful:
            // executed tools and streamed text are recorded and the message
            // carries the terminal marker. Returns the persisted list, or null
            // when nothing had streamed yet.
            const persistPartialTurn = async (terminalError) => {
                if (parts.length === 0)
                    return null;
                const reason = terminalError ?? 'Stopped by user';
                interruptRunningTools(parts, reason);
                clearTextFlush();
                await persistenceQueue;
                const assistantMessage = assistantSnapshot('interrupted', terminalError === undefined ? { aborted: true } : { error: terminalError });
                upsertStoredMessage(messages, assistantMessage);
                await saveMessages(self, messages);
                return messages;
            };
            emit({ type: 'start', messages: trimMessagesForClient(messages) });
            emit({ type: 'message', message: userMessage });
            emit({ type: 'assistant-start', messageId: assistantMessageId, createdAt: assistantCreatedAt });
            try {
                const result = streamText({
                    model: createSessionAiModel(self),
                    system: SYSTEM_PROMPT,
                    messages: buildModelMessages(messages),
                    tools: createAiSdkTools(self),
                    stopWhen: isLoopFinished(),
                    maxRetries: 0,
                    abortSignal: abort.signal,
                });
                for await (const chunk of result.fullStream) {
                    if (chunk.type === 'abort') {
                        cancelled = true;
                        break;
                    }
                    if (chunk.type === 'error') {
                        throw chunk.error instanceof Error ? chunk.error : new Error(stringifyError(chunk.error));
                    }
                    if (chunk.type === 'text-delta') {
                        appendTextPart(parts, 'text', chunk.text);
                        emit({ type: 'text-delta', delta: chunk.text });
                        await scheduleTextFlush(chunk.text);
                    }
                    else if (chunk.type === 'reasoning-delta') {
                        appendTextPart(parts, 'reasoning', chunk.text);
                        emit({ type: 'reasoning-delta', delta: chunk.text });
                        await scheduleTextFlush(chunk.text);
                    }
                    else if (chunk.type === 'tool-call') {
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
                        await flushStreamingTurn();
                    }
                    else if (chunk.type === 'tool-result') {
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
                        await flushStreamingTurn();
                    }
                    else if (chunk.type === 'tool-error') {
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
                        await flushStreamingTurn();
                    }
                    else if (chunk.type === 'finish-step') {
                        emit({
                            type: 'finish-step',
                            finishReason: chunk.finishReason,
                            usage: chunk.usage,
                        });
                    }
                }
                if (cancelled) {
                    await persistPartialTurn();
                    return;
                }
                clearTextFlush();
                await persistenceQueue;
                if (persistenceError)
                    throw persistenceError;
                const assistantMessage = {
                    id: assistantMessageId,
                    role: 'assistant',
                    content: textFromParts(parts) || 'Done.',
                    createdAt: assistantCreatedAt,
                    parts: structuredClone(parts),
                    status: 'complete',
                };
                upsertStoredMessage(messages, assistantMessage);
                await saveMessages(self, messages);
                emit({
                    type: 'done',
                    message: assistantMessage,
                    messages: trimMessagesForClient(messages),
                });
            }
            catch (e) {
                if (cancelled || e?.name === 'AbortError') {
                    cancelled = true;
                    await persistPartialTurn();
                    return;
                }
                const errorText = e?.message || String(e);
                const persisted = await persistPartialTurn(errorText);
                emit({
                    type: 'error',
                    error: errorText,
                    code: 'E_AGENT_TURN_FAILED',
                    messages: trimMessagesForClient(persisted ?? messages),
                });
            }
            finally {
                clearTextFlush();
                activeMessages.delete(assistantMessageId);
                if (activeMessages.size === 0)
                    activeAssistantMessages.delete(self);
                if (!cancelled) {
                    try {
                        controller.close();
                    }
                    catch { }
                }
            }
        },
        cancel() {
            cancelled = true;
            abort.abort();
        },
    });
    return new Response(stream, { status: 200, headers });
}
async function runAiSdkTurn(self, messages) {
    const result = await generateText({
        model: createSessionAiModel(self),
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
function buildModelMessages(messages) {
    const modelMessages = [];
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
function createAiSdkTools(self) {
    return {
        exec: aiTool({
            description: 'Run a shell command in the Nimbus session.',
            inputSchema: toolSchema({
                command: stringProp('Command line to execute.'),
                cwd: stringProp('Working directory. Defaults to /home/user.'),
                timeoutMs: numberProp('Command timeout in milliseconds.'),
            }, ['command']),
            execute: async (args) => runTool(self, 'exec', args),
        }),
        read_file: aiTool({
            description: 'Read a UTF-8 file from the Nimbus VFS.',
            inputSchema: toolSchema({
                path: stringProp('Absolute or /home/user-relative path.'),
            }, ['path']),
            execute: async (args) => runTool(self, 'read_file', args),
        }),
        write_file: aiTool({
            description: 'Write a UTF-8 file into the Nimbus VFS, creating parent directories.',
            inputSchema: toolSchema({
                path: stringProp('Absolute or /home/user-relative path.'),
                content: stringProp('File content.'),
            }, ['path', 'content']),
            execute: async (args) => runTool(self, 'write_file', args),
        }),
        list_files: aiTool({
            description: 'List files in a Nimbus VFS directory.',
            inputSchema: toolSchema({
                path: stringProp('Directory path. Defaults to /home/user.'),
            }, []),
            execute: async (args) => runTool(self, 'list_files', args),
        }),
        install_runtime: aiTool({
            description: 'Install or ensure a Nimbus runtime package.',
            inputSchema: toolSchema({
                spec: stringProp('Runtime spec such as python, clang, or ruby.'),
            }, ['spec']),
            execute: async (args) => runTool(self, 'install_runtime', args),
        }),
        ensure_runtime: aiTool({
            description: 'Ensure a Nimbus runtime package is installed.',
            inputSchema: toolSchema({
                spec: stringProp('Runtime spec such as python, clang, or ruby.'),
            }, ['spec']),
            execute: async (args) => runTool(self, 'ensure_runtime', args),
        }),
        start_process: aiTool({
            description: 'Start a long-running command and return process and port metadata.',
            inputSchema: toolSchema({
                command: stringProp('Command line to start.'),
                cwd: stringProp('Working directory. Defaults to /home/user.'),
            }, ['command']),
            execute: async (args) => runTool(self, 'start_process', args),
        }),
        list_processes: aiTool({
            description: 'List session processes.',
            inputSchema: toolSchema({}, []),
            execute: async (args) => runTool(self, 'list_processes', args),
        }),
        kill_process: aiTool({
            description: 'Kill a session process by pid.',
            inputSchema: toolSchema({
                pid: numberProp('Process id.'),
            }, ['pid']),
            execute: async (args) => runTool(self, 'kill_process', args),
        }),
        process_logs: aiTool({
            description: 'Read recent process logs.',
            inputSchema: toolSchema({
                pid: numberProp('Process id.'),
                lines: numberProp('Number of log lines. Defaults to 200.'),
            }, ['pid']),
            execute: async (args) => runTool(self, 'process_logs', args),
        }),
        list_ports: aiTool({
            description: 'List exposed preview ports.',
            inputSchema: toolSchema({}, []),
            execute: async (args) => runTool(self, 'list_ports', args),
        }),
    };
}
function collectTurnParts(result) {
    const parts = [];
    for (const step of result.steps || []) {
        for (const part of step.content || []) {
            if (part?.type === 'text') {
                appendTextPart(parts, 'text', String(part.text || ''));
            }
            else if (part?.type === 'reasoning') {
                appendTextPart(parts, 'reasoning', String(part.text || ''));
            }
            else if (part?.type === 'tool-call') {
                upsertToolPart(parts, {
                    toolCallId: String(part.toolCallId || crypto.randomUUID()),
                    toolName: String(part.toolName || 'tool'),
                    input: part.input,
                    status: 'running',
                });
            }
            else if (part?.type === 'tool-result') {
                const output = compactStreamValue(part.output);
                upsertToolPart(parts, {
                    toolCallId: String(part.toolCallId || crypto.randomUUID()),
                    toolName: String(part.toolName || 'tool'),
                    input: part.input,
                    output,
                    status: isToolOutputFailure(output) ? 'error' : 'done',
                });
            }
            else if (part?.type === 'tool-error') {
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
    if (parts.length === 0 && result.text)
        appendTextPart(parts, 'text', String(result.text));
    return parts;
}
function appendAssistantModelMessages(modelMessages, message) {
    const parts = normalizeMessageParts(message);
    if (parts.length === 0) {
        if (message.content)
            modelMessages.push({ role: 'assistant', content: message.content });
        return;
    }
    let assistantContent = [];
    let toolContent = [];
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
            if (toolContent.length > 0)
                flush();
            if (part.text)
                assistantContent.push({ type: 'text', text: part.text });
            continue;
        }
        if (part.type === 'reasoning') {
            if (toolContent.length > 0)
                flush();
            if (part.text)
                assistantContent.push({ type: 'reasoning', text: part.text });
            continue;
        }
        if (part.type !== 'tool' || !part.toolCallId || !part.toolName)
            continue;
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
function normalizeMessageParts(message) {
    if (Array.isArray(message.parts))
        return message.parts.filter((part) => part && typeof part === 'object');
    if (message.role !== 'assistant' || !message.content)
        return [];
    return [{ type: 'text', text: message.content }];
}
function toToolModelOutput(value, error) {
    if (error)
        return { type: 'error-text', value: stringifyError(value) };
    if (typeof value === 'string')
        return { type: 'text', value };
    return { type: 'json', value: value === undefined ? null : value };
}
function parseLegacyToolPayload(message) {
    try {
        const parsed = JSON.parse(message.content || '{}');
        if (parsed && typeof parsed === 'object')
            return parsed;
    }
    catch { }
    return { tool: message.name || 'tool', output: message.content || '' };
}
function isToolOutputFailure(output) {
    if (!output || typeof output !== 'object')
        return false;
    const record = output;
    if (typeof record.error === 'string' && record.error.trim())
        return true;
    if (record.success === false)
        return true;
    if (typeof record.exitCode === 'number' && record.exitCode !== 0)
        return true;
    if (record.exit && typeof record.exit === 'object') {
        const exit = record.exit;
        if (typeof exit.code === 'number' && exit.code !== 0)
            return true;
    }
    return false;
}
function stringifyError(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'object' && error !== null) {
        try {
            return JSON.stringify(error);
        }
        catch { }
    }
    return String(error);
}
function compactStreamValue(value) {
    if (typeof value === 'string')
        return truncate(value, MAX_TOOL_RESULT_CHARS);
    const text = safeJsonStringify(value);
    if (text.length <= MAX_TOOL_RESULT_CHARS)
        return value;
    return truncate(text, MAX_TOOL_RESULT_CHARS);
}
function toolSchema(properties, required) {
    return jsonSchema({
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    });
}
async function runTool(self, name, args) {
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
            return { path: '/' + path, content: self.sqliteFs.as(CRED_KERNEL).readFileString(path) };
        }
        if (name === 'write_file') {
            await ensureProgrammaticReady(self);
            const path = normalizeAgentVfsPath(args.path || '/home/user/file.txt');
            const vfs = self.sqliteFs.as(CRED_KERNEL);
            ensureParentDirs(vfs, path);
            vfs.writeFile(path, String(args.content ?? ''));
            return { ok: true, path: '/' + path, bytes: String(args.content ?? '').length };
        }
        if (name === 'list_files') {
            await ensureProgrammaticReady(self);
            const path = normalizeAgentVfsPath(args.path || '/home/user');
            const base = trimTrailingSlash(path);
            const entries = self.sqliteFs.as(CRED_KERNEL).readdir(path).map((entry) => ({
                name: entry.name,
                type: entry.type,
                path: '/' + base + '/' + entry.name,
            }));
            return { path: '/' + path, entries };
        }
        if (name === 'install_runtime') {
            const spec = String(args.spec || '').trim();
            if (!spec)
                return { error: 'spec is required' };
            return rpcInstallRuntime(self, spec);
        }
        if (name === 'ensure_runtime') {
            const spec = String(args.spec || '').trim();
            if (!spec)
                return { error: 'spec is required' };
            return rpcEnsureRuntimes(self, [spec]);
        }
        if (name === 'start_process') {
            return rpcStartProcess(self, String(args.command || ''), {
                cwd: args.cwd ? String(args.cwd) : '/home/user',
            });
        }
        if (name === 'list_processes')
            return rpcListProcesses(self);
        if (name === 'kill_process')
            return rpcKillProcess(self, Number(args.pid));
        if (name === 'process_logs') {
            return rpcProcessLogs(self, Number(args.pid), {
                lines: clampNumber(args.lines, 1, 1000, 200),
            });
        }
        if (name === 'list_ports')
            return rpcListPorts(self);
        return { error: `unknown tool: ${name}` };
    }
    catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}
async function exchangeCode(self, code, codeVerifier, redirectUri) {
    const config = readNimbusAgentOAuthConfig(self.env, new URL(redirectUri).origin);
    return requestNimbusCloudflareOAuthToken(config, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
    });
}
async function loadStateCookie(self, request) {
    const value = readNimbusCookie(request, STATE_COOKIE);
    if (!value)
        return null;
    const state = await unsealCookie(self, value, STATE_COOKIE_PURPOSE).catch(() => null);
    if (!state || state.v !== 1 || !isNonce(state.nonce))
        return null;
    if (!isSessionId(state.sessionId) || !isNimbusTenantSegment(state.tenantSegment))
        return null;
    if (!state.codeVerifier || !state.redirectUri)
        return null;
    return state;
}
async function sealStateCookie(self, state) {
    return serializeNimbusCookie(STATE_COOKIE, await sealCookie(self, state, STATE_COOKIE_PURPOSE), {
        path: '/',
        maxAge: Math.ceil(OAUTH_STATE_TTL_MS / 1000),
    });
}
function clearStateCookie() {
    return serializeNimbusCookie(STATE_COOKIE, '', { path: '/', maxAge: 0 });
}
function clearAuthCookie(request) {
    return clearNimbusAgentOAuthCookie(request);
}
function appendCookie(headers, cookie) {
    headers.append('Set-Cookie', cookie);
}
async function sealCookie(self, value, purpose) {
    return sealJson(value, cookieSecret(self), { purpose });
}
async function unsealCookie(self, value, purpose) {
    return unsealJson(value, cookieSecret(self), { purpose });
}
function cookieSecret(self) {
    return readNimbusAgentCookieSecret(self.env);
}
async function loadMessages(self) {
    const messages = await self.ctx.storage.get(MESSAGES_KEY);
    if (!Array.isArray(messages))
        return [];
    const activeMessages = activeAssistantMessages.get(self);
    let recovered = false;
    for (const message of messages) {
        if (message.role !== 'assistant' || message.status !== 'streaming' || activeMessages?.has(message.id))
            continue;
        message.status = 'interrupted';
        if (message.parts)
            interruptRunningTools(message.parts, 'Interrupted before completion');
        recovered = true;
    }
    if (recovered) {
        await saveMessages(self, messages);
        // TODO(agent-turn-forensics): immediately persist an agent-turn-orphaned
        // recovery record (cause reset/interrupted, dataLoss true) once the
        // observability API supports recovery-only writes beyond its failure gate.
    }
    return messages;
}
async function saveMessages(self, messages) {
    await self.ctx.storage.put(MESSAGES_KEY, trimMessagesForClient(messages));
}
function trimMessagesForClient(messages) {
    return messages.slice(-MAX_STORED_MESSAGES);
}
function makeMessage(role, content, name) {
    return {
        id: crypto.randomUUID(),
        role,
        content,
        createdAt: Date.now(),
        ...(name ? { name } : {}),
    };
}
function stringProp(description) {
    return { type: 'string', description };
}
function numberProp(description) {
    return { type: 'number', description };
}
function normalizeAgentVfsPath(input) {
    const raw = String(input || '/home/user').trim() || '/home/user';
    return resolveVfsPath(raw, '/home/user') || 'home/user';
}
function ensureParentDirs(vfs, path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (dir && !vfs.exists(dir))
            vfs.mkdir(dir, { recursive: true });
    }
}
function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}
function truncate(value, maxChars) {
    const text = String(value);
    return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n[truncated]';
}
function safeJsonStringify(value) {
    try {
        const text = JSON.stringify(value);
        return typeof text === 'string' ? text : String(value);
    }
    catch {
        return String(value);
    }
}
async function readJson(request) {
    try {
        return await request.json();
    }
    catch {
        return null;
    }
}
function json(body, status = 200, headers) {
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Cache-Control', 'no-store');
    return Response.json(body, {
        status,
        headers: responseHeaders,
    });
}
function oauthResultHtml(ok, message, sessionId, headers) {
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
function encodeState(payload) {
    return encodeJsonBase64Url(payload);
}
function decodeState(state) {
    try {
        return decodeJsonBase64Url(state);
    }
    catch {
        return null;
    }
}
function trimTrailingSlash(value) {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/')
        end--;
    return value.slice(0, end);
}
function isSessionId(value) {
    if (value.length < 1 || value.length > 128)
        return false;
    for (let i = 0; i < value.length; i++) {
        const ch = value.charCodeAt(i);
        const ok = (ch >= 48 && ch <= 57) ||
            (ch >= 97 && ch <= 122) ||
            ch === 45;
        if (!ok)
            return false;
    }
    return true;
}
function isNonce(value) {
    if (value.length < 16 || value.length > 128)
        return false;
    for (let i = 0; i < value.length; i++) {
        const ch = value.charCodeAt(i);
        const ok = (ch >= 48 && ch <= 57) ||
            (ch >= 65 && ch <= 90) ||
            (ch >= 97 && ch <= 122) ||
            ch === 45 || ch === 95;
        if (!ok)
            return false;
    }
    return true;
}
function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
