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
    list<T = unknown>(options: {
        prefix: string;
    }): Promise<Map<string, T>>;
}
/** The storage slice a reservation needs: a prefix scan, and a required atomic transaction. */
export interface PortReservationStorage extends PortReservationTransaction {
    transaction<T>(body: (txn: PortReservationTransaction) => Promise<T>): Promise<T>;
}
export interface PortReservationHost {
    ctx: {
        storage: PortReservationStorage;
    };
}
/** 'scoped' is the default: capability-checked but never the public bearer. */
declare const PortVisibilitySchema: z.ZodEnum<{
    scoped: "scoped";
    public: "public";
}>;
export type PortVisibility = z.infer<typeof PortVisibilitySchema>;
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
/** Read the raw per-port record: a reservation, an exposure, or nothing. */
export declare function readPortReservation(ctx: {
    storage: PortReservationTransaction;
}, port: number): Promise<PortReservation | null>;
/** Read retained exposure metadata without starting a session or restoring a listener. */
export declare function readPortExposure(ctx: PortCapabilityHost['ctx'], port: number): Promise<PortExposure | null>;
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
export declare function reservePort(ctx: PortReservationHost['ctx'], input: {
    owner: string;
    preferredPort?: number;
    occupiedPorts: ReadonlySet<number>;
    capability?: string;
    visibility?: PortVisibility;
}): Promise<number>;
/** End an owner's hold on a port. Another owner's record is left alone and refused. */
export declare function releasePortReservation(ctx: PortReservationHost['ctx'], input: {
    owner: string;
    port: number;
}): Promise<boolean>;
export declare function readPortCapability(self: PortCapabilityHost, port: number): Promise<string | null>;
/**
 * Re-adopt the persisted capability into whatever the registry holds now.
 * Answers the adopted value, or null when there was nothing to adopt.
 */
export declare function restorePortCapability(self: PortCapabilityHost, port: number): Promise<string | null>;
/**
 * Re-adopt the persisted capability ONLY for the owner the stored record
 * names. The durable re-drive calls this with its own owner: the reservation
 * is the same source of truth the preflight reads, so a release or a foreign
 * claim mid-boot cannot smuggle an exposure across.
 */
export declare function restoreReservedPortCapability(self: PortCapabilityHost, port: number, owner: string): Promise<string | null>;
export declare function persistPortCapability(self: PortCapabilityHost, port: number, capability: string): Promise<void>;
/**
 * Retire the durable capability for a port. Called before every registration
 * that is not a restore, so a token handed out for the previous occupant of a
 * port cannot reach the next one. An owner's reservation survives it.
 */
export declare function clearPortCapability(self: PortCapabilityHost, port: number): Promise<void>;
export {};
//# sourceMappingURL=port-capability.d.ts.map