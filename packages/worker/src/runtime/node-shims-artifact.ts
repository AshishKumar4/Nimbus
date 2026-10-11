import * as pins from '../node-shims-artifact.generated.js';
import { immutableModuleSource, memoizeUntilRejected, stagedRuntimeSource, type StagedSourceEnv } from './staged-source.js';
import { ImmutableModuleSource, moduleSource } from '@nimbus-sh/platform/module-source.js';
import {
  COMMONJS_CELL_IMPORTS, RUNTIME_INTERPRETER_PRIMORDIALS_MODULE,
  RUNTIME_INTERPRETER_MODULE, RUNTIME_INTERPRETER_OPS_MODULE, RUNTIME_PARSER_MODULE,
  RUNTIME_NODE_LIB_MODULE, RUNTIME_NODE_LIB_REST_MODULE, RUNTIME_NODE_DNS_MODULE, RUNTIME_NODE_ESM_MODULE,
} from '@nimbus-sh/core/_shared/commonjs-cell.js';

interface NodeSourceTexts {
  shims: string;
  ledger: string;
  residentStore: string;
  registry: string;
  interpreterPrimordials: string;
  interpreter: string;
  interpreterOps: string;
  parser: string;
  nodeLib: string;
  nodeLibRest: string;
  nodeEsm: string;
  nodeDns: string;
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
    [RUNTIME_NODE_ESM_MODULE, 'nodeEsm'],
    [RUNTIME_NODE_DNS_MODULE, 'nodeDns'],
  ] as const) {
    const source = nodeFacetSource(sources, key);
    if (typeof source === 'string') modules[name] = source;
    else immutableModules[name] = source;
  }
  return {
    imports: COMMONJS_CELL_IMPORTS,
    code: moduleSource`const __NIMBUS_CODE_CELLS = ${codeCells};
const __NIMBUS_RUNTIME_CODE = ${runtimeCode};
const __NIMBUS_STACK_ENTRY = ${stackEntry};
const __NIMBUS_ESM = ${esm};
${nodeFacetSource(sources, 'registry')}`,
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
  const [shims, ledger, residentStore, registry, interpreterPrimordials, interpreter, interpreterOps, parser, nodeLib, nodeLibRest, nodeDns, nodeEsm] = await Promise.all([
    load('NODE_SHIMS'), load('VFS_WRITE_LEDGER'), load('RESIDENT_STORE'), load('NODE_REGISTRY'),
    load('JS_INTERPRETER_PRIMORDIALS'), load('JS_INTERPRETER'), load('JS_INTERPRETER_OPS'), load('JS_PARSER'), load('NODE_LIB'), load('NODE_LIB_REST'), load('NODE_DNS'), load('NODE_ESM'),
  ]);
  return {
    shims: shims.text, ledger: ledger.text, residentStore: residentStore.text, registry: registry.text,
    interpreterPrimordials: interpreterPrimordials.text, interpreter: interpreter.text,
    interpreterOps: interpreterOps.text, parser: parser.text, nodeLib: nodeLib.text, nodeLibRest: nodeLibRest.text, nodeDns: nodeDns.text, nodeEsm: nodeEsm.text,
    immutable: { shims, ledger, residentStore, registry, interpreterPrimordials, interpreter, interpreterOps, parser, nodeLib, nodeLibRest, nodeDns, nodeEsm },
  };
});
