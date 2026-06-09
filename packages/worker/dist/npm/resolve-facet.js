/**
 * resolve-facet.ts — shared wire types for the per-packument resolver facet.
 *
 * The npm resolver phase runs inside a NimbusLoaderPool isolate so the
 * supervisor DO heap stays flat while large packuments are decoded. The
 * per-packument task body lives in resolve-one-facet.ts; this module holds
 * the types exchanged between supervisor and facet over RPC.
 */
export {};
