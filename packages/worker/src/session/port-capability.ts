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

import { z } from 'zod/v4';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { PORT_CAPABILITY_KEY_PREFIX } from './keys.js';

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

/** The shape `createPortCapability` mints: 12 random bytes, hex. */
const PortCapabilitySchema = z.string().regex(/^[a-f0-9]{24}$/);

function key(port: number): string {
  return `${PORT_CAPABILITY_KEY_PREFIX}${Number(port)}`;
}

export async function readPortCapability(
  self: PortCapabilityHost,
  port: number,
): Promise<string | null> {
  const stored = PortCapabilitySchema.safeParse(await self.ctx.storage.get(key(port)));
  return stored.success ? stored.data : null;
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

export async function persistPortCapability(
  self: PortCapabilityHost,
  port: number,
  capability: string,
): Promise<void> {
  await self.ctx.storage.put(key(port), PortCapabilitySchema.parse(capability));
}

/**
 * Retire the durable capability for a port. Called before every registration
 * that is not a restore, so a token handed out for the previous occupant of a
 * port cannot reach the next one.
 */
export async function clearPortCapability(self: PortCapabilityHost, port: number): Promise<void> {
  await self.ctx.storage.delete(key(port));
}
