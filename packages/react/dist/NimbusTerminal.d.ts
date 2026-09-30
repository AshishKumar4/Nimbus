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
 * The iframe's default `sandbox`, exported so an embedder that needs more can
 * extend it rather than restate it.
 *
 * `allow-popups-to-escape-sandbox`: a preview opened in its own tab (the
 * shell's ↗, and its offer for an app that asks for cross-origin isolation)
 * must not inherit the sandbox, because a sandboxed top-level document cannot
 * take the COOP that isolation needs; it is refused instead
 * (https://html.spec.whatwg.org/multipage/browsers.html#the-cross-origin-opener-policy-header).
 */
export declare const NIMBUS_TERMINAL_SANDBOX = "allow-scripts allow-same-origin allow-downloads allow-forms allow-popups allow-popups-to-escape-sandbox";
/**
 * Embed a Nimbus terminal in your React app.
 *
 * @see {@link NimbusTerminalProps} for prop reference.
 */
export declare const NimbusTerminal: import("react").ForwardRefExoticComponent<NimbusTerminalProps & import("react").RefAttributes<NimbusTerminalRef>>;
//# sourceMappingURL=NimbusTerminal.d.ts.map