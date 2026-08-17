/**
 * The workerd {@link FacetHost}: a facet is a dynamic worker.
 *
 * The whole adapter is the option renames below, because `LoaderPool`
 * already IS the port's shape — `submit` and `dispose`, with the same meanings.
 * The one thing it spells differently is the supervisor capability, which it
 * takes as a pid plus a separate flag saying whether to bind one at all; the
 * port collapses the pair, since a facet with the binding and no pid can read
 * the session and never write to it. `reuse` is the pool's `cacheScope` under
 * the name the port gives it: who a warm facet may answer for.
 */
import type {
  Facet,
  FacetFilesystemOptions,
  FacetFilesystemSeed,
  FacetHost,
  FacetSpec,
} from '@nimbus-sh/core/runtime/facet-host.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { manifestVfs } from '@nimbus-sh/core/runtime/vfs-manifest.js';
import type { FacetManager } from '../facets/manager.js';
import { LoaderPool } from '@nimbus-sh/fabric/loader-pool.js';

export function loaderFacetHost(env: unknown, ctx: DurableObjectState): FacetHost {
  return {
    // workerd suspends a guest through JSPI, which is what lets a syscall reach
    // back to the session mid-instruction.
    parking: 'jspi',
    /**
     * A manifest, not a copy: sizes and modes, with the facet demand-loading
     * whatever the program opens through its supervisor. It has to be — the
     * whole seed crosses one RPC, and a session filesystem does not fit in one.
     */
    seedFilesystem(
      vfs: CredentialedVfs,
      root: string,
      options?: FacetFilesystemOptions,
    ): FacetFilesystemSeed | { error: string } {
      return manifestVfs(vfs, root, options);
    },
    open(spec: FacetSpec): Facet {
      return new LoaderPool(env, ctx, {
        tag: spec.tag,
        concurrency: spec.concurrency,
        preamble: spec.preamble,
        wasmModules: spec.wasmModules,
        omitSupervisor: spec.syscalls === undefined,
        supervisorPid: spec.syscalls?.pid,
        cacheScope: spec.reuse,
      });
    },
  };
}

/**
 * The two objects a LoaderPool needs from a FacetManager, via the manager's
 * own `loaderHost()` accessor. The runtime guard stays: harnesses build
 * FacetManagers on mock contexts, and one built on something other than a
 * DurableObjectState should fail with a sentence instead of at the first RPC.
 */
export function getFacetManagerLoaderHost(
  facetMgr: FacetManager,
): { env: unknown; ctx: DurableObjectState } {
  const { env, ctx } = facetMgr.loaderHost();
  if (!isDurableObjectState(ctx)) {
    throw new Error('a loader-backed runtime requires a FacetManager with DurableObjectState context');
  }
  return { env, ctx };
}

/** The facet host a runtime reached through a FacetManager runs on. */
export function facetHostForManager(facetMgr: FacetManager): FacetHost {
  const { env, ctx } = getFacetManagerLoaderHost(facetMgr);
  return loaderFacetHost(env, ctx);
}

function isDurableObjectState(value: unknown): value is DurableObjectState {
  if (typeof value !== 'object' || value === null) return false;
  return 'id' in value && typeof Reflect.get(value, 'waitUntil') === 'function';
}
