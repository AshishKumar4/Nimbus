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
}
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
 * port cannot reach the next one.
 */
export declare function clearPortCapability(self: PortCapabilityHost, port: number): Promise<void>;
//# sourceMappingURL=port-capability.d.ts.map