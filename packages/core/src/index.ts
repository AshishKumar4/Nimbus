/**
 * index.ts — the backend-agnostic Nimbus surface.
 *
 * A host supplies SQLite through the ports in `runtime/os-contracts.ts` and
 * gets back a durable filesystem and a shell over it. Nothing here knows what
 * the host is: a Durable Object hands over `ctx.storage.sql`, a bun process
 * hands over `bun:sqlite`, and the same code runs on both.
 *
 * Cloudflare-specific hosting — Durable Objects, facets, the Worker Loader,
 * the router and the auth surface — lives in `@nimbus-sh/worker`, which
 * depends on this package.
 */

export { NimbusWorkspace } from './workspace/nimbus-workspace.js';
export type { NimbusWorkspaceOptions } from './workspace/nimbus-workspace.js';
export type {
  SqlDatabase,
  SqlTransactions,
  SqlRow,
  SqlValue,
  TransactionHost,
} from './runtime/os-contracts.js';
export { seedRuntimePackage } from './runtime/runtime-package.js';
export type { RuntimePackage, SeededRuntime } from './runtime/runtime-package.js';
export type {
  ManifestEntrypoint,
  ManifestFile,
  RuntimeManifest,
} from './runtime/runtime-manifest.js';
export { localFacetHost } from './runtime/local-facet-host.js';
export type {
  Facet,
  FacetBindings,
  FacetFn,
  FacetHost,
  FacetSpec,
  FacetSubmitOptions,
} from './runtime/facet-host.js';
