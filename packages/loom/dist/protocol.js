/**
 * protocol.ts — the JSON frames loom speaks over a WebSocket connection.
 *
 * The frame shapes and type strings match the Cloudflare Agents SDK
 * (`agents` 0.20.1, verified in its shipped dist: `types.js:5-15` for the
 * type strings, `agent-tool-types` d.ts for the request/response shapes).
 * Matching them is deliberate: a client written for an Agents server — the
 * SDK's own `AgentClient` included — can drive a loom actor's state sync and
 * RPC without translation. Only the frames loom implements are declared
 * here; the Agents-product frames (MCP, identity, sessions) are not.
 *
 * A string message that parses as JSON and carries one of these `type`
 * values is a protocol frame and never reaches the embedder's `onMessage`.
 * Everything else — binary, non-JSON text, JSON with any other `type` —
 * passes through untouched.
 */
/** State sync, both directions: `{ type, state }`. */
export const STATE_FRAME_TYPE = 'cf_agent_state';
/** Server → client: a client state update was refused. */
export const STATE_ERROR_FRAME_TYPE = 'cf_agent_state_error';
/** Callable RPC, both directions. */
export const RPC_FRAME_TYPE = 'rpc';
/** Same guard the Agents server uses: `type` plus a `state` key. */
export function isStateFrame(value) {
    return (typeof value === 'object' && value !== null
        && value.type === STATE_FRAME_TYPE
        && 'state' in value);
}
/** Same guard the Agents server uses: all four fields, `args` an array. */
export function isRpcRequestFrame(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const frame = value;
    return (frame.type === RPC_FRAME_TYPE
        && typeof frame.id === 'string'
        && typeof frame.method === 'string'
        && Array.isArray(frame.args));
}
/** The client-side guard for response frames. */
export function isRpcResponseFrame(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const frame = value;
    return frame.type === RPC_FRAME_TYPE && typeof frame.id === 'string' && typeof frame.success === 'boolean';
}
