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
import { type NimbusTerminalProps, type NimbusTerminalRef } from './types.js';
/**
 * Embed a Nimbus terminal in your React app.
 *
 * @see {@link NimbusTerminalProps} for prop reference.
 */
export declare const NimbusTerminal: import("react").ForwardRefExoticComponent<NimbusTerminalProps & import("react").RefAttributes<NimbusTerminalRef>>;
//# sourceMappingURL=NimbusTerminal.d.ts.map