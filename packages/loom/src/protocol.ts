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

/** Client → server: replace the actor's state. */
export interface StateFrame<S = unknown> {
  type: typeof STATE_FRAME_TYPE;
  state: S;
}

/** Server → client: the refusal a rejected state update earns. */
export interface StateErrorFrame {
  type: typeof STATE_ERROR_FRAME_TYPE;
  error: string;
}

/** Client → server: call one `callable()` method by name. */
export interface RpcRequestFrame {
  type: typeof RPC_FRAME_TYPE;
  /** Correlates the response frames to the call. The client mints it. */
  id: string;
  method: string;
  args: unknown[];
}

/**
 * Server → client. A streamed reply is many `done: false` frames and one
 * `done: true`; a plain reply is a single `done: true` frame. `done` absent
 * means final (the Agents client treats it so; loom always sets it).
 */
export type RpcResponseFrame = { type: typeof RPC_FRAME_TYPE; id: string } & (
  | { success: true; result: unknown; done?: boolean }
  | { success: false; error: string }
);

/** Same guard the Agents server uses: `type` plus a `state` key. */
export function isStateFrame(value: unknown): value is StateFrame {
  return (
    typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === STATE_FRAME_TYPE
    && 'state' in value
  );
}

/** Same guard the Agents server uses: all four fields, `args` an array. */
export function isRpcRequestFrame(value: unknown): value is RpcRequestFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Partial<RpcRequestFrame>;
  return (
    frame.type === RPC_FRAME_TYPE
    && typeof frame.id === 'string'
    && typeof frame.method === 'string'
    && Array.isArray(frame.args)
  );
}

/** The client-side guard for response frames. */
export function isRpcResponseFrame(value: unknown): value is RpcResponseFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as { type?: unknown; id?: unknown; success?: unknown };
  return frame.type === RPC_FRAME_TYPE && typeof frame.id === 'string' && typeof frame.success === 'boolean';
}
