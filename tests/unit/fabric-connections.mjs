#!/usr/bin/env bun
// Typed, validated, hibernation-durable per-connection state, specified from
// Proteus's DeviceSocketHub (cf-backend/src/user/device-hub.ts) and the CLI
// rpc gate (cf-backend/src/cli/rpc-gate.ts):
//
//   - ctx.getWebSockets() is the ONLY source of truth for liveness — an
//     in-memory allowlist would silently widen to full access on wake, which
//     the rpc gate treats as a security property.
//   - the attachment is the only per-connection store with the right
//     lifetime, and it outlives the code that wrote it, so every read is
//     schema-validated, never cast.
//   - attachments are STRUCTURED-CLONED, not JSON-encoded: a Set survives as
//     a Set and silently fails an array schema (proven by Proteus's workerd
//     test). Validating on write catches that before it is stored.
//   - reconnect replaces: existing sockets under the same identity key are
//     closed (1000, 'replaced by a new connection').
//   - the 16,384-byte bound is on the SERIALIZED bytes (workerd
//     web-socket.h MAX_ATTACHMENT_SIZE = 1024 * 16); overflow is reported
//     honestly, naming the real bound and the approximation.

import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import { connections } from '../../packages/fabric/src/connections.ts';
import { WS_ATTACHMENT_LIMIT_BYTES } from '../../packages/platform/src/limits.ts';

const WS_OPEN = 1;
const WS_CLOSED = 3;

/** The platform seam: hibernatable sockets with workerd's attachment rule. */
function createCtx() {
  const sockets = [];
  const makeSocket = () => {
    const ws = {
      readyState: WS_OPEN,
      closed: null,
      attachment: undefined,
      tags: [],
      close(code, reason) { this.readyState = WS_CLOSED; this.closed = { code, reason }; },
      serializeAttachment(value) {
        // workerd serializes on every set to check the bound; the v8 wire
        // format is not JSON, but for the plain shapes below JSON length is
        // a faithful stand-in for "serialized size crossed 16384".
        const size = JSON.stringify(value)?.length ?? 0;
        if (size > WS_ATTACHMENT_LIMIT_BYTES) {
          throw new Error(`A WebSocket 'attachment' cannot be larger than ${WS_ATTACHMENT_LIMIT_BYTES} bytes.`);
        }
        // Structured clone: a Set stays a Set. structuredClone models that.
        this.attachment = structuredClone(value);
      },
      deserializeAttachment() { return this.attachment; },
    };
    return ws;
  };
  return {
    makeSocket,
    ctx: {
      acceptWebSocket(ws, tags = []) { ws.tags = tags; sockets.push(ws); },
      getWebSockets(tag) {
        return sockets.filter((ws) => (tag === undefined ? true : ws.tags.includes(tag)));
      },
      getTags(ws) { return ws.tags; },
    },
  };
}

const DeviceSchema = z.object({
  device: z.string(),
  present: z.array(z.string()).optional(),
});

// ── 1. Accept, read back typed, tags carried ────────────────────────────────

{
  const { ctx, makeSocket } = createCtx();
  const hub = connections(ctx, DeviceSchema);
  const ws = makeSocket();
  hub.accept(ws, { key: 'device:d1', tags: ['cli-scopes:read'], attachment: { device: 'd1' } });

  const live = hub.get('device:d1');
  assert.equal(live, ws);
  assert.deepEqual(hub.read(ws), { device: 'd1' });
  assert.deepEqual(hub.tags(ws), ['device:d1', 'cli-scopes:read'],
    'the identity key and the auth tags both ride the hibernation state');
}

// ── 2. Reconnect replaces: the old socket is closed, the new one serves ─────

{
  const { ctx, makeSocket } = createCtx();
  const hub = connections(ctx, DeviceSchema);
  const first = makeSocket();
  hub.accept(first, { key: 'device:d1', attachment: { device: 'd1' } });
  const second = makeSocket();
  hub.accept(second, { key: 'device:d1', attachment: { device: 'd1' } });

  assert.deepEqual(first.closed, { code: 1000, reason: 'replaced by a new connection' });
  assert.equal(hub.get('device:d1'), second);
}

