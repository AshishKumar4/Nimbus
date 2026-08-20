/**
 * client.ts — the caller's half of callable RPC: a promise per call, and a
 * typed stub proxy that makes an actor's methods look local.
 *
 * Dependency-free and workerd-free on purpose: the socket is anything with
 * `send` and message listeners — a browser WebSocket, a PartySocket, a
 * server-side WebSocket from `fetch()` — so this module runs wherever the
 * connection was made. Frames and defaults follow the Agents SDK client
 * (verified in `agents` 0.20.1 dist, `client.js:129-151,217-248`): ids are
 * `crypto.randomUUID()`, plain calls time out at 30 s by default, streamed
 * calls (an `onChunk` listener) get no timeout unless one is passed.
 */

import { isRpcResponseFrame, RPC_FRAME_TYPE } from './protocol.js';

/** The connection as the client drives it. A browser WebSocket satisfies it. */
export interface ActorSocket {
  send(data: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface ActorCallOptions {
  /**
   * Reject the call after this long. Default: 30,000 ms for plain calls;
   * none for streamed calls.
   */
  timeoutMs?: number;
  /** Receives each `done: false` chunk of a streamed reply. */
  onChunk?: (chunk: unknown) => void;
}

/**
 * The target's async methods, callable as promises. Which of them the actor
 * actually answers is decided server-side by the `callable()` mark; an
 * unmarked method rejects with "is not callable".
 */
export type ActorStub<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer Args
  ) => infer Return
    ? (...args: Args) => Promise<Awaited<Return>>
    : never;
};

export interface ActorClient {
  /** Call one callable method by name. */
  call<T = unknown>(method: string, args?: unknown[], options?: ActorCallOptions): Promise<T>;
  /** A proxy whose method calls become `call(name, args)`. */
  stub<T>(options?: ActorCallOptions): ActorStub<T>;
  /** Detach from the socket and reject every call still pending. */
  close(): void;
}

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onChunk?: (chunk: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Attach an RPC client to a socket. One message listener for all calls. */
export function actorClient(socket: ActorSocket, defaults: ActorCallOptions = {}): ActorClient {
  const pending = new Map<string, PendingCall>();

  const onMessage = (event: { data: unknown }): void => {
    if (typeof event.data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isRpcResponseFrame(frame)) return;
    const call = pending.get(frame.id);
    if (!call) return;
    if (frame.success === false) {
      settle(frame.id)?.reject(new Error(frame.error));
      return;
    }
    if (frame.done === false) {
      call.onChunk?.(frame.result);
      return;
    }
    settle(frame.id)?.resolve(frame.result);
  };

  const settle = (id: string): PendingCall | undefined => {
    const call = pending.get(id);
    if (!call) return undefined;
    pending.delete(id);
    if (call.timer !== undefined) clearTimeout(call.timer);
    return call;
  };

  socket.addEventListener('message', onMessage);

  const call = <T>(method: string, args: unknown[] = [], options: ActorCallOptions = {}): Promise<T> => {
    const onChunk = options.onChunk ?? defaults.onChunk;
    const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? (onChunk ? undefined : DEFAULT_CALL_TIMEOUT_MS);
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCall = { resolve: resolve as (value: unknown) => void, reject, onChunk };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC call '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      pending.set(id, entry);
      try {
        socket.send(JSON.stringify({ type: RPC_FRAME_TYPE, id, method, args }));
      } catch (e) {
        settle(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  };

  return {
    call,
    stub<T>(options?: ActorCallOptions): ActorStub<T> {
      return new Proxy({} as ActorStub<T>, {
        get(_target, name) {
          if (typeof name !== 'string') return undefined;
          return (...args: unknown[]) => call(name, args, options);
        },
      });
    },
    close(): void {
      socket.removeEventListener('message', onMessage);
      for (const id of [...pending.keys()]) {
        settle(id)?.reject(new Error('RPC client closed'));
      }
    },
  };
}
