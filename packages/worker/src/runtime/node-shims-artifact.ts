import * as pins from '../node-shims-artifact.generated.js';
import { immutableModuleSource, memoizeUntilRejected, stagedRuntimeSource, type StagedSourceEnv } from './staged-source.js';
import { ImmutableModuleSource, moduleSource } from '@nimbus-sh/platform/module-source.js';
import {
  COMMONJS_CELL_IMPORTS, RUNTIME_INTERPRETER_PRIMORDIALS_MODULE,
  RUNTIME_INTERPRETER_MODULE, RUNTIME_INTERPRETER_OPS_MODULE, RUNTIME_PARSER_MODULE,
  RUNTIME_NODE_LIB_MODULE, RUNTIME_NODE_LIB_REST_MODULE, RUNTIME_NODE_DNS_MODULE, RUNTIME_NODE_CP_MODULE, RUNTIME_ESM_LATE_MODULE,
} from '@nimbus-sh/core/_shared/commonjs-cell.js';

interface NodeSourceTexts {
  shims: string;
  residentStore: string;
  registry: string;
  interpreterPrimordials: string;
  interpreter: string;
  interpreterOps: string;
  parser: string;
  nodeLib: string;
  nodeLibRest: string;
  nodeDns: string;
  nodeCp: string;
  esmLate: string;
}

/** Generators accept inline test sources and digest-verified deployed sources through the same path. */
export interface NodeFacetSources extends NodeSourceTexts {
  immutable: Partial<Record<keyof NodeSourceTexts, ImmutableModuleSource>>;
}

export function nodeFacetSource(sources: NodeFacetSources, name: keyof NodeSourceTexts): string | ImmutableModuleSource {
  return sources.immutable[name] ?? sources[name];
}

/** The registry bootstrap and its modules, for every runner that hosts node shims. */
export function createNodeFacetRuntime(sources: NodeFacetSources, {
  codeCells = '[]', runtimeCode = '[]', stackEntry = 'null', esm = 'null',
}: { codeCells?: string; runtimeCode?: string; stackEntry?: string; esm?: string } = {}) {
  const modules: Record<string, string> = {};
  const immutableModules: Record<string, ImmutableModuleSource> = {};
  for (const [name, key] of [
    [RUNTIME_INTERPRETER_PRIMORDIALS_MODULE, 'interpreterPrimordials'],
    [RUNTIME_INTERPRETER_MODULE, 'interpreter'],
    [RUNTIME_INTERPRETER_OPS_MODULE, 'interpreterOps'],
    [RUNTIME_PARSER_MODULE, 'parser'],
    [RUNTIME_NODE_LIB_MODULE, 'nodeLib'],
    [RUNTIME_NODE_LIB_REST_MODULE, 'nodeLibRest'],
    [RUNTIME_NODE_DNS_MODULE, 'nodeDns'],
    [RUNTIME_NODE_CP_MODULE, 'nodeCp'],
    [RUNTIME_ESM_LATE_MODULE, 'esmLate'],
  ] as const) {
    const source = nodeFacetSource(sources, key);
    if (typeof source === 'string') modules[name] = source;
    else immutableModules[name] = source;
  }
  return {
    imports: COMMONJS_CELL_IMPORTS,
    // The resident store's library (vfs/resident), evaluated once at module
    // scope: it defines __nimbusResidentModule, whose createResidentStore each
    // process calls for its own store, and processFilesystem its filesystem.
    code: moduleSource`const __NIMBUS_CODE_CELLS = ${codeCells};
const __NIMBUS_RUNTIME_CODE = ${runtimeCode};
const __NIMBUS_STACK_ENTRY = ${stackEntry};
const __NIMBUS_ESM = ${esm};
${nodeFacetSource(sources, 'registry')}
${nodeFacetSource(sources, 'residentStore')}`,
    modules,
    immutableModules,
  };
}

const generatedPins = new Map(Object.entries(pins));
function asset(name: string) {
  const entry = generatedPins.get(name + '_ENTRY');
  const sha256 = generatedPins.get(name + '_SHA256');
  const buildId = generatedPins.get(name + '_BUILD_ID');
  if (!entry || !sha256 || !buildId) throw new Error('The runtime asset build did not pin ' + name);
  return stagedRuntimeSource({ label: name.toLowerCase().replaceAll('_', '-'), entry, sha256, buildId, stagedBy: 'scripts/bundle-node-shims.mjs', requiredBy: 'the node runtime' });
}

/** One shared copy per isolate; the loader reads the same verified sources by their pins. */
export const fetchNodeFacetSources: (env: StagedSourceEnv) => Promise<NodeFacetSources> = memoizeUntilRejected(async (env: StagedSourceEnv) => {
  const load = (name: string) => immutableModuleSource(env, asset(name));
  const [shims, residentStore, registry, interpreterPrimordials, interpreter, interpreterOps, parser, nodeLib, nodeLibRest, nodeDns, nodeCp, esmLate] = await Promise.all([
    load('NODE_SHIMS'), load('RESIDENT_STORE'), load('NODE_REGISTRY'),
    load('JS_INTERPRETER_PRIMORDIALS'), load('JS_INTERPRETER'), load('JS_INTERPRETER_OPS'), load('JS_PARSER'), load('NODE_LIB'), load('NODE_LIB_REST'), load('NODE_DNS'), load('NODE_CP'),
    load('ESM_LATE'),
  ]);
  return {
    shims: shims.text, residentStore: residentStore.text, registry: registry.text,
    interpreterPrimordials: interpreterPrimordials.text, interpreter: interpreter.text,
    interpreterOps: interpreterOps.text, parser: parser.text, nodeLib: nodeLib.text, nodeLibRest: nodeLibRest.text, nodeDns: nodeDns.text, nodeCp: nodeCp.text,
    esmLate: esmLate.text,
    immutable: { shims, residentStore, registry, interpreterPrimordials, interpreter, interpreterOps, parser, nodeLib, nodeLibRest, nodeDns, nodeCp, esmLate },
  };
});
