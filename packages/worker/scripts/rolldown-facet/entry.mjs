/**
 * The build facet's runtime: rolldown's JavaScript API over the staged
 * threadless rolldown binding, core's esbuild-contract adapter
 * (runtime/rolldown-build.ts), and the pre-bundle of one npm specifier from
 * its slice (runtime/prebundle-slice.ts). scripts/bundle-facet-workers.mjs bundles this
 * file, with shims.mjs standing in for the Node modules a facet does not
 * have, into a module of the build facet's module map; the facet's body
 * installs the binding at `globalThis.__nimbusRolldownBinding` before it
 * imports this module.
 */
import { rolldown } from 'rolldown';
import { parseSync, transformSync } from 'rolldown/experimental';
import { buildWithRolldown } from '../../../core/src/runtime/rolldown-build.ts';
import { prebundleSlice } from '../../../core/src/runtime/prebundle-slice.ts';

export function build(options, plugin) {
  return buildWithRolldown({ rolldown, transformSync, parseSync }, options, plugin);
}

export function prebundle(spec) {
  return prebundleSlice(spec, build);
}
