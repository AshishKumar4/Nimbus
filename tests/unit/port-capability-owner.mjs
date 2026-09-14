#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import {
  persistPortCapability,
  readPortCapability,
  readPortReservation,
  restorePortCapability,
  restoreReservedPortCapability,
} from '../../packages/worker/src/session/port-capability.ts';
import { PORT_CAPABILITY_KEY_PREFIX } from '../../packages/worker/src/session/keys.ts';

// A port record's owner lives in the stored row, not in a hook the caller
// supplies. This file pins that contract: persisting a capability preserves
// the stored owner, the generic restore serves only what is registered, and
// the durable re-adopt path gates on the record's own owner — so a foreign
// caller cannot pull a reserved port's token out of the store.
//
// A serialized transaction mirrors DO storage: each body runs alone on a
// private copy of the committed rows and commits it only when it resolves.
const rows = new Map();
let queue = Promise.resolve();
const storage = {
  get: async (key) => rows.get(key),
  put: async (key, value) => { rows.set(key, value); },
  delete: async (key) => rows.delete(key),
  list: async ({ prefix }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  transaction(body) {
    const run = queue.then(() => {
      const copy = new Map(rows);
      const view = {
        get: async (k) => copy.get(k),
        put: async (k, v) => { copy.set(k, v); },
        delete: async (k) => copy.delete(k),
        list: async ({ prefix }) => new Map([...copy].filter(([k]) => k.startsWith(prefix))),
      };
      return Promise.resolve(body(view)).then((value) => {
        rows.clear();
        for (const [k, v] of copy) rows.set(k, v);
        return value;
      });
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  },
};
const ctx = { storage };

/** A host whose registry holds a live listener on `port`, serving `body`. */
function activate(port, pid, body) {
  const portRegistry = new PortRegistry();
  portRegistry.bindFacetStub(pid, { handleHttpRequest: async () => new Response(body) });
  portRegistry.register(port, pid);
  return { ctx, portRegistry };
}

const CAP = 'a'.repeat(24);
const CAP2 = 'b'.repeat(24);

// ── the stored record is the truth persist preserves ────────────────────────
{
  // A durable application reserved its port; the SDK then tells the embedder
  // the registry's capability, which persists it. With no owner hook anywhere
  // the row must still read back owned.
  rows.set(`${PORT_CAPABILITY_KEY_PREFIX}20000`, { owner: 'workspace/app-a/caller-a', capability: null });
  const self = activate(20000, 1, 'A');
  await persistPortCapability(self, 20000, CAP);
  assert.deepEqual(
    await readPortReservation(ctx, 20000),
    { owner: 'workspace/app-a/caller-a', capability: CAP },
    'persist keeps the stored owner instead of writing null',
  );
}

// ── the generic restore serves whatever is registered ───────────────────────
{
  // Same logical server, new registry: the persisted capability is re-adopted.
  const rebuilt = activate(20000, 2, 'A rebuilt');
  assert.equal(await restorePortCapability(rebuilt, 20000), CAP);
  assert.equal(
    await (await rebuilt.portRegistry.routeCapabilityRequest(20000, CAP, new Request('https://preview.example/'), '/')).text(),
    'A rebuilt',
    'the re-adopted capability routes on the new registration',
  );
}

// ── the reserved path gates on the stored owner ─────────────────────────────
{
  // The durable re-drive reads its own reservation: the owner it names is the
  // only owner the restore answers for.
  const host = activate(20000, 3, 'A third incarnation');
  assert.equal(
    await restoreReservedPortCapability(host, 20000, 'workspace/app-a/caller-a'),
    CAP,
    'the record owner re-adopts its own capability',
  );
  assert.equal(
    await restoreReservedPortCapability(host, 20000, 'workspace/app-a/caller-b'),
    null,
    'a foreign owner gets nothing — the row does not answer for it',
  );
  // And the record itself is unchanged either way.
  assert.deepEqual(await readPortReservation(ctx, 20000), { owner: 'workspace/app-a/caller-a', capability: CAP });
}

// ── an ownerless exposure behaves the way it always did ─────────────────────
{
  rows.set(`${PORT_CAPABILITY_KEY_PREFIX}20010`, { owner: null, capability: CAP2 });
  const ordinary = activate(20010, 4, 'ordinary');
  assert.equal(await readPortCapability(ordinary, 20010), CAP2, 'an ownerless record reads back its capability');
  assert.equal(await restoreReservedPortCapability(ordinary, 20010, 'anyone'), null,
    'an ownerless record is not a reservation the reserved path can adopt');
  assert.equal(await restorePortCapability(ordinary, 20010), CAP2, 'the generic path still restores it');
}

console.log('port capability owner: stored-owner truth, persist preservation, reserved-path gating passed');
