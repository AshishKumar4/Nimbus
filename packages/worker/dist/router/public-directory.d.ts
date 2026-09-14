/**
 * public-directory.ts — capability → session routing for public preview hosts.
 *
 * The public capability host form `<cap>--<port>--<sid>.<suffix>` carries
 * no session:attach credential, so the router has no verified tenant to
 * name the session DO with. This singleton Durable Object is the one
 * lookup that answers it: keyed by the unguessable 24-hex capability,
 * it says which tenant segment + sid + port the capability belongs to.
 * Rows are written by the session the moment a port goes public and are
 * deleted on unexpose/clear/remove — there is no listing API, so the
 * directory is never an enumeration surface.
 */
export interface PublicDirectoryEntry {
    readonly tenantSegment: string;
    readonly sid: string;
    readonly port: number;
}
/** The DO body, usable with any `{ storage }` the tests hand it. */
export declare class PublicDirectoryStore {
    private ctx;
    constructor(ctx: {
        storage: {
            get<T = unknown>(key: string): Promise<T | undefined>;
            put(key: string, value: unknown): Promise<void>;
            delete(key: string): Promise<unknown>;
        };
    });
    bind(capability: string, entry: {
        tenantSegment: string;
        sid: string;
        port: number;
    }): Promise<void>;
    unbind(capability: string): Promise<void>;
    resolve(capability: string): Promise<PublicDirectoryEntry | null>;
}
/**
 * The stub the router and the session share: one name, one binding, one
 * instance. A missing binding on an enforce-mode deployment is loud at the
 * caller — this helper returns null and the caller decides.
 */
export declare function publicDirectoryStub(env: unknown): {
    bind(capability: string, entry: PublicDirectoryEntry): Promise<void>;
    unbind(capability: string): Promise<void>;
    resolve(capability: string): Promise<PublicDirectoryEntry | null>;
} | null;
/**
 * Publish a public port's capability to the routing directory. A legacy-
 * public deployment needs no directory — its DO name is already the one
 * the public form resolves to — and is allowed to run without the binding.
 * Anything else MUST bind, and a missing `NIMBUS_PUBLIC_DIRECTORY` binding
 * on a non-legacy deployment is a loud error: the exposure would be half-
 * public — stored as public, unroutable in practice.
 */
export declare function bindPublicPortCapability(host: {
    env?: unknown;
    ctx?: {
        id?: {
            name?: unknown;
        };
    };
    tenantSegment?: string;
    sessionId?: string;
}, capability: string, port: number): Promise<void>;
/** Retire a public port's capability from the routing directory. */
export declare function unbindPublicPortCapability(host: {
    env?: unknown;
    ctx?: {
        id?: {
            name?: unknown;
        };
    };
    tenantSegment?: string;
    sessionId?: string;
}, capability: string): Promise<void>;
//# sourceMappingURL=public-directory.d.ts.map