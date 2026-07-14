import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  interruptRunningTools,
  isInterruptedMessage,
  textFromParts,
  upsertStoredMessage,
  type AgentStatusPayload,
  type AgentTurnUsage,
  type StoredMessage,
} from '../../../src/session/agent-contract.js';
import * as api from '../api.js';
import { usePinToBottom } from '../hooks.js';
import { createLiveTurn, readAgentStream, type LiveTurn } from '../stream.js';
import { Composer } from './Composer.js';
import { ErrorCard } from './ErrorCard.js';
import { Message } from './Message.js';

const CLEAR_CONFIRM_MS = 3000;

interface StatusPill {
  text: string;
  tone: '' | 'ready' | 'warn' | 'streaming';
}

interface TurnError {
  message: string;
  /**
   * Set when the failed send never reached the server (rejected before the
   * stream opened): the retry affordance re-sends this exact text. Null
   * means the server saw the turn, so retry uses { retry: true }.
   */
  resendText: string | null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function livePhase(live: LiveTurn | null): string {
  const parts = live?.message.parts ?? [];
  if (parts.length === 0) return 'Thinking';
  const last = parts[parts.length - 1];
  if (last.type === 'tool' && last.status === 'running') return `Running ${last.toolName}`;
  return last.type === 'text' ? 'Streaming' : 'Thinking';
}

export function AgentChat({ onReady }: { onReady(refresh: () => void): void }) {
  const [status, setStatus] = useState<AgentStatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  const [lastUsage, setLastUsage] = useState<{ id: string; usage: AgentTurnUsage } | null>(null);
  const [waitingOAuth, setWaitingOAuth] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const liveRef = useRef<LiveTurn | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic turn counter: async reconciliation from an older turn (the
  // post-stop re-fetch) must never clobber state a newer turn owns.
  const turnSeqRef = useRef(0);
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

  // Server persistence after Stop or clean EOF can race this GET. Keep the
  // local partial until storage contains a terminal version of the same turn.
  const syncInterruptedTurn = useCallback(async (partial: StoredMessage | null, seq: number) => {
    if (partial) {
      if (liveRef.current?.message.id === partial.id) {
        liveRef.current = null;
        scheduleTick();
      }
      setMessages((current) => {
        const next = [...current];
        upsertStoredMessage(next, partial);
        return next;
      });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let list: StoredMessage[];
      try {
        list = await api.fetchMessages();
      } catch {
        return;
      }
      if (turnSeqRef.current !== seq) return;
      const persistedPartial = partial && list.find((message) => message.id === partial.id);
      if (!partial || (persistedPartial && persistedPartial.status !== 'streaming')) {
        setMessages(list);
        return;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }, [scheduleTick]);

  const runTurn = useCallback(async (
    body: api.ChatRequestBody,
    sendCtx?: { optimisticId: string; text: string },
  ) => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++turnSeqRef.current;
    const live = createLiveTurn();
    liveRef.current = live;
    setTurnError(null);
    setBusy(true);
    scheduleTick();
    // A resolved postChatTurn means the server accepted the turn and
    // persisted the user message; before that, nothing exists server-side.
    let accepted = false;
    try {
      const stream = await api.postChatTurn(body, controller.signal);
      accepted = true;
      const outcome = await readAgentStream(stream, live, {
        onMessages: setMessages,
        onLiveChange: scheduleTick,
        onDone: (message) => setLastUsage({ id: message.id, usage: live.usage }),
        onError: (error) => setTurnError({ message: error, resendText: null }),
      });
      if (outcome === 'eof' && live.message.parts.length > 0) {
        interruptRunningTools(live.message.parts, 'Interrupted before completion');
        await syncInterruptedTurn({
          ...live.message,
          content: textFromParts(live.message.parts),
          status: 'interrupted',
        }, seq);
      }
    } catch (error) {
      if (!accepted && sendCtx) {
        // The server never saw this send: drop the phantom optimistic
        // message and put the text back in the user's hands.
        setMessages((current) => current.filter((message) => message.id !== sendCtx.optimisticId));
        setDraft((current) => current || sendCtx.text);
        if (!isAbortError(error)) {
          setTurnError({ message: errorMessage(error), resendText: sendCtx.text });
        }
      } else if (isAbortError(error)) {
        let partial: StoredMessage | null = null;
        if (live.message.parts.length > 0) {
          interruptRunningTools(live.message.parts, 'Stopped by user');
          partial = {
            ...live.message,
            content: textFromParts(live.message.parts),
            status: 'interrupted',
            aborted: true,
          };
        }
        await syncInterruptedTurn(partial, seq);
      } else {
        const message = errorMessage(error);
        if (live.message.parts.length > 0) {
          interruptRunningTools(live.message.parts, message);
          await syncInterruptedTurn({
            ...live.message,
            content: textFromParts(live.message.parts),
            status: 'interrupted',
            error: message,
          }, seq);
        }
        setTurnError({ message, resendText: null });
      }
    } finally {
      liveRef.current = null;
      abortRef.current = null;
      setBusy(false);
      scheduleTick();
    }
  }, [scheduleTick, syncInterruptedTurn]);

  const send = useCallback((text: string) => {
    if (abortRef.current) return;
    const optimisticId = `optimistic-${crypto.randomUUID()}`;
    setDraft((current) => (current.trim() === text ? '' : current));
    setMessages((current) => [...current, {
      id: optimisticId,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }]);
    void runTurn({ message: text, stream: true }, { optimisticId, text });
  }, [runTurn]);

  const retryTurn = useCallback((resendText: string | null) => {
    if (abortRef.current) return;
    if (resendText !== null) send(resendText);
    else void runTurn({ retry: true, stream: true });
  }, [send, runTurn]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const oauth = status?.oauth;
  const canChat = !!status?.configured && !!status.connected;
  const live = liveRef.current;
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

  const pinRef = usePinToBottom<HTMLDivElement>();
  const isEmpty = messages.length === 0 && !live && !turnError;

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
            {messages.map((message, index) => (
              <Message
                key={message.id}
                message={message}
                usage={lastUsage && lastUsage.id === message.id ? lastUsage.usage : null}
                onRetry={
                  index === messages.length - 1
                  && message.role === 'assistant'
                  && isInterruptedMessage(message)
                  && !busy
                  && !turnError
                    ? () => retryTurn(null)
                    : undefined
                }
              />
            ))}
            {live && <Message message={live.message} live tick={tick} />}
            {turnError && (
              <ErrorCard
                message={turnError.message}
                streaming={busy}
                retryLabel={turnError.resendText !== null ? 'Send again' : 'Retry last message'}
                onRetry={() => retryTurn(turnError.resendText)}
                onDismiss={() => setTurnError(null)}
              />
            )}
          </div>
        )}
      </div>
      <Composer
        value={draft}
        onChange={setDraft}
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
