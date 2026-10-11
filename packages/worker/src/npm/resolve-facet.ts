/**
 * resolve-facet.ts — shared wire types for the per-packument resolver facet.
 *
 * The npm resolver phase runs inside a IsolatePool isolate so the
 * supervisor DO heap stays flat while large packuments are decoded. The
 * per-packument task body lives in resolve-one-facet.ts; this module holds
 * the types exchanged between supervisor and facet over RPC besides the
 * registry records (npm/registry-record.ts).
 */

/**
 * Telemetry-event mirror of `RegistryEvent`. The facet cannot import the
 * registry directly because the preamble has no import surface, so the type
 * is duplicated here.
 */
export type FacetRegistryEvent =
  | { type: 'swap'; from: string; to: string; ctx: 'transitive' }
  | { type: 'reject'; from: string; reason: string; suggest?: string; ctx: 'transitive' }
  // Advisory: the package installs (npm parity — it cannot run here);
  // the require-side refusal names the reason.
  | { type: 'advisory'; from: string; reason: string; suggest?: string; ctx: 'transitive' }
  | { type: 'transitive-skip'; from: string; reason: string };
