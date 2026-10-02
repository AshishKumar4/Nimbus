/**
 * The build facet's runtime: rolldown's JavaScript API over the staged
 * threadless rolldown binding, and core's esbuild-contract adapter
 * (runtime/rolldown-build.ts). scripts/bundle-facet-workers.mjs bundles this
 * file, with shims.mjs standing in for the Node modules a facet does not
 * have, into a module of the build facet's module map; the facet's body
 * installs the binding at `globalThis.__nimbusRolldownBinding` before it
 * imports this module.
 */
import { rolldown } from 'rolldown';
import { buildWithRolldown } from '../../../core/src/runtime/rolldown-build.ts';

export function build(options, plugin) {
  return buildWithRolldown({ rolldown }, options, plugin);
}
