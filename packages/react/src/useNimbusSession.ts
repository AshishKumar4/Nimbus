/**
 * @nimbus-sh/react/useNimbusSession — Headless hook for embedders who
 * want to render their own UI around a session.
 *
 * The hook does NOT render anything; it just exposes the same state
 * `<NimbusTerminal />` uses internally. Use this when you want a
 * custom React surface (e.g. shown as a chat panel) wrapping the
 * Nimbus session.
 *
 * @example
 * ```tsx
 * import { useNimbusSession } from '@nimbus-sh/react';
 *
 * function MyTerm({ token }: { token: string }) {
 *   const { ready, attachUrl, error } = useNimbusSession({
 *     endpoint: 'https://my-nimbus.workers.dev',
 *     token,
 *     tenant: 'acme',
 *   });
 *   if (error) return <div>Error: {error.message}</div>;
 *   if (!ready || !attachUrl) return <div>Loading…</div>;
 *   return <iframe src={attachUrl} style={{ width: '100%', height: 400 }} />;
 * }
 * ```
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { sessionAttachUrl } from '@nimbus-sh/sdk/session';
import {
  type NimbusSessionState,
  NimbusTerminalError,
} from './types.js';

export interface UseNimbusSessionOptions {
  endpoint: string;
  token: string;
  tenant: string;
  sub?: string;
  /** Existing session ID. Absent = new session via `/new`. */
  sessionId?: string;
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  reloadKey?: number;
  onReady?: () => void;
  onError?: (error: NimbusTerminalError) => void;
}

/**
 * Headless hook returning the same state `<NimbusTerminal />` exposes.
 */
export function useNimbusSession(opts: UseNimbusSessionOptions): NimbusSessionState {
  const { endpoint, token, sessionId, iframeRef, reloadKey } = opts;
  const callbacks = useRef(opts);
  callbacks.current = opts;

  const attachUrl = useMemo(
    () => (endpoint && token ? sessionAttachUrl(endpoint, sessionId, token) : null),
    [endpoint, token, sessionId],
  );
  const [state, setState] = useState({
    attachUrl, reloadKey, sessionId: sessionId ?? null,
    ready: false, error: null as NimbusTerminalError | null,
  });
  const current = state.attachUrl === attachUrl && state.reloadKey === reloadKey
    ? state
    : { attachUrl, reloadKey, sessionId: sessionId ?? null, ready: false, error: null };
  if (current !== state) setState(current);

  useEffect(() => {
    if (!attachUrl) return;
    const expectedOrigin = new URL(endpoint).origin;
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== expectedOrigin) return;
      if (iframeRef && ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data;
      if (data === null || typeof data !== 'object') return;
      if (data.type === 'nimbus:ready') {
        if (sessionId && typeof data.sessionId === 'string' && data.sessionId !== sessionId) return;
        setState((previous) => ({
          ...previous, ready: true, error: null,
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : previous.sessionId,
        }));
        callbacks.current.onReady?.();
      } else if (data.type === 'nimbus:error') {
        const code = data.code === 'E_SESSION_404' || data.code === 'E_WS_CLOSED' || data.code === 'E_TOKEN_INVALID'
          ? data.code : 'E_UNKNOWN';
        const error = new NimbusTerminalError(
          typeof data.message === 'string' ? data.message : 'Unknown',
          code,
        );
        setState((previous) => ({ ...previous, ready: false, error }));
        callbacks.current.onError?.(error);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [endpoint, attachUrl, iframeRef, reloadKey]);

  return {
    sessionId: current.sessionId,
    ready: current.ready,
    error: current.error,
    attachUrl,
  };
}
