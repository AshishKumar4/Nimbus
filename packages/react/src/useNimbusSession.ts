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

import { useEffect, useMemo, useState } from 'react';
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
}

/**
 * Headless hook returning the same state `<NimbusTerminal />` exposes.
 */
export function useNimbusSession(opts: UseNimbusSessionOptions): NimbusSessionState {
  const { endpoint, token, sessionId } = opts;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<NimbusTerminalError | null>(null);

  const attachUrl = useMemo(() => {
    if (!endpoint || !token) return null;
    const base = endpoint.replace(/\/+$/, '');
    const path = sessionId ? `/s/${encodeURIComponent(sessionId)}/` : '/new';
    return `${base}${path}?nimbus_token=${encodeURIComponent(token)}`;
  }, [endpoint, token, sessionId]);

  useEffect(() => {
    if (!endpoint) return;
    const expectedOrigin = new URL(endpoint).origin;
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== expectedOrigin) return;
      const data = ev.data;
      if (data === null || typeof data !== 'object') return;
      if (data.type === 'nimbus:ready') setReady(true);
      else if (data.type === 'nimbus:error') {
        setError(new NimbusTerminalError(
          typeof data.message === 'string' ? data.message : 'Unknown',
          (typeof data.code === 'string' ? data.code : 'E_UNKNOWN') as NimbusTerminalError['code'],
        ));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [endpoint]);

  return {
    sessionId: sessionId ?? null,
    ready,
    error,
    attachUrl,
  };
}
