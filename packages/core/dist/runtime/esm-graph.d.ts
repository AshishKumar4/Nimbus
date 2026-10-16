/**
 * runtime/esm-graph.ts — ECMA-262's link and evaluation of a module graph,
 * step by step: 16.2.1.6 Cyclic Module Records' Link() and InnerModuleLinking,
 * Evaluate() and InnerModuleEvaluation, ExecuteAsyncModule,
 * GatherAvailableAncestors, AsyncModuleExecutionFulfilled and
 * AsyncModuleExecutionRejected (https://tc39.es/ecma262/#sec-cyclic-module-records).
 * Each step's comment is the spec's step it is.
 *
 * The host makes one record per module, of whichever kind (an interpreted
 * module, a data: module, a staged module the engine evaluates, a CommonJS,
 * JSON or builtin module's translation), and gives each its requested
 * modules, InitializeEnvironment and ExecuteModule; this decides the order,
 * cycles (a strongly connected component evaluates as one, through its
 * [[CycleRoot]]) and top-level await ([[AsyncParentModules]],
 * [[PendingAsyncDependencies]]) once, for every kind.
 */
/** A Cyclic Module Record's [[Status]]. */
export type ModuleStatus = 'unlinked' | 'linking' | 'linked' | 'evaluating' | 'evaluating-async' | 'evaluated';
/** A PromiseCapability Record: its [[Promise]], [[Resolve]] and [[Reject]]. */
export interface PromiseCapability {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
}
/** What a Cyclic Module Record is made of by its host. */
export interface CyclicModuleHost {
    /** [[HasTLA]]: whether its body awaits at its top level (its ExecuteModule completes through a capability). */
    readonly hasTLA: boolean;
    /** GetImportedModule for each of its [[RequestedModules]], in order: what each loaded. */
    requestedModules(): readonly ModuleRecord[];
    /** InitializeEnvironment(): its imports bound, its functions made, its exports published; none of its body run. */
    initializeEnvironment(): void;
    /** ExecuteModule([capability]): its body; with [[HasTLA]], completing through `capability`, else synchronously. */
    executeModule(capability?: PromiseCapability): void;
}
/** What a Module Record that is not a Cyclic Module Record is made of: its Link() and, through EvaluateModuleSync, its Evaluate(). */
export interface ModuleHost {
    link(): void;
    /** Its evaluation, completed synchronously (EvaluateModuleSync asserts its promise is settled): throws what it throws. */
    evaluateSync(): void;
}
/** A Cyclic Module Record, its fields as Table 45 names them. */
export declare class CyclicModuleRecord {
    readonly host: CyclicModuleHost;
    status: ModuleStatus;
    /** [[EvaluationError]]: ~empty~ (null), or the throw completion of its evaluation. */
    evaluationError: {
        readonly value: unknown;
    } | null;
    /** [[DFSAncestorIndex]], set while it is linked or evaluated. */
    dfsAncestorIndex: number;
    /** [[CycleRoot]]: the root of its strongly connected component, once evaluated. */
    cycleRoot: CyclicModuleRecord | null;
    /** [[AsyncEvaluationOrder]]: ~unset~, an integer, or ~done~. */
    asyncEvaluationOrder: number | 'unset' | 'done';
    /** [[TopLevelCapability]]: ~empty~ (null), or the capability Evaluate() made for its cycle root. */
    topLevelCapability: PromiseCapability | null;
    /** [[AsyncParentModules]]. */
    readonly asyncParentModules: CyclicModuleRecord[];
    /** [[PendingAsyncDependencies]]. */
    pendingAsyncDependencies: number;
    constructor(host: CyclicModuleHost);
}
/** A Module Record that is not a Cyclic Module Record. */
export declare class OtherModuleRecord {
    readonly host: ModuleHost;
    constructor(host: ModuleHost);
}
export type ModuleRecord = CyclicModuleRecord | OtherModuleRecord;
/** Link(): either ~unused~ or what InnerModuleLinking threw, every module it began linking back to ~unlinked~. */
export declare function link(module: CyclicModuleRecord): void;
/**
 * Evaluate(): the promise of the module's evaluation, its cycle root's, the
 * same one every call on a module of the component gets.
 */
export declare function evaluate(start: CyclicModuleRecord): Promise<void>;
//# sourceMappingURL=esm-graph.d.ts.map