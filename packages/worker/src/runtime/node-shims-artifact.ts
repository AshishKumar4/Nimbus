/**
 * node-shims-artifact.ts — supervisor-side fetcher for the staged sources of
 * the node-compat layer: the shims, the VFS write ledger and the resident store.
 *
 * All three are staged as static assets by scripts/bundle-node-shims.mjs and
 * promoted out of the worker bundle for its size gate: only a node facet ever
 * runs them, and every node facet's generated worker text splices them. This
 * fetch therefore sits on the exec hot path: the result is memoized at module
 * scope (one fetch per isolate); each source is read and verified by
 * runtime/staged-source.ts. A missing ASSETS binding fails loud rather than
 * producing a facet with no node-compat layer.
 */

import {
  NODE_SHIMS_BUILD_ID,
  NODE_SHIMS_ENTRY,
  NODE_SHIMS_SHA256,
  RESIDENT_STORE_BUILD_ID,
  RESIDENT_STORE_ENTRY,
  RESIDENT_STORE_SHA256,
  VFS_WRITE_LEDGER_BUILD_ID,
  VFS_WRITE_LEDGER_ENTRY,
  VFS_WRITE_LEDGER_SHA256,
} from '../node-shims-artifact.generated.js';
import { fetchStagedSource, type StagedSource, type StagedSourceEnv } from './staged-source.js';

/** What a node facet's generated worker text splices around the program. */
export interface NodeFacetSources {
  /** The node-compat shims: node-shims.ts generateShimsCode(). */
  shims: string;
  /** The write ledger the shims' filesystem writes go through: core VFS_WRITE_LEDGER_SOURCE. */
  ledger: string;
  /** A resident facet's SQLite-backed resident set: vfs/facet-resident-store.ts FACET_RESIDENT_STORE_SOURCE. */
  residentStore: string;
}

const STAGED_BY = 'scripts/bundle-node-shims.mjs';
const REQUIRED_BY = 'the node runtime';

const NODE_SHIMS: StagedSource = {
  label: 'node-shims',
  entry: NODE_SHIMS_ENTRY,
  buildId: NODE_SHIMS_BUILD_ID,
  sha256: NODE_SHIMS_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
};
const VFS_WRITE_LEDGER: StagedSource = {
  label: 'vfs-write-ledger',
  entry: VFS_WRITE_LEDGER_ENTRY,
  buildId: VFS_WRITE_LEDGER_BUILD_ID,
  sha256: VFS_WRITE_LEDGER_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
};
const RESIDENT_STORE: StagedSource = {
  label: 'resident-store',
  entry: RESIDENT_STORE_ENTRY,
  buildId: RESIDENT_STORE_BUILD_ID,
  sha256: RESIDENT_STORE_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
};

let memo: Promise<NodeFacetSources> | null = null;

/**
 * The node-compat layer's sources for facet worker codegen. Memoized per
 * isolate; a failed fetch clears the memo so the next exec retries instead of
 * pinning the error.
 */
export function fetchNodeFacetSources(env: StagedSourceEnv): Promise<NodeFacetSources> {
  if (!memo) {
    memo = Promise.all([
      fetchStagedSource(env, NODE_SHIMS),
      fetchStagedSource(env, VFS_WRITE_LEDGER),
      fetchStagedSource(env, RESIDENT_STORE),
    ]).then(([shims, ledger, residentStore]) => ({ shims, ledger, residentStore }))
      .catch((e: unknown) => {
        memo = null;
        throw e;
      });
  }
  return memo;
}
