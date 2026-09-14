/**
 * session/port-capability.ts — the durable half of a port's preview capability.
 *
 * `PortRegistry` mints a fresh capability per `register()`, in memory. That is
 * the right lifetime for the in-memory registry and the wrong one for an
 * embedder, which is handed a preview URL and expects it to keep working after
 * the session hibernates and its supervisor is rebuilt from nothing.
 *
 * So the value is persisted at the moment the embedder is told it, and
 * re-adopted into the rebuilt registry when the same logical server comes
 * back. Everything else is the security half of the same rule: a capability
 * names ONE registration, so any other registration on that port retires the
 * durable copy. Only a deliberate restore extends a capability's life, which
 * is why `clearPortCapability` sits next to every `portRegistry.register`,
 * `restorePortCapability` sits only at the two places a dev server is
 * deliberately brought back, and `restoreReservedPortCapability` sits only
 * on the durable spawn's re-adopt path, gated on the stored reservation's
 * owner.
 *
 * The same per-port record also carries a RESERVATION: an owner may hold a
 * port with no capability yet, so a durable application keeps its port across
 * instances whether or not it is currently exposed. Clearing a capability
 * keeps the owner's reservation; only `releasePortReservation` ends it.
 */

import { z } from 'zod/v4';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { PORT_CAPABILITY_KEY_PREFIX } from './keys.js';

/** The minimum a caller needs to own a port capability. */
export interface PortCapabilityHost {
  ctx: {
    storage: PortReservationStorage;
  };
  portRegistry: PortRegistry;
}

