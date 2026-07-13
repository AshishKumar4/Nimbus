import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AgentStatusPayload, AgentTurnUsage, StoredMessage } from '../../../src/session/agent-contract.js';
import * as api from '../api.js';
import { usePinToBottom } from '../hooks.js';
import { createLiveTurn, liveTurnMessage, readAgentStream, type LiveTurn } from '../stream.js';
import { Composer } from './Composer.js';
import { ErrorCard } from './ErrorCard.js';
import { Message } from './Message.js';

const CLEAR_CONFIRM_MS = 3000;

interface StatusPill {
  text: string;
  tone: '' | 'ready' | 'warn' | 'streaming';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function livePhase(live: LiveTurn | null): string {
  if (!live || live.parts.length === 0) return 'Thinking';
  const last = live.parts[live.parts.length - 1];
  if (last.type === 'tool' && last.status === 'running') return `Running ${last.toolName}`;
  return last.type === 'text' ? 'Streaming' : 'Thinking';
}

export function AgentChat({ onReady }: { onReady(refresh: () => void): void }) {
  const [status, setStatus] = useState<AgentStatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<{ id: string; usage: AgentTurnUsage } | null>(null);
  const [waitingOAuth, setWaitingOAuth] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const liveRef = useRef<LiveTurn | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const oauthPollRef = useRef<number | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  // Stream ticks are coalesced to one repaint per animation frame so a
  // burst of NDJSON deltas never floods the renderer.
  const [tick, setTick] = useState(0);
  const rafRef = useRef(0);
  const scheduleTick = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setTick((value) => value + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.fetchStatus());
      setStatusError(null);
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, []);

  const refreshMessages = useCallback(async () => {
    setMessages(await api.fetchMessages());
  }, []);

  const refresh = useCallback(() => {
    void refreshStatus();
    if (!abortRef.current) void refreshMessages().catch(() => {});
  }, [refreshStatus, refreshMessages]);

  useEffect(() => {
    refresh();
    onReady(refresh);
  }, [refresh, onReady]);

