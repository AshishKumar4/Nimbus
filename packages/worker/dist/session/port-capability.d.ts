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
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
/** The minimum a caller needs to own a port capability. */
export interface PortCapabilityHost {
    ctx: {
        storage: {
            get(key: string): Promise<unknown>;
            put(key: string, value: unknown): Promise<void>;
            delete(key: string): Promise<unknown>;
        };
    };
    portRegistry: PortRegistry;
    /** Logical owner supplied by an embedder; null retains ordinary port-scoped exposure. */
    portCapabilityOwner?(port: number): string | null;
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
export interface PortExposure {
    readonly capability: string;
    readonly owner: string | null;
}
/** The per-port record as stored: a bare reservation has no capability yet. */
export interface PortReservation {
    readonly owner: string | null;
    readonly capability: string | null;
}
/** Read the raw per-port record: a reservation, an exposure, or nothing. */
export declare function readPortReservation(ctx: PortCapabilityHost['ctx'], port: number): Promise<PortReservation | null>;
/** Read retained exposure metadata without starting a session or restoring a listener. */
export declare function readPortExposure(ctx: PortCapabilityHost['ctx'], port: number): Promise<PortExposure | null>;
/**
 * Hold a port for `owner` across instances. The owner's existing port is
 * answered again; otherwise the preferred port is claimed, or the lowest
 * free one. A preferred port that another record or a live listener holds
 * is refused, never silently moved. Mints no capability.
 */
export declare function reservePort(ctx: PortReservationHost['ctx'], input: {
    owner: string;
    preferredPort?: number;
    occupiedPorts: ReadonlySet<number>;
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
export declare function persistPortCapability(self: PortCapabilityHost, port: number, capability: string): Promise<void>;
/**
 * Retire the durable capability for a port. Called before every registration
 * that is not a restore, so a token handed out for the previous occupant of a
 * port cannot reach the next one. An owner's reservation survives it.
 */
export declare function clearPortCapability(self: PortCapabilityHost, port: number): Promise<void>;
//# sourceMappingURL=port-capability.d.ts.map