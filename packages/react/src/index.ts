/**
 * @nimbus-sh/react — React component for embedding a Nimbus terminal.
 *
 * The v0.1 surface is a single `<NimbusTerminal />` that renders an
 * iframe pointing at `${endpoint}/s/${sessionId}/?nimbus_token=…`. The
 * Nimbus runtime serves the xterm UI shell from the iframe's origin;
 * the embedder's React app is purely a frame around it.
 *
 * Why an iframe (not a direct xterm-in-DOM render)? Three reasons:
 * (1) workerd's static-asset pipeline already ships the xterm shell —
 * we don't want to duplicate the bundle in every embedder's React app;
 * (2) cross-origin isolation: the embedder's JS can't accidentally
 * snoop the terminal's WS frames; (3) the shell handles
 * resize/keybindings/CSP-quirks natively and benefits from staying
 * intact across embedders.
 *
 * @example
 * ```tsx
 * import { NimbusTerminal } from '@nimbus-sh/react';
 *
 * <NimbusTerminal
 *   endpoint="https://my-nimbus.workers.dev"
 *   token={jwt}
 *   tenant="acme"
 *   sub="alice"
 *   onReady={() => console.log('session attached')}
 *   style={{ width: '100%', height: '500px' }}
 * />
 * ```
 */

export { NimbusTerminal } from './NimbusTerminal.js';
export { useNimbusSession } from './useNimbusSession.js';
export type {
  NimbusTerminalProps,
  NimbusTerminalRef,
  NimbusSessionState,
} from './types.js';
