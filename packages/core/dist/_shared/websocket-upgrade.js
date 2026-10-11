/**
 * _shared/websocket-upgrade.ts — whether a request asks for a WebSocket upgrade, the one rule every layer that
 * must tell one from ordinary HTTP decides by: the port route (which takes the fetch-semantic entrypoint for it),
 * the untrusted-request sanitizer, and the node fetch shim, which carries this source because it cannot import. A
 * request is an upgrade to all of them or to none of them.
 *
 * It reads a `Headers`, never a raw header map: `Headers` has already stripped the value's surrounding
 * whitespace, so ` websocket ` is the upgrade it is to whatever receives the request.
 */
export function isWebSocketUpgradeRequest(headers) {
    return headers.get('upgrade')?.toLowerCase() === 'websocket';
}
