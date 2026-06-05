/**
 * @nimbus-sh/react/NimbusTerminal — The iframe-wrapping React component.
 *
 * Lifecycle:
 *   1. On mount, compute `attachUrl = ${endpoint}/s/${sessionId}/?nimbus_token=…`.
 *      When `sessionId` is absent, the iframe loads `/new` which 302s to
 *      a fresh `/s/<sid>/` URL.
 *   2. Listen for postMessage events from the iframe with
 *      `{ type: 'nimbus:ready' }`; fire `onReady`.
 *   3. Listen for `{ type: 'nimbus:error', code, message }`; surface
 *      via `onError`.
 *
 * The iframe's xterm shell posts these events back via
 * `window.parent.postMessage`. Embedders never have to know the wire
 * format; that's the shell's job.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  type NimbusTerminalProps,
  type NimbusTerminalRef,
  NimbusTerminalError,
} from './types.js';

const DEFAULT_SANDBOX = 'allow-scripts allow-same-origin allow-downloads allow-forms allow-popups';

/**
 * Embed a Nimbus terminal in your React app.
 *
 * @see {@link NimbusTerminalProps} for prop reference.
 */
export const NimbusTerminal = forwardRef<NimbusTerminalRef, NimbusTerminalProps>(
  function NimbusTerminal(props, ref): ReactElement {
    const {
      endpoint, token, tenant, sub, sessionId,
      onReady, onError,
      style, className, sandbox, title,
    } = props;

    // Pin a render-counter to force iframe reload via key bump.
    const [renderKey, setRenderKey] = useState(0);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    const attachUrl = useMemo(() => {
      const base = endpoint.replace(/\/+$/, '');
      const path = sessionId ? `/s/${encodeURIComponent(sessionId)}/` : '/new';
      const query = `?nimbus_token=${encodeURIComponent(token)}`;
      return `${base}${path}${query}`;
    }, [endpoint, token, sessionId]);

    useImperativeHandle(
      ref,
      () => ({
        reload: () => setRenderKey((k) => k + 1),
        getUrl: () => attachUrl,
        getElement: () => iframeRef.current,
      }),
      [attachUrl],
    );

    // postMessage event listener for ready / error.
    useEffect(() => {
      if (!onReady && !onError) return;
      const expectedOrigin = new URL(endpoint).origin;
      function onMessage(ev: MessageEvent) {
        if (ev.origin !== expectedOrigin) return;
        const data = ev.data;
        if (data === null || typeof data !== 'object') return;
        if (data.type === 'nimbus:ready' && onReady) {
          onReady();
        } else if (data.type === 'nimbus:error' && onError) {
          const code = typeof data.code === 'string' ? data.code : 'E_UNKNOWN';
          const message = typeof data.message === 'string' ? data.message : 'Unknown terminal error';
          onError(new NimbusTerminalError(message, code as NimbusTerminalError['code']));
        }
      }
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, [endpoint, onReady, onError]);

    // Validate tenant claim consistency early (developer-experience win).
    // Token sub claim is opaque from React's perspective — we only check
    // that `tenant` is a non-empty string, since the runtime enforces
    // the token's tn claim against this anyway.
    if (typeof tenant !== 'string' || tenant.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('[@nimbus-sh/react] NimbusTerminal: `tenant` prop is required and must be non-empty');
    }

    return (
      <iframe
        ref={iframeRef}
        key={renderKey}
        src={attachUrl}
        title={title ?? 'Nimbus terminal'}
        sandbox={sandbox ?? DEFAULT_SANDBOX}
        className={className}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          ...style,
        }}
        // Tenant + sub are forwarded as data-attrs for embedder devtools
        // visibility; the runtime trusts only the token's claims.
        data-nimbus-tenant={tenant}
        data-nimbus-sub={sub}
        data-nimbus-session-id={sessionId}
      />
    );
  },
);
