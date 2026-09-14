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
/**
 * The optional name alias a reservation may carry: one DNS label, so it can
 * stand where the port stands in a preview host (`<name>--<sid>`). Never
 * purely numeric — a numeric middle label IS a port. No `--`: that is the
 * host-label separator. No 24 lowercase hex: that is ambiguous with a
 * capability label, so parsing could mistake a name for a bearer.
 */
export declare const APP_NAME_RE: RegExp;
export declare function isValidAppName(name: string): boolean;
export declare const PortRecordSchema: z.ZodObject<{
    kind: z.ZodDefault<z.ZodEnum<{
        explicit: "explicit";
        derived: "derived";
    }>>;
    capability: z.ZodNullable<z.ZodString>;
    owner: z.ZodNullable<z.ZodString>;
    visibility: z.ZodOptional<z.ZodEnum<{
        scoped: "scoped";
        public: "public";
    }>>;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export interface PortExposure {
    readonly capability: string;
    readonly owner: string | null;
    readonly visibility: PortVisibility;
    readonly name?: string;
}
/** The per-port record as stored: a bare reservation has no capability yet. */
export interface PortReservation {
    readonly kind: 'explicit' | 'derived';
    readonly owner: string | null;
    readonly capability: string | null;
    readonly visibility: PortVisibility;
    /** The reservation's name alias, when one was given at expose time. */
    readonly name?: string;
}
export declare function portRecordKey(port: number): string;
/** Read the raw per-port record: a reservation, an exposure, or nothing. */
export declare function readPortReservation(ctx: {
    storage: PortReservationTransaction;
}, port: number): Promise<PortReservation | null>;
/** Read retained exposure metadata without starting a session or restoring a listener. */
export declare function readPortExposure(ctx: PortCapabilityHost['ctx'], port: number): Promise<PortExposure | null>;
/** Every stored port record, keyed by port — the scan `apps.list` and the name lookups read. */
export declare function listPortReservations(ctx: {
    storage: PortReservationTransaction;
}): Promise<Map<number, PortReservation>>;
/** The port a name alias resolves to inside this session, or null. */
export declare function readPortReservationByName(ctx: {
    storage: PortReservationTransaction;
}, name: string): Promise<{
    port: number;
    reservation: PortReservation;
} | null>;
/** The port an owner holds, or null when the owner has no reservation. */
export declare function readPortReservationByOwner(ctx: {
    storage: PortReservationTransaction;
}, owner: string): Promise<{
    port: number;
    reservation: PortReservation;
} | null>;
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
    kind?: 'explicit' | 'derived';
    occupiedPorts: ReadonlySet<number>;
    capability?: string;
    visibility?: PortVisibility;
    /** A name alias for the reservation — unique per session, DNS-label-safe. */
    name?: string;
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
 * Replace the port's capability with a freshly minted one, in place: owner,
 * visibility and name stay, every URL built on the old value stops
 * resolving. Answers the new capability, or null when no record exists —
 * there is nothing to rotate on a port nobody has reserved or exposed.
 */
export declare function rotatePortCapability(self: PortCapabilityHost, port: number, capability: string): Promise<string | null>;
/**
 * Retire the durable capability for a port. Called before every registration
 * that is not a restore, so a token handed out for the previous occupant of a
 * port cannot reach the next one. An owner's reservation survives it.
 */
export declare function clearPortCapability(self: PortCapabilityHost, port: number): Promise<void>;
export {};
//# sourceMappingURL=port-capability.d.ts.map