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
import { isValidSessionId } from '../_shared/session-id.js';
import { base64Url, base64UrlDecode, decodeJsonBase64Url, encodeJsonBase64Url, } from '@nimbus-sh/core/_shared/crypto.js';
import { clearNimbusAgentOAuthCookie, isNimbusTenantSegment, readNimbusAgentCookieSecret, readNimbusAgentOAuthConfig, } from './agent-oauth.js';
import { beginNimbusCloudflareOAuth, exchangeNimbusCloudflareOAuthCode, createNimbusOAuthStateCookie, loadNimbusOAuthStateCookie, fetchNimbusCloudflareAccounts, isNimbusCloudflareAccountId, serializeNimbusCookie, } from '@nimbus-sh/core/_shared/oauth.js';
import { clearSessionAiCredential, createSessionAiModel, describeSessionAiConnection, readSessionAiConfig, resolveSessionAiCredential, sessionAiAccountIsAvailable, setSessionAiAccount, storeSessionAiCredential, } from './ai.js';
import { ensureProgrammaticReady, rpcExec, rpcEnsureRuntimes, rpcInstallRuntime, rpcExposeApp, rpcKillProcess, rpcListApps, rpcListPorts, rpcListProcesses, rpcProcessLogs, rpcStartProcess, } from './programmatic.js';
import { resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { appendTextPart, interruptRunningTools, isInterruptedMessage, legacyToolResult, storedMessageParts, textFromParts, upsertStoredMessage, upsertToolPart, AGENT_OAUTH_RESULT_CHANNEL, } from './agent-contract.js';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';
const MESSAGES_KEY = 'nimbus:agent:messages';
/** How many times the conversation was cleared: a turn writes only into the conversation it started in. */
const GENERATION_KEY = 'nimbus:agent:generation';
/** A message id a client may choose: what `crypto.randomUUID()` answers. */
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * A UTF-16 code unit no pair completes: what makes a string not well-formed
 * (`String.prototype.isWellFormed`, past this lib). A digest encodes text as
 * UTF-8, where each such unit becomes U+FFFD, so two such texts would share it.
 */
const LONE_SURROGATE_RE = /\p{Surrogate}/u;
/**
 * The sends this conversation took under their clients' ids, oldest first:
 * each id with its text's SHA-256. They outlive the stored rows, which keep
 * only the last MAX_STORED_MESSAGES, and are cleared with the conversation.
 */
const RECEIPTS_KEY = 'nimbus:agent:receipts';
/**
 * How many receipts are kept. A browser sends again only its one send whose
 * answer never came back, when its user asks: 512 sends is over six times
 * what the stored rows can hold (80), and the list, an id and a digest
 * each, stays one storage value of about 45 KiB.
 */
const MAX_RECEIPTS = 512;
const STATE_COOKIE = '__Host-nimbus_agent_oauth_state';
const STATE_COOKIE_PURPOSE = 'nimbus-agent-oauth-state';
const MAX_STORED_MESSAGES = 80;
const MAX_TOOL_RESULT_CHARS = 8000;
const STREAMING_TEXT_FLUSH_MS = 500;
const STREAMING_TEXT_FLUSH_BYTES = 1024;
const activeAssistantMessages = new WeakMap();
/**
 * The turns running in this isolate, each by its conversation's generation
 * and user message: the producer that answers it, the one that ends it.
 */
const activeTurns = new WeakMap();
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
        headers.append('Set-Cookie', clearAuthCookie(request));
        headers.append('Set-Cookie', clearStateCookie());
        return json({ ok: true }, 200, headers);
    }
    if (path === '/api/agent/account' && request.method === 'POST') {
        return selectAccount(self, request);
    }
    if (path === '/api/agent/messages' && request.method === 'GET') {
        return json({ messages: await loadMessages(self) });
    }
    if (path === '/api/agent/messages' && request.method === 'DELETE') {
        await clearConversation(self);
        return json({ ok: true, messages: [] });
    }
    if (path === '/api/agent/messages' && request.method === 'POST') {
        return agentChat(self, request, url);
    }
    return json({ error: 'unknown agent endpoint' }, 404);
}
/**
 * The OAuth `state` a callback carries, if this deployment signed it. The
 * router routes a callback by the session and tenant segment in `state`, so an
 * unsigned one would let any client wake or create a Durable Object under any
 * tenant segment; the signature (HMAC-SHA256 under the agent cookie secret)
 * makes the router refuse it before routing. An expired one (its signed `exp`
 * at or before `now`) is refused the same way. Null for anything else.
 */
