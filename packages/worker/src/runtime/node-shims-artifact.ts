/**
 * node-shims-artifact.ts — supervisor-side fetcher for the staged sources of
 * the node-compat layer: the shims, the VFS write ledger, the resident store,
 * and the runtime-code interpreter with its host module.
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
  JS_INTERPRETER_BUILD_ID,
  JS_INTERPRETER_PRIMORDIALS_BUILD_ID,
  JS_INTERPRETER_PRIMORDIALS_ENTRY,
  JS_INTERPRETER_PRIMORDIALS_SHA256,
  JS_INTERPRETER_ENTRY,
  JS_INTERPRETER_OPS_BUILD_ID,
  JS_INTERPRETER_OPS_ENTRY,
  JS_INTERPRETER_OPS_SHA256,
  JS_INTERPRETER_SHA256,
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
import {
  fetchStagedText,
  memoizeUntilRejected,
  stagedRuntimeSource,
  type StagedSourceEnv,
} from './staged-source.js';

/** What a node facet's generated worker text splices around the program. */
export interface NodeFacetSources {
  /** The node-compat shims: node-shims.ts generateShimsCode(). */
  shims: string;
  /** The write ledger the shims' filesystem writes go through: core VFS_WRITE_LEDGER_SOURCE. */
  ledger: string;
  /** A resident facet's SQLite-backed resident set: vfs/facet-resident-store.ts FACET_RESIDENT_STORE_SOURCE. */
  residentStore: string;
  /** The built-ins the interpreter calls, captured at the launch's start (core interpreter/primordials.ts), a module of the map. */
  interpreterPrimordials: string;
  /** The runtime-code interpreter (core interpreter/), a module of the map. */
  interpreter: string;
  /** The interpreter's host module (core interpreter/host-ops.ts HOST_OPS_SOURCE), a module of the map. */
  interpreterOps: string;
}

const STAGED_BY = 'scripts/bundle-node-shims.mjs';
const REQUIRED_BY = 'the node runtime';

const NODE_SHIMS = stagedRuntimeSource({
  label: 'node-shims',
  entry: NODE_SHIMS_ENTRY,
  buildId: NODE_SHIMS_BUILD_ID,
  sha256: NODE_SHIMS_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
});
const VFS_WRITE_LEDGER = stagedRuntimeSource({
  label: 'vfs-write-ledger',
  entry: VFS_WRITE_LEDGER_ENTRY,
  buildId: VFS_WRITE_LEDGER_BUILD_ID,
  sha256: VFS_WRITE_LEDGER_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
});
const RESIDENT_STORE = stagedRuntimeSource({
  label: 'resident-store',
  entry: RESIDENT_STORE_ENTRY,
  buildId: RESIDENT_STORE_BUILD_ID,
  sha256: RESIDENT_STORE_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
});

const JS_INTERPRETER_PRIMORDIALS = stagedRuntimeSource({
  label: 'js-interpreter-primordials',
  entry: JS_INTERPRETER_PRIMORDIALS_ENTRY,
  buildId: JS_INTERPRETER_PRIMORDIALS_BUILD_ID,
  sha256: JS_INTERPRETER_PRIMORDIALS_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
});
const JS_INTERPRETER = stagedRuntimeSource({
  label: 'js-interpreter',
  entry: JS_INTERPRETER_ENTRY,
  buildId: JS_INTERPRETER_BUILD_ID,
  sha256: JS_INTERPRETER_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
});
const JS_INTERPRETER_OPS = stagedRuntimeSource({
  label: 'js-interpreter-ops',
  entry: JS_INTERPRETER_OPS_ENTRY,
  buildId: JS_INTERPRETER_OPS_BUILD_ID,
  sha256: JS_INTERPRETER_OPS_SHA256,
  stagedBy: STAGED_BY,
  requiredBy: REQUIRED_BY,
});

/**
 * The node-compat layer's sources for facet worker codegen. Memoized per
 * isolate; a failed fetch clears the memo so the next exec retries instead of
 * pinning the error.
 */
export const fetchNodeFacetSources: (env: StagedSourceEnv) => Promise<NodeFacetSources> =
  memoizeUntilRejected(async (env: StagedSourceEnv) => {
    const [shims, ledger, residentStore, interpreterPrimordials, interpreter, interpreterOps] = await Promise.all([
      fetchStagedText(env, NODE_SHIMS),
      fetchStagedText(env, VFS_WRITE_LEDGER),
      fetchStagedText(env, RESIDENT_STORE),
      fetchStagedText(env, JS_INTERPRETER_PRIMORDIALS),
      fetchStagedText(env, JS_INTERPRETER),
      fetchStagedText(env, JS_INTERPRETER_OPS),
    ]);
    return { shims, ledger, residentStore, interpreterPrimordials, interpreter, interpreterOps };
  });
