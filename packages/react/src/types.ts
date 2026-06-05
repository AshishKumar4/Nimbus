/**
 * @nimbus-sh/react/types — Public types for the React component.
 */

import type { CSSProperties, RefObject } from 'react';

/**
 * Props for `<NimbusTerminal />`. All required props are typed strictly;
 * optional props default sensibly.
 */
export interface NimbusTerminalProps {
  /**
   * Base URL of your Nimbus deploy (e.g. `https://my-nimbus.workers.dev`).
   * No trailing slash required.
   */
  endpoint: string;

  /**
   * JWT minted via `issueNimbusToken` from `@nimbus-sh/sdk/token`. The
   * token must carry `{ tn, sub? }` matching the `tenant` + `sub` props.
   * The token is passed via `?nimbus_token=` in the iframe URL.
   */
  token: string;

  /** Tenant identifier. Must match the token's `tn` claim. */
  tenant: string;

  /** Subject (user) identifier. Optional; must match token's `sub`. */
  sub?: string;

  /**
   * Existing session ID to attach to. When absent, the iframe loads
   * `/new` and the Nimbus runtime mints a fresh session.
   */
  sessionId?: string;

  /**
   * Fired once the iframe reports it has connected to its session
   * (WebSocket open + initial prompt). Useful for hiding a spinner.
   */
  onReady?: () => void;

  /**
   * Fired if the session becomes unreachable (404, WS close without
   * recovery within 30s). Embedder can offer a reload button.
   */
  onError?: (e: NimbusTerminalError) => void;

  /** Inline CSS. Iframe spans 100%/100% by default. */
  style?: CSSProperties;

  /** Extra className on the wrapping container. */
  className?: string;

  /**
   * `sandbox` attribute on the iframe. Default is the minimum needed
   * for xterm + WebSocket + same-document downloads:
   *   `allow-scripts allow-same-origin allow-downloads allow-forms`.
   * Override only if you understand the security implications.
   */
  sandbox?: string;

  /**
   * iframe title for accessibility. Default `"Nimbus terminal"`.
   */
  title?: string;
}

/** Imperative handle exposed via `ref`. v0.1 surface is minimal. */
export interface NimbusTerminalRef {
  /** Re-fetch the iframe (useful after a session reset). */
  reload: () => void;
  /** Get the current iframe URL. */
  getUrl: () => string;
  /** Returns the underlying `<iframe>` element when mounted. */
  getElement: () => HTMLIFrameElement | null;
}

/** Headless session state returned by `useNimbusSession`. */
export interface NimbusSessionState {
  /** Current session ID, or `null` until allocated. */
  sessionId: string | null;
  /** True once the runtime has accepted the WS upgrade. */
  ready: boolean;
  /** Last error, if any. */
  error: NimbusTerminalError | null;
  /** Computed attach URL. Null until token + sessionId are set. */
  attachUrl: string | null;
}

/** Error class for terminal-side failures. */
export class NimbusTerminalError extends Error {
  readonly code: 'E_SESSION_404' | 'E_WS_CLOSED' | 'E_TOKEN_INVALID' | 'E_UNKNOWN';
  constructor(message: string, code: NimbusTerminalError['code']) {
    super(message);
    this.name = 'NimbusTerminalError';
    this.code = code;
  }
}

/** Re-export `RefObject` to avoid an extra import in embedder code. */
export type { RefObject };
