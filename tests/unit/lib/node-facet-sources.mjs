/**
 * The node-compat layer's sources the node facet generators splice, from src:
 * what fetchNodeFacetSources hands them in production, where the three reach
 * the facet as staged assets (node-shims-artifact-parity keeps those equal to
 * src). The shims are the caller's: the real generateShimsCode(), or a marker
 * where a test only needs to find where they land.
 */
import { VFS_WRITE_LEDGER_SOURCE } from '../../../packages/core/src/_shared/vfs-write-ledger.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../../packages/worker/src/vfs/facet-resident-store.ts';

export function nodeFacetSources(shims) {
  return { shims, ledger: VFS_WRITE_LEDGER_SOURCE, residentStore: FACET_RESIDENT_STORE_SOURCE };
}
