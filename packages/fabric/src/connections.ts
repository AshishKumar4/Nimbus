/**
 * connections.ts — typed, validated, hibernation-durable per-connection
 * state over the WebSocket attachment.
 *
 * Specified from Proteus's DeviceSocketHub (`cf-backend/src/user/device-hub.ts`)
 * and CLI rpc gate (`cf-backend/src/cli/rpc-gate.ts`), which split the
 * pattern into its two halves:
 *   - a TAG is the immutable-at-accept lookup key and authorization — it
 *     rides the hibernation state, which is why the rpc gate persists auth
 *     scopes as a tag: "an in-memory allowlist would silently widen to full
 *     access on wake". That is a security property, and it is why this
 *     module keeps NO in-memory mirror: `ctx.getWebSockets` is the only
 *     source of truth for liveness, re-derived on every read.
 *   - the ATTACHMENT is the mutable per-connection payload. It outlives the
 *     code that wrote it — it survives deploys — so what a previous version
 *     wrote is untrusted input, and every read is schema-validated, never
 *     cast (device-hub.ts:49-53).
 *
 * Two platform facts the wrapper enforces where the consumer only documents:
 *   - attachments are STRUCTURED-CLONED, not JSON-encoded: a Set survives as
 *     a Set and silently fails an array schema on read (proven by Proteus's
 *     workerd test, do-socket-attachment.test.ts). Validating on WRITE turns
 *     that silent read-side null into a loud write-side error.
 *   - the bound is {@link WS_ATTACHMENT_LIMIT_BYTES} (16,384) on the
 *     SERIALIZED bytes — workerd re-serializes on every set to check it
 *     (web-socket.h, MAX_ATTACHMENT_SIZE). A JSON-length measurement is an
 *     approximation, so this module never pre-refuses on it; it lets the
 *     platform be the ceiling and NAMES the failure honestly when it trips.
 *
 * Reconnect replaces: accepting a socket under a key closes every open
 * socket already holding that key (1000, 'replaced by a new connection'),
 * exactly as the device hub does.
 */

import { z } from 'zod/v4';
import { WS_ATTACHMENT_LIMIT_BYTES } from '@nimbus-sh/platform/limits.js';

const WS_OPEN = 1;

/** A hibernatable WebSocket, as this module drives it. */
export interface ConnectionSocket {
  readyState: number;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The hosting actor's hibernation surface. */
export interface ConnectionsContext {
  acceptWebSocket(ws: ConnectionSocket, tags?: string[]): void;
  getWebSockets(tag?: string): ConnectionSocket[];
  getTags(ws: ConnectionSocket): string[];
}

/** The per-connection hub of one hosting actor. Cheap accessor; it holds no
 *  state of its own, which is the point. */
export function connections<T>(ctx: ConnectionsContext, schema: z.ZodType<T>): Connections<T> {
  return new Connections(ctx, schema);
}

export class Connections<T> {
  constructor(
    private readonly ctx: ConnectionsContext,
    private readonly schema: z.ZodType<T>,
  ) {}

  /**
   * Accept a socket under an identity key, replacing whatever already holds
   * it. The attachment validates BEFORE anything else happens, so a rejected
   * newcomer cannot evict the live connection it failed to replace.
   */
  accept(ws: ConnectionSocket, opts: { key: string; tags?: string[]; attachment: T }): void {
    const validated = this.schema.parse(opts.attachment);
    for (const old of this.ctx.getWebSockets(opts.key)) {
      if (old.readyState === WS_OPEN) old.close(1000, 'replaced by a new connection');
    }
    this.ctx.acceptWebSocket(ws, [opts.key, ...(opts.tags ?? [])]);
    this.writeSerialized(ws, validated);
  }

  /** The open socket holding a tag, re-derived from the platform. */
  get(tag: string): ConnectionSocket | null {
    for (const ws of this.ctx.getWebSockets(tag)) {
      if (ws.readyState === WS_OPEN) return ws;
    }
    return null;
  }

  /** Every open socket (optionally: holding a tag). */
  list(tag?: string): ConnectionSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WS_OPEN);
  }

  /** A socket's tags — identity key first, then whatever accept added. */
  tags(ws: ConnectionSocket): string[] {
    return this.ctx.getTags(ws);
  }

  /**
   * The attachment, validated. Null when it does not parse — an attachment
   * written by a previous deploy is untrusted input, and a null is honest
   * where a cast would be a lie.
   */
  read(ws: ConnectionSocket): T | null {
    const parsed = this.schema.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  }

  /** Replace the attachment, validated on the way in. */
  write(ws: ConnectionSocket, attachment: T): void {
    this.writeSerialized(ws, this.schema.parse(attachment));
  }

  private writeSerialized(ws: ConnectionSocket, validated: T): void {
    try {
      ws.serializeAttachment(validated);
    } catch (e) {
      const approx = jsonLength(validated);
      throw new Error(
        `fabric: WebSocket attachment refused by the platform — the bound is `
          + `${WS_ATTACHMENT_LIMIT_BYTES.toLocaleString('en-US')} bytes of SERIALIZED attachment `
          + `(workerd MAX_ATTACHMENT_SIZE), and this value is ~${approx.toLocaleString('en-US')} bytes `
          + `as JSON text (an approximation; the serialized form is what counts): ${errorText(e)}`,
        { cause: e },
      );
    }
  }
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