  const stopOAuthPoll = useCallback(() => {
    if (oauthPollRef.current != null) {
      clearInterval(oauthPollRef.current);
      oauthPollRef.current = null;
    }
    setWaitingOAuth(false);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const data: unknown = event.data;
      if (data && typeof data === 'object' && (data as { type?: unknown }).type === 'nimbus-agent-oauth') {
        stopOAuthPoll();
        void refreshStatus();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [stopOAuthPoll, refreshStatus]);

  const connect = useCallback(async () => {
    try {
      const authUrl = await api.startOAuth();
      const popup = window.open(authUrl, 'nimbus-agent-oauth', 'width=720,height=760');
      if (!popup) {
        location.href = authUrl;
        return;
      }
      setWaitingOAuth(true);
      oauthPollRef.current = window.setInterval(() => {
        if (popup.closed) {
          stopOAuthPoll();
          void refreshStatus();
        }
      }, 1200);
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, [stopOAuthPoll, refreshStatus]);

  const disconnect = useCallback(async () => {
    try {
      await api.logoutOAuth();
      await refreshStatus();
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, [refreshStatus]);

  const changeAccount = useCallback(async (accountId: string) => {
    if (!accountId) return;
    try {
      await api.selectAccount(accountId);
      await refreshStatus();
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, [refreshStatus]);

  const clearChat = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      clearTimerRef.current = window.setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_MS);
      return;
    }
    if (clearTimerRef.current != null) clearTimeout(clearTimerRef.current);
    setConfirmClear(false);
    try {
      await api.clearMessages();
      setMessages([]);
      setTurnError(null);
      setLastUsage(null);
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, [confirmClear]);

  const runTurn = useCallback(async (body: api.ChatRequestBody) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const live = createLiveTurn();
    liveRef.current = live;
    setTurnError(null);
    setBusy(true);
    scheduleTick();
    try {
      const response = await api.postChatTurn(body, controller.signal);
      await readAgentStream(response.body!, live, {
        onMessages: setMessages,
        onLiveChange: scheduleTick,
        onDone: (message) => setLastUsage({ id: message.id, usage: live.usage }),
        onError: setTurnError,
      });
    } catch (error) {
      if (isAbortError(error)) {
        // The backend persists the partial turn on cancel - re-sync to it.
        await refreshMessages().catch(() => {});
      } else {
        setTurnError(errorMessage(error));
      }
    } finally {
      liveRef.current = null;
      abortRef.current = null;
      setBusy(false);
      scheduleTick();
    }
  }, [scheduleTick, refreshMessages]);

  const send = useCallback((text: string) => {
    setMessages((current) => [...current, {
      id: 'pending-user',
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }]);
    void runTurn({ message: text, stream: true });
  }, [runTurn]);

  const retry = useCallback(() => {
    void runTurn({ retry: true, stream: true });
  }, [runTurn]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const oauth = status?.oauth;
  const canChat = !!status?.configured && !!status.connected;
  const live = liveRef.current;
  const liveMessage = live ? liveTurnMessage(live) : null;
  const pill = derivePill(status, statusError, waitingOAuth, busy, live);
  const subtitle = !status
    ? 'Workspace operator'
    : !status.configured
      ? 'Cloudflare Workers AI'
      : status.connected
        ? 'Shell · files · runtimes · previews'
        : 'Use your Cloudflare quota';
  const emptyText = !status
    ? 'Cloudflare connection required.'
    : !status.configured
      ? 'Configure Cloudflare OAuth or an owner API token to enable chat.'
      : status.connected
        ? 'Ask Nimbus to inspect or change this session.'
        : 'Connect Cloudflare to use Workers AI.';

  const pinRef = usePinToBottom<HTMLDivElement>([messages, turnError, tick]);
  const isEmpty = messages.length === 0 && !liveMessage && !turnError;

  return (
    <div class="agent-chat">
      <header class="agent-top">
        <div class="agent-heading">
          <div class="agent-title">Nimbus Agent</div>
          <div class="agent-subtitle">{subtitle}</div>
        </div>
        {oauth?.connected && oauth.accounts.length > 1 && (
          <select
            id="agentAccount"
            title="Cloudflare account"
            value={oauth.accountId ?? ''}
            onChange={(event) => void changeAccount(event.currentTarget.value)}
          >
            {oauth.accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name || account.id}</option>
            ))}
          </select>
        )}
        {oauth?.configured && !oauth.connected && (
          <button id="agentConnect" type="button" class="agent-btn primary" onClick={() => void connect()}>
            Connect Cloudflare
          </button>
        )}
        {oauth?.connected && (
          <button id="agentDisconnect" type="button" class="agent-btn" onClick={() => void disconnect()}>
            Disconnect
          </button>
        )}
        <button
          id="agentClear"
          type="button"
          class={`agent-btn${confirmClear ? ' danger' : ''}`}
          title="Clear chat"
          onClick={() => void clearChat()}
        >
          {confirmClear ? 'Confirm clear' : 'Clear'}
        </button>
        <div id="agentStatus" class={`agent-status${pill.tone ? ` ${pill.tone}` : ''}`}>{pill.text}</div>
      </header>
      <div class="agent-messages" id="agentMessages" ref={pinRef}>
        {isEmpty ? (
          <div class="agent-empty" id="agentEmpty">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
              <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 1 1 16.1-3.8Z" />
            </svg>
            <span>{emptyText}</span>
          </div>
        ) : (
          <div class="agent-thread">
            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                usage={lastUsage && lastUsage.id === message.id ? lastUsage.usage : null}
              />
            ))}
            {liveMessage && <Message message={liveMessage} live />}
            {turnError && (
              <ErrorCard
                message={turnError}
                streaming={busy}
                onRetry={retry}
                onDismiss={() => setTurnError(null)}
              />
            )}
          </div>
        )}
      </div>
      <Composer
        disabled={!canChat}
        hint={!status || status.configured ? 'Connect Cloudflare to start chatting' : 'Configure Cloudflare OAuth or an owner API token'}
        streaming={busy}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}

function derivePill(
  status: AgentStatusPayload | null,
  statusError: string | null,
  waitingOAuth: boolean,
  busy: boolean,
  live: LiveTurn | null,
): StatusPill {
  if (statusError) return { text: statusError, tone: 'warn' };
  if (waitingOAuth) return { text: 'Waiting for Cloudflare...', tone: 'warn' };
  if (!status) return { text: 'Checking...', tone: '' };
  if (!status.configured) return { text: 'AI not configured', tone: 'warn' };
  if (!status.connected) return { text: 'Connect Cloudflare', tone: 'warn' };
  if (busy) return { text: `${livePhase(live)} · ${status.model}`, tone: 'streaming' };
  const mode = status.oauth.connected
    ? 'Cloudflare connected'
    : status.ownerToken.configured
      ? 'Owner token'
      : 'Ready';
  return { text: `${mode} · ${status.model}`, tone: 'ready' };
}
