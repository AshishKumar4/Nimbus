/**
 * The node-compat layer's sources the node facet generators splice, from src:
 * what fetchNodeFacetSources hands them in production, where they reach the
 * facet as staged assets (node-shims-artifact-parity keeps those equal to
 * src). The shims are the caller's: the real generateShimsCode(), or a marker
 * where a test only needs to find where they land. The interpreter and its
 * host module are the staged ones: building them takes esbuild, and a launch
 * compiles them only when its program produces code no launch staged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VFS_WRITE_LEDGER_SOURCE } from '../../../packages/core/src/_shared/vfs-write-ledger.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../../packages/worker/src/vfs/facet-resident-store.ts';
import { JS_INTERPRETER_ENTRY, JS_INTERPRETER_OPS_ENTRY } from '../../../packages/worker/src/node-shims-artifact.generated.ts';

const PUBLIC = fileURLToPath(new URL('../../../packages/worker/public', import.meta.url));

export function nodeFacetSources(shims) {
  return {
    shims,
    ledger: VFS_WRITE_LEDGER_SOURCE,
    residentStore: FACET_RESIDENT_STORE_SOURCE,
    interpreter: readFileSync(join(PUBLIC, JS_INTERPRETER_ENTRY), 'utf8'),
    interpreterOps: readFileSync(join(PUBLIC, JS_INTERPRETER_OPS_ENTRY), 'utf8'),
  };
}
