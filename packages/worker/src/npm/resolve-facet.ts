/**
 * resolve-facet.ts — shared wire types for the per-packument resolver facet.
 *
 * The npm resolver phase runs inside a IsolatePool isolate so the
 * supervisor DO heap stays flat while large packuments are decoded. The
 * per-packument task body lives in resolve-one-facet.ts; this module holds
 * the types exchanged between supervisor and facet over RPC.
 */

// ── Types exchanged between supervisor and facet ─────────────────────────

export interface FacetCachedEntry {
  /** Same shape as RegistryCacheEntry from src/npm/cache.ts. JSON-only
   *  fields so the structured-clone over RPC doesn't choke. */
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
  depsJson: string;
  /** Required peerDependencies with optionals filtered. */
  peerDepsJson?: string;
  exportsJson: string;
  main: string;
  moduleField: string;
  binJson: string;
  /** JSON-encoded `{ os?, cpu?, libc? }` platform constraints. */
  platformJson?: string;
  /** JSON-encoded optionalDependencies. */
  optionalDepsJson?: string;
  fetchedAt: number;
}

/**
 * Telemetry-event mirror of `RegistryEvent`. The facet cannot import the
 * registry directly because the preamble has no import surface, so the type
 * is duplicated here.
 */
export type FacetRegistryEvent =
  | { type: 'swap'; from: string; to: string; ctx: 'transitive' }
  | { type: 'reject'; from: string; reason: string; suggest?: string; ctx: 'transitive' }
  | { type: 'transitive-skip'; from: string; reason: string };