// ── 3. Wake: a fresh instance rebuilds everything from ctx.getWebSockets ────

{
  const { ctx, makeSocket } = createCtx();
  connections(ctx, DeviceSchema).accept(makeSocket(), { key: 'device:d1', attachment: { device: 'd1' } });

  // The isolate hibernated; a new instance holds no memory of the accept.
  const woken = connections(ctx, DeviceSchema);
  const live = woken.get('device:d1');
  assert.ok(live, 'liveness re-derives from the platform, never from instance memory');
  assert.deepEqual(woken.read(live), { device: 'd1' });
}

// ── 4. Reads are validated, never cast — attachments outlive code ───────────

{
  const { ctx, makeSocket } = createCtx();
  const hub = connections(ctx, DeviceSchema);
  const ws = makeSocket();
  hub.accept(ws, { key: 'device:d1', attachment: { device: 'd1' } });

  // A previous deploy wrote a shape this schema no longer accepts.
  ws.attachment = { legacy: true };
  assert.equal(hub.read(ws), null, 'an unreadable attachment reads as null, not as a lie');

  // The structured-clone trap: a Set survives as a Set and is NOT an array.
  ws.attachment = { device: 'd1', present: new Set(['clang']) };
  assert.equal(hub.read(ws), null, 'a Set where an array belongs fails validation, silently to no one');
}

// ── 5. Writes are validated too, so the trap is caught before storage ───────

{
  const { ctx, makeSocket } = createCtx();
  const hub = connections(ctx, DeviceSchema);
  const ws = makeSocket();
  hub.accept(ws, { key: 'device:d1', attachment: { device: 'd1' } });
  assert.throws(
    () => hub.write(ws, { device: 'd1', present: new Set(['clang']) }),
    /present/,
    'writing a Set where the wire shape says array fails at the write',
  );
  hub.write(ws, { device: 'd1', present: ['clang'] });
  assert.deepEqual(hub.read(ws), { device: 'd1', present: ['clang'] });
}

// ── 6. Overflow at 16,384 serialized bytes is named honestly ────────────────

{
  const { ctx, makeSocket } = createCtx();
  const hub = connections(ctx, z.object({ device: z.string(), blob: z.string().optional() }));
  const ws = makeSocket();
  hub.accept(ws, { key: 'device:d1', attachment: { device: 'd1' } });
  assert.throws(
    () => hub.write(ws, { device: 'd1', blob: 'x'.repeat(WS_ATTACHMENT_LIMIT_BYTES) }),
    (e) => /16,384/.test(e.message) && /serialized/i.test(e.message) && e.cause instanceof Error,
    'the refusal names the real bound and keeps the platform error as cause',
  );
  assert.deepEqual(hub.read(ws), { device: 'd1' }, 'the refused write did not clobber the attachment');
}

// ── 7. An invalid attachment refuses the accept without killing the old ─────

{
  const { ctx, makeSocket } = createCtx();
  const hub = connections(ctx, DeviceSchema);
  const first = makeSocket();
  hub.accept(first, { key: 'device:d1', attachment: { device: 'd1' } });
  assert.throws(() => hub.accept(makeSocket(), { key: 'device:d1', attachment: { legacy: 1 } }));
  assert.equal(first.readyState, WS_OPEN, 'a rejected newcomer must not evict the live connection');
  assert.equal(hub.get('device:d1'), first);
}

// ── 8. Closed sockets are filtered everywhere ────────────────────────────────

{
  const { ctx, makeSocket } = createCtx();
  const hub = connections(ctx, DeviceSchema);
  const ws = makeSocket();
  hub.accept(ws, { key: 'device:d1', attachment: { device: 'd1' } });
  ws.close(1006, 'gone');
  assert.equal(hub.get('device:d1'), null);
  assert.deepEqual(hub.list(), []);
}

console.log('ok - fabric-connections (typed reads, replace-on-reconnect, wake rebuild, clone trap, 16KiB honesty)');