export async function parseAgentOAuthStateParam(state, env, now = Date.now()) {
    if (!state)
        return null;
    let secret;
    try {
        secret = readNimbusAgentCookieSecret(env);
    }
    catch {
        return null;
    }
    const payload = await decodeState(state, secret);
    if (!payload || payload.v !== 1)
        return null;
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= now)
        return null;
    if (!isValidSessionId(payload.sessionId))
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
    if (!isValidSessionId(sessionId) || !isNimbusTenantSegment(tenantSegment)) {
        return json({ error: 'invalid session route', code: 'E_AGENT_SESSION' }, 400);
    }
    const { transaction, authUrl } = await beginNimbusCloudflareOAuth({
        clientId: config.oauthClientId, redirectUri: config.redirectUri, scopes: config.oauthScopes,
    });
    const payload = { v: 1, nonce: transaction.nonce, sessionId, tenantSegment, exp: transaction.expiresAt };
    let state;
    try {
        state = await signAgentOAuthState(payload, self.env);
    }
    catch (e) {
        return json({
            error: e?.message || String(e),
            code: 'E_AGENT_COOKIE_SECRET',
        }, 409);
    }
    const stored = {
        ...payload, codeVerifier: transaction.codeVerifier, redirectUri: transaction.redirectUri, createdAt: transaction.createdAt,
    };
    authUrl.searchParams.set('state', state);
    const headers = new Headers();
    try {
        headers.append('Set-Cookie', await sealStateCookie(self, stored));
    }
    catch (e) {
        return json({
            error: e?.message || String(e),
            code: 'E_AGENT_COOKIE_SECRET',
        }, 409);
    }
    return json({ ok: true, authUrl: authUrl.toString(), expiresAt: stored.exp }, 200, headers);
}
async function oauthCallback(self, request, url) {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const payload = await parseAgentOAuthStateParam(url.searchParams.get('state'), self.env);
    if (error)
        return oauthResultHtml(false, 'Cloudflare authorization failed.', payload?.sessionId);
    if (!code || !payload)
        return oauthResultHtml(false, 'OAuth callback is missing code or state.', payload?.sessionId);
    const stored = await loadStateCookie(self, request);
    if (!stored || !Number.isSafeInteger(stored.exp) || stored.exp <= Date.now()) {
        return oauthResultHtml(false, 'OAuth session expired. Connect again.', payload.sessionId);
    }
    if (stored.sessionId !== payload.sessionId ||
        stored.tenantSegment !== payload.tenantSegment ||
        stored.nonce !== payload.nonce) {
        return oauthResultHtml(false, 'OAuth state did not match this session.', payload.sessionId);
    }
    try {
        const config = readNimbusAgentOAuthConfig(self.env, new URL(stored.redirectUri).origin);
        const token = await exchangeNimbusCloudflareOAuthCode({ clientId: config.oauthClientId, clientSecret: config.oauthClientSecret }, stored, code);
        const accessToken = token.accessToken;
        const accounts = await fetchNimbusCloudflareAccounts(accessToken).catch(() => []);
        // Straight into the session, not into a cookie: this callback is already
        // being served by the session itself, and the session is what needs the
        // credential in order to answer in-session inference.
        await storeSessionAiCredential(self, {
            accessToken,
            refreshToken: token.refreshToken,
            accountId: accounts[0]?.id ?? null,
            expiresAt: token.expiresAt,
        });
        const headers = new Headers();
        headers.append('Set-Cookie', clearStateCookie());
        return oauthResultHtml(true, 'Cloudflare connected.', payload.sessionId, headers);
    }
    catch (e) {
        const headers = new Headers();
        headers.append('Set-Cookie', clearStateCookie());
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
    if (!retry && LONE_SURROGATE_RE.test(text)) {
        return json({ error: 'message must be well-formed text: no lone surrogate', code: 'E_AGENT_BAD_MESSAGE_TEXT' }, 400);
    }
    // The client's id for the message it sends: a send repeated under it (the
    // first's answer lost on its way back) is that message, never a second one.
    const id = retry || body?.id === undefined ? undefined : String(body.id);
    if (id !== undefined && !MESSAGE_ID_RE.test(id)) {
        return json({ error: 'id must be a lowercase UUID', code: 'E_AGENT_BAD_MESSAGE_ID' }, 400);
    }
    const resolution = await resolveSessionAiCredential(self);
    if (!resolution.ok) {
        return json({
            error: resolution.reason.message,
            code: 'E_AGENT_AI_NOT_CONFIGURED',
        }, 409);
    }
    // Its receipt: the id, and the text's digest that tells a repeat from
    // another message under the same id.
    const send = id === undefined ? undefined : {
        id,
        digest: base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))),
    };
    const turn = await changeConversation(self, async (messages, generation) => {
        recoverOrphanedTurns(self, messages);
        const receipts = new Map(send === undefined ? [] : await self.ctx.storage.get(RECEIPTS_KEY) ?? []);
        const running = activeTurns.get(self) ?? new Map();
        const receipt = send === undefined ? undefined : receipts.get(send.id);
        // An id is one message's: a send's whose receipt holds another text, a
        // stored message's, or an answer's announced before its first checkpoint.
        if (send !== undefined && (receipt === undefined
            ? messages.some((message) => message.id === send.id) || activeAssistantMessages.get(self)?.has(send.id) === true
            : receipt !== send.digest)) {
            return json({ error: 'the message id is taken by another message', code: 'E_AGENT_MESSAGE_ID_TAKEN' }, 409);
        }
        let userMessage;
        let receipted;
        if (retry || receipt !== undefined) {
            // Re-run the last user turn, or the repeated one: drop its own answer
            // (if any) and stream a fresh one. No duplicate user message is stored.
            let asked = messages.length - 1;
            while (asked >= 0 && messages[asked].role !== 'user')
                asked -= 1;
            // The last question, while the conversation ends at its turn: nothing
            // after it but answers.
            const last = asked >= 0 && messages.slice(asked + 1).every((message) => message.role === 'assistant')
                ? messages[asked]
                : undefined;
            const targetId = send?.id ?? last?.id;
            if (targetId === undefined)
                return json({ error: 'nothing to retry', code: 'E_AGENT_NOTHING_TO_RETRY' }, 400);
            // Its answer is still being written: a second would stand beside it.
            if (running.has(turnKey(generation, targetId)))
                return json({ error: 'the turn is still running', code: 'E_AGENT_TURN_RUNNING' }, 409);
            const answer = answerIndex(messages, targetId);
            // A repeated send is answered again only while it is the last turn
            // and its own answer is missing or interrupted; otherwise (trimmed off
            // the conversation, too) it is answered with the conversation, as it is.
            if (last === undefined || last.id !== targetId
                || (receipt !== undefined && answer >= 0 && !isInterruptedMessage(messages[answer]))) {
                return conversationResponse(messages, body?.stream !== false);
            }
            if (answer >= 0)
                messages.splice(answer, 1);
            userMessage = last;
        }
        else {
            // A turn still running under this id, its receipt since dropped,
            // would find its question again and write its answer back.
            if (send !== undefined && running.has(turnKey(generation, send.id))) {
                return json({ error: 'the turn is still running', code: 'E_AGENT_TURN_RUNNING' }, 409);
            }
            userMessage = makeMessage('user', text, send?.id);
            messages.push(userMessage);
            if (send !== undefined) {
                receipts.set(send.id, send.digest);
                receipted = [...receipts].slice(-MAX_RECEIPTS);
            }
        }
        await saveMessages(self, messages, receipted);
        const started = { generation, messages: structuredClone(messages), userMessage };
        activeTurns.set(self, running.set(turnKey(generation, userMessage.id), started));
        return started;
    });
    if (turn instanceof Response)
        return turn;
    if (body?.stream === false) {
        return agentChatJson(self, turn);
    }
    return agentChatStream(self, turn);
}
/** The answer to a send that runs no turn: the conversation, as a turn's stream starts with it. */
function conversationResponse(messages, stream) {
    const conversation = trimMessagesForClient(messages);
    if (!stream)
        return json({ ok: true, messages: conversation });
    const start = { type: 'start', messages: conversation };
    return new Response(JSON.stringify(start) + '\n', {
        status: 200,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    });
}
async function agentChatJson(self, turn) {
    const { messages } = turn;
    try {
        const result = await runAiSdkTurn(self, messages);
        const assistantMessage = makeMessage('assistant', result.text || 'Done.');
        assistantMessage.parts = result.parts;
        assistantMessage.status = 'complete';
        assistantMessage.replyTo = turn.userMessage.id;
        const conversation = await checkpointTurn(self, turn, assistantMessage);
        return json({
            ok: true,
            message: assistantMessage,
            messages: trimMessagesForClient(conversation),
        });
    }
    catch (e) {
        return json({
            error: e?.message || String(e),
            code: 'E_AGENT_TURN_FAILED',
            messages: trimMessagesForClient(messages),
        }, 502);
    }
    finally {
        endTurn(self, turn);
    }
}
function agentChatStream(self, turn) {
    const { messages, userMessage } = turn;
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
                replyTo: userMessage.id,
                ...reason,
            });
            const enqueueStreamingPersistence = () => {
                const message = assistantSnapshot('streaming');
                const write = persistenceQueue.then(async () => { await checkpointTurn(self, turn, message); });
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
                textBytesSinceFlush += utf8Length(delta);
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
                return checkpointTurn(self, turn, assistantMessage);
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
                    else if (chunk.type === 'tool-call' || chunk.type === 'tool-result' || chunk.type === 'tool-error') {
                        // A call is seen as it starts here, so it settles with a duration.
                        emit(recordToolEvent(parts, chunk, chunk.type === 'tool-call' ? Date.now() : undefined));
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
                    replyTo: userMessage.id,
                };
                const conversation = await checkpointTurn(self, turn, assistantMessage);
                emit({
                    type: 'done',
                    message: assistantMessage,
                    messages: trimMessagesForClient(conversation),
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
                endTurn(self, turn);
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
            const result = legacyToolResult(message);
            modelMessages.push({
                role: 'assistant',
                content: `Tool ${result.toolName} result:\n${safeJsonStringify(result.output)}`,
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
        expose_app: aiTool({
            description: 'Expose a running application by port, pid or name: reserves its port under its identity, optionally names it and makes it public, and returns its URL.',
            inputSchema: toolSchema({
                target: stringProp('Port number, process id, or app name.'),
                visibility: stringProp("'scoped' (default) or 'public' — public mints a shareable capability URL."),
                name: stringProp('Optional DNS-label name for the app, e.g. "api".'),
            }, ['target']),
            execute: async (args) => runTool(self, 'expose_app', args),
        }),
        list_apps: aiTool({
            description: 'List every application the session knows: owner, name, port, pid, status, visibility, restart policy and URL.',
            inputSchema: toolSchema({}, []),
            execute: async (args) => runTool(self, 'list_apps', args),
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
            else if (part?.type === 'tool-call' || part?.type === 'tool-result' || part?.type === 'tool-error') {
                recordToolEvent(parts, {
                    type: part.type,
                    toolCallId: String(part.toolCallId || crypto.randomUUID()),
                    toolName: String(part.toolName || 'tool'),
                    input: part.input,
                    output: part.output,
                    error: part.error,
                });
            }
        }
    }
    if (parts.length === 0 && result.text)
        appendTextPart(parts, 'text', String(result.text));
    return parts;
}
/**
 * Record a tool event in `parts`, as a streamed turn and a finished one both
 * record it, and answer the stream event it is. A call recorded with
 * `startedAt` gets a duration when it settles.
 */
function recordToolEvent(parts, event, startedAt) {
    const { toolCallId, toolName, input } = event;
    if (event.type === 'tool-call') {
        upsertToolPart(parts, { toolCallId, toolName, input, status: 'running', ...(startedAt !== undefined && { startedAt }) });
        return { type: 'tool-call', toolCallId, toolName, input };
    }
    if (event.type === 'tool-result') {
        const output = compactStreamValue(event.output);
        const status = isToolOutputFailure(output) ? 'error' : 'done';
        upsertToolPart(parts, { toolCallId, toolName, input, output, status });
        return { type: 'tool-result', toolCallId, toolName, input, output, status };
    }
    const error = stringifyError(event.error);
    upsertToolPart(parts, { toolCallId, toolName, input, output: { error }, error, status: 'error' });
    return { type: 'tool-error', toolCallId, toolName, input, error };
}
function appendAssistantModelMessages(modelMessages, message) {
    const parts = storedMessageParts(message);
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
function toToolModelOutput(value, error) {
    if (error)
        return { type: 'error-text', value: stringifyError(value) };
    if (typeof value === 'string')
        return { type: 'text', value };
    return { type: 'json', value: value === undefined ? null : value };
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
export async function runTool(self, name, args) {
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
            // Each file tool acts as the session's user, as the user's own shell does,
            // and waits for a delegation it meets to be recalled (withRecall).
            return { path: '/' + path, content: await withRecall(() => self.sqliteFs.as(CRED_SESSION_USER).readFileString(path)) };
        }
        if (name === 'write_file') {
            await ensureProgrammaticReady(self);
            const path = normalizeAgentVfsPath(args.path || '/home/user/file.txt');
            const vfs = self.sqliteFs.as(CRED_SESSION_USER);
            await withRecall(() => {
                ensureParentDirs(vfs, path);
                vfs.writeFile(path, String(args.content ?? ''));
            });
            return { ok: true, path: '/' + path, bytes: String(args.content ?? '').length };
        }
        if (name === 'list_files') {
            await ensureProgrammaticReady(self);
            const path = normalizeAgentVfsPath(args.path || '/home/user');
            const base = trimTrailingSlash(path);
            const entries = (await withRecall(() => self.sqliteFs.as(CRED_SESSION_USER).readdir(path))).map((entry) => ({
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
        if (name === 'expose_app') {
            const raw = String(args.target ?? '').trim();
            if (!raw)
                return { error: 'target is required' };
            const visibility = args.visibility === 'public' ? 'public' : args.visibility === 'scoped' ? 'scoped' : undefined;
            const appName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
            return rpcExposeApp(self, /^\d+$/.test(raw) ? Number(raw) : raw, {
                ...(visibility !== undefined ? { visibility } : {}),
                ...(appName !== undefined ? { name: appName } : {}),
            });
        }
        if (name === 'list_apps')
            return rpcListApps(self);
        return { error: `unknown tool: ${name}` };
    }
    catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}
async function loadStateCookie(self, request) {
    const state = await loadNimbusOAuthStateCookie(request, {
        name: STATE_COOKIE, purpose: STATE_COOKIE_PURPOSE, secret: cookieSecret(self),
    });
    if (!state || state.v !== 1 || !isNonce(state.nonce))
        return null;
    if (!isValidSessionId(state.sessionId) || !isNimbusTenantSegment(state.tenantSegment))
        return null;
    if (!state.codeVerifier || !state.redirectUri)
        return null;
    return state;
}
async function sealStateCookie(self, state) {
    return createNimbusOAuthStateCookie(state, {
        name: STATE_COOKIE, purpose: STATE_COOKIE_PURPOSE, secret: cookieSecret(self),
    });
}
function clearStateCookie() {
    return serializeNimbusCookie(STATE_COOKIE, '', { path: '/', maxAge: 0 });
}
function clearAuthCookie(request) {
    return clearNimbusAgentOAuthCookie(request);
}
function cookieSecret(self) {
    return readNimbusAgentCookieSecret(self.env);
}
async function loadMessages(self) {
    return changeConversation(self, async (messages) => {
        if (recoverOrphanedTurns(self, messages)) {
            await saveMessages(self, messages);
            // TODO(agent-turn-forensics): immediately persist an agent-turn-orphaned
            // recovery record (cause reset/interrupted, dataLoss true) once the
            // observability API supports recovery-only writes beyond its failure gate.
        }
        return messages;
    });
}
/**
 * Mark interrupted, in `messages`, each answer still streaming whose turn
 * is not running in this isolate (the object restarted under it), its
 * running tools settled: what a model reads of history has no tool call
 * left unanswered. Whether any was.
 */
function recoverOrphanedTurns(self, messages) {
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
    return recovered;
}
/** Where `activeTurns` holds the turn answering `userMessageId` in the conversation of `generation`. */
function turnKey(generation, userMessageId) {
    return `${generation}:${userMessageId}`;
}
/** `turn` no longer running: its own record released, never another producer's. */
function endTurn(self, turn) {
    const running = activeTurns.get(self);
    const key = turnKey(turn.generation, turn.userMessage.id);
    if (running?.get(key) === turn)
        running.delete(key);
    if (running?.size === 0)
        activeTurns.delete(self);
}
/**
 * Where `messages` holds the answer to the user message `id`: the assistant
 * message that names it or, when none does, the first answer stored before
 * answers named their question that comes after it with no other question
 * between. -1 for none.
 */
function answerIndex(messages, id) {
    const named = messages.findIndex((message) => message.role === 'assistant' && message.replyTo === id);
    if (named >= 0)
        return named;
    const asked = messages.findIndex((message) => message.id === id);
    return asked < 0 ? -1 : messages.findIndex((message, index) => index > asked && message.role === 'assistant'
        && message.replyTo === undefined && messages.slice(asked + 1, index).every((between) => between.role !== 'user'));
}
/**
 * The conversation's changes, one at a time per session: each reads the
 * conversation the last one left (its messages and its generation) and is
 * the only writer until it returns. So a turn's checkpoint changes its own
 * message in the conversation as it is, and never puts back an older one.
 */
const conversationChanges = new WeakMap();
function changeConversation(self, change) {
    const previous = conversationChanges.get(self) ?? Promise.resolve();
    const changed = previous.then(async () => {
        const messages = await self.ctx.storage.get(MESSAGES_KEY);
        const generation = await self.ctx.storage.get(GENERATION_KEY);
        return change(Array.isArray(messages) ? messages : [], typeof generation === 'number' ? generation : 0);
    });
    conversationChanges.set(self, changed.then(() => { }, () => { }));
    return changed;
}
/**
 * A turn's message, as it is now, into the conversation it started in: its
 * row, by its id, changed or added. Nothing, when the conversation was
 * cleared since, or no longer holds the question it answers (trimmed off
 * its start). The conversation, after it.
 */
function checkpointTurn(self, turn, message) {
    return changeConversation(self, async (messages, generation) => {
        if (generation !== turn.generation || !messages.some((stored) => stored.id === turn.userMessage.id))
            return messages;
        upsertStoredMessage(messages, message);
        await saveMessages(self, messages);
        return messages;
    });
}
/** The conversation emptied, and every turn still running told so by its generation. */
function clearConversation(self) {
    return changeConversation(self, async (_messages, generation) => {
        await self.ctx.storage.delete(MESSAGES_KEY);
        await self.ctx.storage.delete(RECEIPTS_KEY);
        await self.ctx.storage.put(GENERATION_KEY, generation + 1);
    });
}
/**
 * The conversation's messages stored and, given them, its receipts, in the
 * same put: a put refused (a value past the limit) stores neither, so no
 * receipt stands for a message the session does not hold.
 */
async function saveMessages(self, messages, receipts) {
    const stored = trimMessagesForClient(messages);
    await (receipts === undefined
        ? self.ctx.storage.put(MESSAGES_KEY, stored)
        : self.ctx.storage.put({ [MESSAGES_KEY]: stored, [RECEIPTS_KEY]: receipts }));
}
function trimMessagesForClient(messages) {
    return messages.slice(-MAX_STORED_MESSAGES);
}
function makeMessage(role, content, id = crypto.randomUUID()) {
    return {
        id,
        role,
        content,
        createdAt: Date.now(),
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
    const sessionPath = sessionId && isValidSessionId(sessionId) ? `/s/${sessionId}/?agent=1` : '/';
    const result = { type: AGENT_OAUTH_RESULT_CHANNEL, ok };
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
var result = ${JSON.stringify(result)};
try {
  if (window.opener) window.opener.postMessage(result, location.origin);
  else { var channel = new BroadcastChannel(result.type); channel.postMessage(result); channel.close(); }
} catch {}
setTimeout(function(){ try { window.close(); } catch {} }, 700);
</script>
</body></html>`, {
        status: ok ? 200 : 400,
        headers: responseHeaders,
    });
}
const STATE_SIGNATURE_PURPOSE = 'nimbus-agent-oauth-state:v1';
function stateSigningKey(secret, usage) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
function stateSigned(body) {
    return new TextEncoder().encode(`${STATE_SIGNATURE_PURPOSE}\0${body}`);
}
/** The `state` an OAuth flow carries: `<payload>.<signature>`, both base64url. */
export async function signAgentOAuthState(payload, env) {
    const secret = readNimbusAgentCookieSecret(env);
    const body = encodeJsonBase64Url(payload);
    const signature = await crypto.subtle.sign('HMAC', await stateSigningKey(secret, 'sign'), stateSigned(body));
    return `${body}.${base64Url(new Uint8Array(signature))}`;
}
async function decodeState(state, secret) {
    const dot = state.indexOf('.');
    if (dot <= 0 || dot !== state.lastIndexOf('.'))
        return null;
    const body = state.slice(0, dot);
    try {
        const signature = base64UrlDecode(state.slice(dot + 1));
        if (!await crypto.subtle.verify('HMAC', await stateSigningKey(secret, 'verify'), signature, stateSigned(body)))
            return null;
        return decodeJsonBase64Url(body);
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
