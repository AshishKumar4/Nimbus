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

const BINDING_NAME = 'NIMBUS_PUBLIC_DIRECTORY';
const DIRECTORY_NAME = 'public-directory';
const ROW_PREFIX = 'public-capability:';

export interface PublicDirectoryEntry {
  readonly tenantSegment: string;
  readonly sid: string;
  readonly port: number;
}

function rowKey(capability: string): string {
  return `${ROW_PREFIX}${capability}`;
}

/** The DO body, usable with any `{ storage }` the tests hand it. */
export class PublicDirectoryStore {
  constructor(private ctx: { storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<unknown>;
  } }) {}

  async bind(
    capability: string,
    entry: { tenantSegment: string; sid: string; port: number },
  ): Promise<void> {
    if (!/^[a-f0-9]{24}$/.test(capability)) {
      throw new Error('NimbusPublicDirectory.bind: capability must be 24 lowercase hex');
    }
    if (typeof entry.tenantSegment !== 'string' || entry.tenantSegment.length === 0
      || typeof entry.sid !== 'string' || entry.sid.length === 0
      || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
      throw new Error('NimbusPublicDirectory.bind: entry needs tenantSegment, sid, and a real port');
    }
    await this.ctx.storage.put(rowKey(capability), {
      tenantSegment: entry.tenantSegment,
      sid: entry.sid,
      port: entry.port,
    });
  }

  async unbind(capability: string): Promise<void> {
    await this.ctx.storage.delete(rowKey(capability));
  }

  async resolve(capability: string): Promise<PublicDirectoryEntry | null> {
    const stored = await this.ctx.storage.get<PublicDirectoryEntry>(rowKey(capability));
    if (!stored) return null;
    return stored;
  }
}

/**
 * The stub the router and the session share: one name, one binding, one
 * instance. A missing binding on an enforce-mode deployment is loud at the
 * caller — this helper returns null and the caller decides.
 */
export function publicDirectoryStub(env: unknown): {
  bind(capability: string, entry: PublicDirectoryEntry): Promise<void>;
  unbind(capability: string): Promise<void>;
  resolve(capability: string): Promise<PublicDirectoryEntry | null>;
} | null {
  const namespace = (env as Record<string, unknown> | null | undefined)?.[BINDING_NAME] as
    | { idFromName(name: string): unknown; get(id: unknown): unknown }
    | undefined;
  if (!namespace || typeof namespace.idFromName !== 'function') return null;
  return namespace.get(namespace.idFromName(DIRECTORY_NAME)) as {
    bind(capability: string, entry: PublicDirectoryEntry): Promise<void>;
    unbind(capability: string): Promise<void>;
    resolve(capability: string): Promise<PublicDirectoryEntry | null>;
  };
}

// ── Session side ─────────────────────────────────────────────────────────────

import { LEGACY_PUBLIC_DO_SEGMENT } from '../_shared/session-router.js';

/**
 * `{ tenantSegment, sid }` for the session DO this host is, read off its own
 * DO name — `tn:sub:sid` (or `legacy:public:_:sid`), no request header
 * needed. A host without a DO id (a unit-test stub) may carry the fields on
 * itself.
 */
function sessionIdentity(host: {
  ctx?: { id?: { name?: unknown } };
  tenantSegment?: string;
  sessionId?: string;
}): { tenantSegment: string; sid: string } | null {
  const name = host.ctx?.id?.name;
  if (typeof name === 'string' && name.length > 0) {
    const cut = name.lastIndexOf(':');
    if (cut > 0) return { tenantSegment: name.slice(0, cut), sid: name.slice(cut + 1) };
  }
  if (typeof host.tenantSegment === 'string' && typeof host.sessionId === 'string'
    && host.tenantSegment.length > 0 && host.sessionId.length > 0) {
    return { tenantSegment: host.tenantSegment, sid: host.sessionId };
  }
  return null;
}

/**
 * Publish a public port's capability to the routing directory. A legacy-
 * public deployment needs no directory — its DO name is already the one
 * the public form resolves to — and is allowed to run without the binding.
 * Anything else MUST bind, and a missing `NIMBUS_PUBLIC_DIRECTORY` binding
 * on a non-legacy deployment is a loud error: the exposure would be half-
 * public — stored as public, unroutable in practice.
 */
export async function bindPublicPortCapability(
  host: { env?: unknown; ctx?: { id?: { name?: unknown } }; tenantSegment?: string; sessionId?: string },
  capability: string,
  port: number,
): Promise<void> {
  const identity = sessionIdentity(host);
  if (identity === null) return;
  if (identity.tenantSegment === LEGACY_PUBLIC_DO_SEGMENT) return;
  const stub = publicDirectoryStub(host.env);
  if (stub === null) {
    throw new Error(
      'Nimbus: a public port exposure needs the NIMBUS_PUBLIC_DIRECTORY binding '
        + '— without it the capability URL cannot resolve to this session. '
        + 'Add the binding and the NimbusPublicDirectory migration to wrangler.jsonc.',
    );
  }
  await stub.bind(capability, { tenantSegment: identity.tenantSegment, sid: identity.sid, port });
}

/** Retire a public port's capability from the routing directory. */
export async function unbindPublicPortCapability(
  host: { env?: unknown; ctx?: { id?: { name?: unknown } }; tenantSegment?: string; sessionId?: string },
  capability: string,
): Promise<void> {
  const identity = sessionIdentity(host);
  if (identity === null) return;
  if (identity.tenantSegment === LEGACY_PUBLIC_DO_SEGMENT) return;
  const stub = publicDirectoryStub(host.env);
  if (stub === null) return; // unbind of a bind that never happened is not an error
  await stub.unbind(capability);
}