/** The transactional view a claim or release runs against: every read and write inside one serializable unit. */
export interface PortReservationTransaction {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** The storage slice a reservation needs: a prefix scan, and a required atomic transaction. */
export interface PortReservationStorage extends PortReservationTransaction {
  transaction<T>(body: (txn: PortReservationTransaction) => Promise<T>): Promise<T>;
}

export interface PortReservationHost {
  ctx: { storage: PortReservationStorage };
}

/** The shape `createPortCapability` mints: 12 random bytes, hex. */
const PortCapabilitySchema = z.string().regex(/^[a-f0-9]{24}$/);
/** 'scoped' is the default: capability-checked but never the public bearer. */
const PortVisibilitySchema = z.enum(['scoped', 'public']);
export type PortVisibility = z.infer<typeof PortVisibilitySchema>;
const PortRecordSchema = z.object({
  capability: PortCapabilitySchema.nullable(),
  owner: z.string().nullable(),
  visibility: PortVisibilitySchema.optional(),
});
export interface PortExposure {
  readonly capability: string;
  readonly owner: string | null;
  readonly visibility: PortVisibility;
}
/** The per-port record as stored: a bare reservation has no capability yet. */
export interface PortReservation {
  readonly owner: string | null;
  readonly capability: string | null;
  readonly visibility: PortVisibility;
}
const RESERVATION_FIRST_PORT = 20000;
const RESERVATION_LAST_PORT = 65535;
export function portRecordKey(port: number): string {
  return `${PORT_CAPABILITY_KEY_PREFIX}${Number(port)}`;
}

function conflict(detail: string): Error {
  return new Error(`port reservation conflict: ${detail}`);
}

/** Read the raw per-port record: a reservation, an exposure, or nothing. */
export async function readPortReservation(ctx: { storage: PortReservationTransaction }, port: number): Promise<PortReservation | null> {
  const stored = PortRecordSchema.safeParse(await ctx.storage.get(portRecordKey(port)));
  if (!stored.success) return null;
  return { ...stored.data, visibility: stored.data.visibility ?? 'scoped' };
}

/** Read retained exposure metadata without starting a session or restoring a listener. */
export async function readPortExposure(ctx: PortCapabilityHost['ctx'], port: number): Promise<PortExposure | null> {
  const stored = await readPortReservation(ctx, port);
  return stored !== null && stored.capability !== null
    ? { capability: stored.capability, owner: stored.owner, visibility: stored.visibility }
    : null;
}
/**
 * Hold a port for `owner` across instances. The owner's existing port is
 * answered again; otherwise the preferred port is claimed, or the lowest
 * free one. A preferred port that another record or a live listener holds
 * is refused, never silently moved.
 *
 * `capability`/`visibility` give the embedder-durable path its URL material
 * up front: a reservation can carry the capability the application will
 * re-adopt when it binds, and the visibility the public bearer form is
 * gated on. An existing reservation for the same owner is answered again,
 * upgraded in place when the caller supplies values it lacks — an existing
 * capability is never rotated, a URL already handed out stays good.
 */
export async function reservePort(
  ctx: PortReservationHost['ctx'],
  input: {
    owner: string;
    preferredPort?: number;
    occupiedPorts: ReadonlySet<number>;
    capability?: string;
    visibility?: PortVisibility;
  },
): Promise<number> {
  const claim = async (txn: PortReservationTransaction): Promise<number> => {
    const records = await txn.list({ prefix: PORT_CAPABILITY_KEY_PREFIX });
    const taken = new Set<number>(input.occupiedPorts);
    let held: { port: number; stored: z.infer<typeof PortRecordSchema> | null } | null = null;
    for (const [storedKey, value] of records) {
      const port = Number(storedKey.slice(PORT_CAPABILITY_KEY_PREFIX.length));
      if (!Number.isInteger(port)) continue;
      taken.add(port);
      const parsed = PortRecordSchema.safeParse(value);
      if (parsed.success && parsed.data.owner === input.owner) {
        held = { port, stored: parsed.data };
      }
    }
    const preferred = input.preferredPort;
    if (held !== null) {
      if (preferred !== undefined && preferred !== held.port) {
        throw conflict(`owner already holds port ${held.port}, cannot reserve ${preferred}`);
      }
      // Upgrade in place: adopt a caller-supplied capability the row lacks
      // and/or apply the caller's visibility — never rotate an existing one.
      const stored = held.stored;
      const capability = stored?.capability ?? input.capability ?? null;
      const visibility = input.visibility ?? stored?.visibility ?? 'scoped';
      if (stored === null || capability !== stored.capability || visibility !== (stored.visibility ?? 'scoped')) {
        await txn.put(portRecordKey(held.port), { owner: input.owner, capability, visibility });
      }
      return held.port;
    }
    let port: number;
    if (preferred !== undefined) {
      if (!Number.isInteger(preferred) || preferred < 1 || preferred > RESERVATION_LAST_PORT) {
        throw conflict(`port ${preferred} is outside 1..${RESERVATION_LAST_PORT}`);
      }
      if (taken.has(preferred)) throw conflict(`port ${preferred} is held by another owner or listener`);
      port = preferred;
    } else {
      port = RESERVATION_FIRST_PORT;
      while (port <= RESERVATION_LAST_PORT && taken.has(port)) port += 1;
      if (port > RESERVATION_LAST_PORT) throw conflict('no free port left to reserve');
    }
    await txn.put(portRecordKey(port), {
      owner: input.owner,
      capability: input.capability ?? null,
      visibility: input.visibility ?? 'scoped',
    });
    return port;
  };
  return ctx.storage.transaction(claim);
}

/** End an owner's hold on a port. Another owner's record is left alone and refused. */
export async function releasePortReservation(
  ctx: PortReservationHost['ctx'],
  input: { owner: string; port: number },
): Promise<boolean> {
  // The read, the owner check and the delete are one transaction: a concurrent
  // claim or a foreign release cannot interleave between them.
  return ctx.storage.transaction(async (txn) => {
    const stored = await readPortReservation({ storage: txn }, input.port);
    if (stored === null) return false;
    if (stored.owner !== input.owner) throw conflict(`port ${input.port} is held by another owner`);
    await txn.delete(portRecordKey(input.port));
    return true;
  });
}

export async function readPortCapability(
  self: PortCapabilityHost,
  port: number,
): Promise<string | null> {
  // The stored record is the only source of truth: a capability belongs to
  // whoever is registered on the port, and its owner field is preserved by
  // persist, never consulted as a gate. Durable ownership rides the
  // reservation's own restore path (restoreReservedPortCapability).
  const stored = await readPortExposure(self.ctx, port);
  return stored?.capability ?? null;
}

/**
 * Re-adopt the persisted capability into whatever the registry holds now.
 * Answers the adopted value, or null when there was nothing to adopt.
 */
export async function restorePortCapability(
  self: PortCapabilityHost,
  port: number,
): Promise<string | null> {
  const stored = await readPortCapability(self, port);
  if (!stored) return null;
  return self.portRegistry.restoreCapability(Number(port), stored) ? stored : null;
}

/**
 * Re-adopt the persisted capability ONLY for the owner the stored record
 * names. The durable re-drive calls this with its own owner: the reservation
 * is the same source of truth the preflight reads, so a release or a foreign
 * claim mid-boot cannot smuggle an exposure across.
 */
export async function restoreReservedPortCapability(
  self: PortCapabilityHost,
  port: number,
  owner: string,
): Promise<string | null> {
  const stored = await readPortReservation(self.ctx, port);
  if (stored === null || stored.owner !== owner || stored.capability === null) return null;
  return self.portRegistry.restoreCapability(Number(port), stored.capability) ? stored.capability : null;
}

export async function persistPortCapability(
  self: PortCapabilityHost,
  port: number,
  capability: string,
): Promise<void> {
  // Read-modify-write inside the reservation's own transaction, and the stored
  // record is the ONLY source of truth for owner: an SDK ports.list()/expose
  // on a durable application's port must not rewrite the row it is reporting
  // on, or the next durable preflight sees a reservation nobody owns.
  await self.ctx.storage.transaction(async (txn) => {
    const stored = await txn.get(portRecordKey(port));
    const parsed = PortRecordSchema.safeParse(stored);
    await txn.put(portRecordKey(port), {
      capability: PortCapabilitySchema.parse(capability),
      owner: parsed.success ? parsed.data.owner : null,
      ...(parsed.success && parsed.data.visibility !== undefined
        ? { visibility: parsed.data.visibility }
        : {}),
    });
  });
}

/**
 * Retire the durable capability for a port. Called before every registration
 * that is not a restore, so a token handed out for the previous occupant of a
 * port cannot reach the next one. An owner's reservation survives it.
 */
export async function clearPortCapability(self: PortCapabilityHost, port: number): Promise<void> {
  await self.ctx.storage.transaction(async (txn) => {
    const stored = PortRecordSchema.safeParse(await txn.get(portRecordKey(port)));
    const record = stored.success ? stored.data : null;
    if (record !== null && record.owner !== null) {
      await txn.put(portRecordKey(port), {
        owner: record.owner,
        capability: null,
        ...(record.visibility !== undefined ? { visibility: record.visibility } : {}),
      });
      return;
    }
    await txn.delete(portRecordKey(port));
  });
}
