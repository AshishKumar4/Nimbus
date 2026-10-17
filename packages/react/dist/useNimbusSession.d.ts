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
 * import { useRef } from 'react';
 * import { useNimbusSession } from '@nimbus-sh/react';
 *
 * function MyTerm({ token }: { token: string }) {
 *   const iframeRef = useRef<HTMLIFrameElement | null>(null);
 *   const { ready, attachUrl, error } = useNimbusSession({
 *     endpoint: 'https://my-nimbus.workers.dev',
 *     token,
 *     iframeRef,
 *   });
 *   if (error) return <div>Error: {error.message}</div>;
 *   if (!attachUrl) return null;
 *   // The iframe mounts at once: the shell inside it is what reports ready.
 *   return (
 *     <div style={{ position: 'relative', height: 400 }}>
 *       <iframe ref={iframeRef} src={attachUrl} style={{ width: '100%', height: '100%', border: 'none' }} />
 *       {!ready && <div style={{ position: 'absolute', inset: 0 }}>Loading…</div>}
 *     </div>
 *   );
 * }
 * ```
 */
import { type RefObject } from 'react';
import { type NimbusSessionState, NimbusTerminalError } from './types.js';
export interface UseNimbusSessionOptions {
    endpoint: string;
    token: string;
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
export declare function useNimbusSession(opts: UseNimbusSessionOptions): NimbusSessionState;
//# sourceMappingURL=useNimbusSession.d.ts.map