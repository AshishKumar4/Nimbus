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
 * is why `clearPortCapability` sits next to every `portRegistry.register` and
 * `restorePortCapability` sits only at the two places a dev server is
 * deliberately brought back.
 *
 * The same per-port record also carries a RESERVATION: an owner may hold a
 * port with no capability yet, so a durable application keeps its port across
 * instances whether or not it is currently exposed. Clearing a capability
 * keeps the owner's reservation; only `releasePortReservation` ends it.
 */
import { z } from 'zod/v4';
import { PORT_CAPABILITY_KEY_PREFIX } from './keys.js';
/** The shape `createPortCapability` mints: 12 random bytes, hex. */
const PortCapabilitySchema = z.string().regex(/^[a-f0-9]{24}$/);
const PortRecordSchema = z.object({ capability: PortCapabilitySchema.nullable(), owner: z.string().nullable() });
const RESERVATION_FIRST_PORT = 20000;
const RESERVATION_LAST_PORT = 65535;
function owner(self, port) {
    return self.portCapabilityOwner?.(Number(port)) ?? null;
}
function key(port) {
    return `${PORT_CAPABILITY_KEY_PREFIX}${Number(port)}`;
}
function conflict(detail) {
    return new Error(`port reservation conflict: ${detail}`);
}
/** Read the raw per-port record: a reservation, an exposure, or nothing. */
export async function readPortReservation(ctx, port) {
    const stored = PortRecordSchema.safeParse(await ctx.storage.get(key(port)));
    return stored.success ? stored.data : null;
}
/** Read retained exposure metadata without starting a session or restoring a listener. */
export async function readPortExposure(ctx, port) {
    const stored = await readPortReservation(ctx, port);
    return stored !== null && stored.capability !== null ? { capability: stored.capability, owner: stored.owner } : null;
}
/**
 * Hold a port for `owner` across instances. The owner's existing port is
 * answered again; otherwise the preferred port is claimed, or the lowest
 * free one. A preferred port that another record or a live listener holds
 * is refused, never silently moved. Mints no capability.
 */
export async function reservePort(ctx, input) {
    const claim = async (txn) => {
        const records = await txn.list({ prefix: PORT_CAPABILITY_KEY_PREFIX });
        const taken = new Set(input.occupiedPorts);
        let held = null;
        for (const [storedKey, value] of records) {
            const port = Number(storedKey.slice(PORT_CAPABILITY_KEY_PREFIX.length));
            if (!Number.isInteger(port))
                continue;
            taken.add(port);
            const parsed = PortRecordSchema.safeParse(value);
            if (parsed.success && parsed.data.owner === input.owner)
                held = port;
        }
        const preferred = input.preferredPort;
        if (held !== null) {
            if (preferred === undefined || preferred === held)
                return held;
            throw conflict(`owner already holds port ${held}, cannot reserve ${preferred}`);
        }
        let port;
        if (preferred !== undefined) {
            if (!Number.isInteger(preferred) || preferred < 1 || preferred > RESERVATION_LAST_PORT) {
                throw conflict(`port ${preferred} is outside 1..${RESERVATION_LAST_PORT}`);
            }
            if (taken.has(preferred))
                throw conflict(`port ${preferred} is held by another owner or listener`);
            port = preferred;
        }
        else {
            port = RESERVATION_FIRST_PORT;
            while (port <= RESERVATION_LAST_PORT && taken.has(port))
                port += 1;
            if (port > RESERVATION_LAST_PORT)
                throw conflict('no free port left to reserve');
        }
        await txn.put(key(port), { owner: input.owner, capability: null });
        return port;
    };
    return ctx.storage.transaction(claim);
}
/** End an owner's hold on a port. Another owner's record is left alone and refused. */
export async function releasePortReservation(ctx, input) {
    // The read, the owner check and the delete are one transaction: a concurrent
    // claim or a foreign release cannot interleave between them.
    return ctx.storage.transaction(async (txn) => {
        const stored = await readPortReservation({ storage: txn }, input.port);
        if (stored === null)
            return false;
        if (stored.owner !== input.owner)
            throw conflict(`port ${input.port} is held by another owner`);
        await txn.delete(key(input.port));
        return true;
    });
}
export async function readPortCapability(self, port) {
    const stored = await readPortExposure(self.ctx, port);
    return stored !== null && stored.owner === owner(self, port) ? stored.capability : null;
}
/**
 * Re-adopt the persisted capability into whatever the registry holds now.
 * Answers the adopted value, or null when there was nothing to adopt.
 */
export async function restorePortCapability(self, port) {
    const stored = await readPortCapability(self, port);
    if (!stored)
        return null;
    return self.portRegistry.restoreCapability(Number(port), stored) ? stored : null;
}
export async function persistPortCapability(self, port, capability) {
    await self.ctx.storage.put(key(port), { capability: PortCapabilitySchema.parse(capability), owner: owner(self, port) });
}
/**
 * Retire the durable capability for a port. Called before every registration
 * that is not a restore, so a token handed out for the previous occupant of a
 * port cannot reach the next one. An owner's reservation survives it.
 */
export async function clearPortCapability(self, port) {
    const stored = await readPortReservation(self.ctx, port);
    if (stored !== null && stored.owner !== null) {
        await self.ctx.storage.put(key(port), { owner: stored.owner, capability: null });
        return;
    }
    await self.ctx.storage.delete(key(port));
}
