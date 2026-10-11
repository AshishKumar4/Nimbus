/**
 * The text of the node launch map's module of Node's library
 * (RUNTIME_NODE_LIB_MODULE, core _shared/commonjs-cell.ts): Node's own
 * modules (node-lib-source.ts), the host they run over (node-lib-host.ts),
 * and the data they read. A `{ cjs }` module the shims require the first time
 * a program needs Node's library (node-shims.ts __nimbusNodeLib), so a launch
 * that never formats a value or requires util, assert, querystring or
 * punycode never compiles it. Of Node's modules it carries only what
 * formatting a value requires (util.inspect, as an uncaught error's report
 * and console.log of an object do); the others are in
 * RUNTIME_NODE_LIB_REST_MODULE and DNS's in RUNTIME_NODE_DNS_MODULE, each
 * compiled the first time a program requires one of its modules. Staged as
 * assets beside the shims (scripts/bundle-node-shims.mjs).
 */

import { NODE_LIB_HOST_SOURCE, WORKERD_SLOTS_SOURCE } from './node-lib-host.js';
import { NODE_DNS_BINDING_SOURCE } from './node-dns-binding.js';
import { EAST_ASIAN_WIDE_RANGES, NODE_BUILTIN_OBJECTS, NODE_LIB_SOURCES, NODE_PRIMORDIALS_SOURCE, NODE_UV_ERRORS } from './node-lib-source.js';
import { NODE_OPTION_ALIASES, NODE_OPTIONS_TABLE } from '@nimbus-sh/core/runtime/node-cli-options.generated.js';
import { parseJavaScriptProgram } from '@nimbus-sh/core/runtime/javascript-ast.js';
import { programRequests } from '@nimbus-sh/core/interpreter/module-requests.js';

const dnsModule = (id: string) => id === 'dns' || id === 'dns/promises' || id.startsWith('internal/dns/') || id === 'internal/net';
const moduleFactory = (id: string, text: string) => `    ${JSON.stringify(id)}: function (exports, require, module, process, internalBinding, primordials) {\n${text}\n    },`;
const deferredFactory = (module: string, id: string) => `    get ${JSON.stringify(id)}() { return require(${JSON.stringify(module)}).sources[${JSON.stringify(id)}]; },`;

/** `root` and every module of Node's it requires (module-requests.ts programRequests). */
function requireClosure(root: string): Set<string> {
  const closure = new Set<string>();
  const pending = [root];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (closure.has(id) || !(id in NODE_LIB_SOURCES)) continue;
    closure.add(id);
    const program = parseJavaScriptProgram(NODE_LIB_SOURCES[id]);
    if (program === null) throw new Error(`Node's ${id} does not parse`);
    for (const request of programRequests(program)) if (request.kind === 'require') pending.push(request.specifier);
  }
  return closure;
}

/** What formatting a value runs (node-shims.ts __nimbusNodeInspect), carried by RUNTIME_NODE_LIB_MODULE itself. */
const FORMATTING = requireClosure('internal/util/inspect');
const restModule = (id: string) => !dnsModule(id) && !FORMATTING.has(id);

export function generateNodeDnsModule(): string {
  return `module.exports = { createCaresBinding: ${NODE_DNS_BINDING_SOURCE}, sources: {\n`
    + Object.entries(NODE_LIB_SOURCES).filter(([id]) => dnsModule(id)).map(([id, text]) => moduleFactory(id, text)).join('\n')
    + '\n} };';
}

export function generateNodeLibRestModule(): string {
  return 'module.exports = { sources: {\n'
    + Object.entries(NODE_LIB_SOURCES).filter(([id]) => restModule(id)).map(([id, text]) => moduleFactory(id, text)).join('\n')
    + '\n} };';
}

export function generateNodeLibModule(): string {
  const sources = Object.entries(NODE_LIB_SOURCES).map(([id, text]) => dnsModule(id)
    ? deferredFactory('./node-dns.js', id)
    : restModule(id) ? deferredFactory('./node-lib-rest.js', id) : moduleFactory(id, text)).join('\n');
  return `module.exports = {
  createCaresBinding: (...args) => require("./node-dns.js").createCaresBinding(...args),
  createNodeLib: ${NODE_LIB_HOST_SOURCE},
  createWorkerdSlots: ${WORKERD_SLOTS_SOURCE},
  primordialsOf: function (primordials, globalThis) {
${NODE_PRIMORDIALS_SOURCE}
  },
  // The East Asian Wide and Fullwidth ranges: \`first[-last]\` in hex, comma-separated, ascending.
  eastAsianWideRanges: ${JSON.stringify(EAST_ASIAN_WIDE_RANGES)},
  builtinObjects: ${JSON.stringify(NODE_BUILTIN_OBJECTS)},
  uvErrors: ${JSON.stringify(NODE_UV_ERRORS)},
  // node's options and their aliases (core node-cli-options.generated.ts): [name, kind, allowed in NODE_OPTIONS].
  cliOptions: ${JSON.stringify([...NODE_OPTIONS_TABLE].map(([name, { kind, env }]) => [name, kind, env]))},
  cliAliases: ${JSON.stringify([...NODE_OPTION_ALIASES])},
  sources: {
${sources}
  },
};
`;
}
