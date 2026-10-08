/**
 * The names the resolver facet (packages/worker/src/npm/resolve-one-facet.ts)
 * finds in its scope, set on globalThis as the pool's preamble declares them
 * in production: every function the resolver preamble
 * (loaders/npm-resolve-preamble.ts) declares, evaluated as the facet module
 * evaluates it, and the RPC-result helper.
 *
 * Import it for its effect, before calling resolveOnePackumentInFacet.
 */

import { NPM_RESOLVE_PREAMBLE } from '../../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { importResolvePreamble } from './npm-resolve-preamble-module.mjs';

/** The facet's names: the preamble's upper-case functions, which it calls by name. */
const names = [...NPM_RESOLVE_PREAMBLE.matchAll(/^function ([A-Z][A-Z_]*)\(/gm)].map((m) => m[1]);
Object.assign(globalThis, { ...(await importResolvePreamble(names)) });
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);
