/**
 * The text of the node launch map's module of Node's library
 * (RUNTIME_NODE_LIB_MODULE, core _shared/commonjs-cell.ts): Node's own
 * modules (node-lib-source.ts), the host they run over (node-lib-host.ts),
 * and the data they read. A `{ cjs }` module the shims require the first time
 * a program needs Node's library (node-shims.ts __nimbusNodeLib), so a launch
 * that never formats a value or requires util, assert, querystring or
 * punycode never compiles it. Staged as an asset beside the shims
 * (scripts/bundle-node-shims.mjs).
 */

import { NODE_LIB_HOST_SOURCE, WORKERD_SLOTS_SOURCE } from './node-lib-host.js';
import { EAST_ASIAN_WIDE_RANGES, NODE_BUILTIN_OBJECTS, NODE_LIB_SOURCES, NODE_PRIMORDIALS_SOURCE, NODE_UV_ERRORS } from './node-lib-source.js';

export function generateNodeLibModule(): string {
  const sources = Object.entries(NODE_LIB_SOURCES)
    .map(([id, text]) => `    ${JSON.stringify(id)}: function (exports, require, module, process, internalBinding, primordials) {\n${text}\n    },`)
    .join('\n');
  return `module.exports = {
  createNodeLib: ${NODE_LIB_HOST_SOURCE},
  createWorkerdSlots: ${WORKERD_SLOTS_SOURCE},
  primordialsOf: function (primordials, globalThis) {
${NODE_PRIMORDIALS_SOURCE}
  },
  // The East Asian Wide and Fullwidth ranges: \`first[-last]\` in hex, comma-separated, ascending.
  eastAsianWideRanges: ${JSON.stringify(EAST_ASIAN_WIDE_RANGES)},
  builtinObjects: ${JSON.stringify(NODE_BUILTIN_OBJECTS)},
  uvErrors: ${JSON.stringify(NODE_UV_ERRORS)},
  sources: {
${sources}
  },
};
`;
}
