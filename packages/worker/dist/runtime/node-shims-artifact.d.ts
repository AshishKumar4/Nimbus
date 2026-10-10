import { type StagedSourceEnv } from './staged-source.js';
import { ImmutableModuleSource } from '@nimbus-sh/platform/module-source.js';
interface NodeSourceTexts {
    shims: string;
    ledger: string;
    residentStore: string;
    registry: string;
    interpreterPrimordials: string;
    interpreter: string;
    interpreterOps: string;
    nodeLib: string;
    nodeDns: string;
}
/** Generators accept inline test sources and digest-verified deployed sources through the same path. */
export interface NodeFacetSources extends NodeSourceTexts {
    immutable: Partial<Record<keyof NodeSourceTexts, ImmutableModuleSource>>;
}
export declare function nodeFacetSource(sources: NodeFacetSources, name: keyof NodeSourceTexts): string | ImmutableModuleSource;
/** The registry bootstrap and its modules, for every runner that hosts node shims. */
export declare function createNodeFacetRuntime(sources: NodeFacetSources, { codeCells, runtimeCode, stackEntry, }?: {
    codeCells?: string;
    runtimeCode?: string;
    stackEntry?: string;
}): {
    imports: string;
    code: import("@nimbus-sh/platform/module-source.js").ModuleSource;
    modules: Record<string, string>;
    immutableModules: Record<string, ImmutableModuleSource>;
};
/** One shared copy per isolate; the loader reads the same verified sources by their pins. */
export declare const fetchNodeFacetSources: (env: StagedSourceEnv) => Promise<NodeFacetSources>;
export {};
//# sourceMappingURL=node-shims-artifact.d.ts.map