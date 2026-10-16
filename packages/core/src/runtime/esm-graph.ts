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
export class CyclicModuleRecord {
  status: ModuleStatus = 'unlinked';
  /** [[EvaluationError]]: ~empty~ (null), or the throw completion of its evaluation. */
  evaluationError: { readonly value: unknown } | null = null;
  /** [[DFSAncestorIndex]], set while it is linked or evaluated. */
  dfsAncestorIndex = 0;
  /** [[CycleRoot]]: the root of its strongly connected component, once evaluated. */
  cycleRoot: CyclicModuleRecord | null = null;
  /** [[AsyncEvaluationOrder]]: ~unset~, an integer, or ~done~. */
  asyncEvaluationOrder: number | 'unset' | 'done' = 'unset';
  /** [[TopLevelCapability]]: ~empty~ (null), or the capability Evaluate() made for its cycle root. */
  topLevelCapability: PromiseCapability | null = null;
  /** [[AsyncParentModules]]. */
  readonly asyncParentModules: CyclicModuleRecord[] = [];
  /** [[PendingAsyncDependencies]]. */
  pendingAsyncDependencies = 0;

  constructor(readonly host: CyclicModuleHost) {}
}

/** A Module Record that is not a Cyclic Module Record. */
export class OtherModuleRecord {
  constructor(readonly host: ModuleHost) {}
}

export type ModuleRecord = CyclicModuleRecord | OtherModuleRecord;

// %Promise% as it was when this module loaded: a program may replace the global.
const PromiseConstructor = Promise;

/** NewPromiseCapability(%Promise%). */
function newPromiseCapability(): PromiseCapability {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new PromiseConstructor<void>((onResolve, onReject) => {
    resolve = () => onResolve();
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** The agent's [[ModuleAsyncEvaluationCount]]. */
let moduleAsyncEvaluationCount = 0;

/** IncrementModuleAsyncEvaluationCount(). */
function incrementModuleAsyncEvaluationCount(): number {
  return moduleAsyncEvaluationCount++;
}

/** Link(): either ~unused~ or what InnerModuleLinking threw, every module it began linking back to ~unlinked~. */
export function link(module: CyclicModuleRecord): void {
  // 1. Assert: module.[[Status]] is one of ~unlinked~, ~linked~, ~evaluating-async~, or ~evaluated~.
  // 2. Let stack be a new empty List.
  const stack: CyclicModuleRecord[] = [];
  // 3. Let result be Completion(InnerModuleLinking(module, stack, 0)).
  try {
    innerModuleLinking(module, stack, 0);
  } catch (error) {
    // 4. If result is an abrupt completion, then
    //   a. For each Cyclic Module Record requiredModule of stack, set requiredModule.[[Status]] to ~unlinked~.
    for (const requiredModule of stack) requiredModule.status = 'unlinked';
    //   c. Return ? result.
    throw error;
  }
  // 5. Assert: module.[[Status]] is one of ~linked~, ~evaluating-async~, or ~evaluated~. 6. Assert: stack is empty.
}

/** InnerModuleLinking(module, stack, index). */
function innerModuleLinking(module: ModuleRecord, stack: CyclicModuleRecord[], index: number): number {
  // 1. If module is not a Cyclic Module Record, then perform ? module.Link() and return index.
  if (module instanceof OtherModuleRecord) {
    module.host.link();
    return index;
  }
  // 2. If module.[[Status]] is one of ~linking~, ~linked~, ~evaluating-async~, or ~evaluated~, return index.
  if (module.status !== 'unlinked') return index;
  // 3. Assert: module.[[Status]] is ~unlinked~. 4. Set module.[[Status]] to ~linking~.
  module.status = 'linking';
  // 5. Let moduleIndex be index. 6. Set module.[[DFSAncestorIndex]] to index. 7. Set index to index + 1.
  const moduleIndex = index;
  module.dfsAncestorIndex = index;
  index++;
  // 8. Append module to stack.
  stack.push(module);
  // 9. For each ModuleRequest Record request of module.[[RequestedModules]], do
  for (const requiredModule of module.host.requestedModules()) {
    //   a. Let requiredModule be GetImportedModule(module, request).
    //   b. Set index to ? InnerModuleLinking(requiredModule, stack, index).
    index = innerModuleLinking(requiredModule, stack, index);
    //   c. If requiredModule is a Cyclic Module Record, then
    //     iii. If requiredModule.[[Status]] is ~linking~, then
    //       1. Set module.[[DFSAncestorIndex]] to min(module.[[DFSAncestorIndex]], requiredModule.[[DFSAncestorIndex]]).
    if (requiredModule instanceof CyclicModuleRecord && requiredModule.status === 'linking') {
      module.dfsAncestorIndex = Math.min(module.dfsAncestorIndex, requiredModule.dfsAncestorIndex);
    }
  }
  // 10. Perform ? module.InitializeEnvironment().
  module.host.initializeEnvironment();
  // 13. If module.[[DFSAncestorIndex]] = moduleIndex, then
  if (module.dfsAncestorIndex === moduleIndex) {
    //   a. Let done be false. b. Repeat, while done is false,
    let done = false;
    while (!done) {
      //   i. Let requiredModule be the last element of stack. ii. Remove the last element of stack.
      //   (module is on stack, step 11's assertion: it is reached before stack is empty.)
      const requiredModule = stack.pop();
      if (requiredModule === undefined) break;
      //   iv. Set requiredModule.[[Status]] to ~linked~.
      requiredModule.status = 'linked';
      //   v. If requiredModule and module are the same Module Record, set done to true.
      if (requiredModule === module) done = true;
    }
  }
  // 14. Return index.
  return index;
}

/**
 * Evaluate(): the promise of the module's evaluation, its cycle root's, the
 * same one every call on a module of the component gets.
 */
export function evaluate(start: CyclicModuleRecord): Promise<void> {
  let module = start;
  // 2. Assert: module.[[Status]] is one of ~linked~, ~evaluating-async~, or ~evaluated~.
  // 3. If module.[[Status]] is either ~evaluating-async~ or ~evaluated~, then
  if (module.status === 'evaluating-async' || module.status === 'evaluated') {
    //   a. If module.[[CycleRoot]] is not ~empty~, set module to module.[[CycleRoot]].
    //   b. Else, assert: module.[[Status]] is ~evaluated~ and module.[[EvaluationError]] is a throw completion.
    if (module.cycleRoot !== null) module = module.cycleRoot;
  }
  // 4. If module.[[TopLevelCapability]] is not ~empty~, return module.[[TopLevelCapability]].[[Promise]].
  if (module.topLevelCapability !== null) return module.topLevelCapability.promise;
  // 5. Let stack be a new empty List.
  const stack: CyclicModuleRecord[] = [];
  // 6. Let promiseCapability be ! NewPromiseCapability(%Promise%). 7. Set module.[[TopLevelCapability]] to promiseCapability.
  const promiseCapability = newPromiseCapability();
  module.topLevelCapability = promiseCapability;
  // 8. Let result be Completion(InnerModuleEvaluation(module, stack, 0)).
  try {
    innerModuleEvaluation(module, stack, 0);
  } catch (error) {
    // 9. If result is an abrupt completion, then
    //   a. For each Cyclic Module Record requiredModule of stack, do
    for (const requiredModule of stack) {
      //   ii. Set requiredModule.[[Status]] to ~evaluated~. iii. Set requiredModule.[[EvaluationError]] to result.
      requiredModule.status = 'evaluated';
      requiredModule.evaluationError = { value: error };
    }
    //   d. Perform ! Call(promiseCapability.[[Reject]], undefined, « result.[[Value]] »).
    promiseCapability.reject(error);
    return promiseCapability.promise;
  }
  // 10. Else,
  //   c. If module.[[Status]] is ~evaluated~, then perform ! Call(promiseCapability.[[Resolve]], undefined, « undefined »).
  if (module.status === 'evaluated') promiseCapability.resolve();
  // 11. Return promiseCapability.[[Promise]].
  return promiseCapability.promise;
}

/** InnerModuleEvaluation(module, stack, index). */
function innerModuleEvaluation(module: ModuleRecord, stack: CyclicModuleRecord[], index: number): number {
  // 1. If module is not a Cyclic Module Record, then perform ? EvaluateModuleSync(module) and return index.
  if (module instanceof OtherModuleRecord) {
    module.host.evaluateSync();
    return index;
  }
  // 2. If module.[[Status]] is either ~evaluating-async~ or ~evaluated~, then
  if (module.status === 'evaluating-async' || module.status === 'evaluated') {
    //   a. If module.[[EvaluationError]] is ~empty~, return index. b. Return ? module.[[EvaluationError]].
    if (module.evaluationError === null) return index;
    throw module.evaluationError.value;
  }
  // 3. If module.[[Status]] is ~evaluating~, return index.
  if (module.status === 'evaluating') return index;
  // 4. Assert: module.[[Status]] is ~linked~. 5. Set module.[[Status]] to ~evaluating~.
  module.status = 'evaluating';
  // 6. Let moduleIndex be index. 7. Set module.[[DFSAncestorIndex]] to index.
  const moduleIndex = index;
  module.dfsAncestorIndex = index;
  // 8. Set module.[[PendingAsyncDependencies]] to 0. 9. Set index to index + 1.
  module.pendingAsyncDependencies = 0;
  index++;
  // 10. Append module to stack.
  stack.push(module);
  // 11. For each ModuleRequest Record request of module.[[RequestedModules]], do
  for (const imported of module.host.requestedModules()) {
    //   a. Let requiredModule be GetImportedModule(module, request).
    let requiredModule = imported;
    //   b. Set index to ? InnerModuleEvaluation(requiredModule, stack, index).
    index = innerModuleEvaluation(requiredModule, stack, index);
    //   c. If requiredModule is a Cyclic Module Record, then
    if (requiredModule instanceof CyclicModuleRecord) {
      //   iii. If requiredModule.[[Status]] is ~evaluating~, then
      if (requiredModule.status === 'evaluating') {
        //   1. Set module.[[DFSAncestorIndex]] to min(module.[[DFSAncestorIndex]], requiredModule.[[DFSAncestorIndex]]).
        module.dfsAncestorIndex = Math.min(module.dfsAncestorIndex, requiredModule.dfsAncestorIndex);
      } else {
        //   iv. Else,
        //   1. Set requiredModule to requiredModule.[[CycleRoot]]. (An evaluated module has one: step 16.b.viii set it.)
        requiredModule = requiredModule.cycleRoot ?? requiredModule;
        //   3. If requiredModule.[[EvaluationError]] is not ~empty~, return ? requiredModule.[[EvaluationError]].
        if (requiredModule.evaluationError !== null) throw requiredModule.evaluationError.value;
      }
      //   v. If requiredModule.[[AsyncEvaluationOrder]] is an integer, then
      if (typeof requiredModule.asyncEvaluationOrder === 'number') {
        //   1. Set module.[[PendingAsyncDependencies]] to module.[[PendingAsyncDependencies]] + 1.
        module.pendingAsyncDependencies++;
        //   2. Append module to requiredModule.[[AsyncParentModules]].
        requiredModule.asyncParentModules.push(module);
      }
    }
  }
  // 12. If module.[[HasTLA]] is true or module.[[PendingAsyncDependencies]] > 0, then
  if (module.host.hasTLA || module.pendingAsyncDependencies > 0) {
    //   a. Assert: module.[[AsyncEvaluationOrder]] is ~unset~.
    //   b. Set module.[[AsyncEvaluationOrder]] to IncrementModuleAsyncEvaluationCount().
    module.asyncEvaluationOrder = incrementModuleAsyncEvaluationCount();
    //   c. If module.[[PendingAsyncDependencies]] = 0, perform ExecuteAsyncModule(module).
    if (module.pendingAsyncDependencies === 0) executeAsyncModule(module);
  } else {
    // 13. Else, perform ? module.ExecuteModule().
    module.host.executeModule();
  }
  // 16. If module.[[DFSAncestorIndex]] = moduleIndex, then
  if (module.dfsAncestorIndex === moduleIndex) {
    //   a. Let done be false. b. Repeat, while done is false,
    let done = false;
    while (!done) {
      //   i. Let requiredModule be the last element of stack. ii. Remove the last element of stack.
      //   (module is on stack, step 14's assertion: it is reached before stack is empty.)
      const requiredModule = stack.pop();
      if (requiredModule === undefined) break;
      //   v. If requiredModule.[[AsyncEvaluationOrder]] is ~unset~, set requiredModule.[[Status]] to ~evaluated~.
      //   vi. Else, set requiredModule.[[Status]] to ~evaluating-async~.
      requiredModule.status = requiredModule.asyncEvaluationOrder === 'unset' ? 'evaluated' : 'evaluating-async';
      //   vii. If requiredModule and module are the same Module Record, set done to true.
      if (requiredModule === module) done = true;
      //   viii. Set requiredModule.[[CycleRoot]] to module.
      requiredModule.cycleRoot = module;
    }
  }
  // 17. Return index.
  return index;
}

/** ExecuteAsyncModule(module). */
function executeAsyncModule(module: CyclicModuleRecord): void {
  // 1. Assert: module.[[Status]] is either ~evaluating~ or ~evaluating-async~. 2. Assert: module.[[HasTLA]] is true.
  // 3. Let promiseCapability be ! NewPromiseCapability(%Promise%).
  const promiseCapability = newPromiseCapability();
  // 4-8. Perform PerformPromiseThen(promiseCapability.[[Promise]], onFulfilled, onRejected), whose closures
  //      perform AsyncModuleExecutionFulfilled(module) and AsyncModuleExecutionRejected(module, error).
  promiseCapability.promise.then(() => asyncModuleExecutionFulfilled(module), (error: unknown) => asyncModuleExecutionRejected(module, error));
  // 9. Perform ! module.ExecuteModule(promiseCapability).
  module.host.executeModule(promiseCapability);
}

/** GatherAvailableAncestors(module, execList). */
function gatherAvailableAncestors(module: CyclicModuleRecord, execList: CyclicModuleRecord[]): void {
  // 1. For each Cyclic Module Record ancestorModule of module.[[AsyncParentModules]], do
  for (const ancestorModule of module.asyncParentModules) {
    //   a. If execList does not contain ancestorModule and ancestorModule.[[CycleRoot]].[[EvaluationError]] is ~empty~, then
    if (!execList.includes(ancestorModule) && (ancestorModule.cycleRoot ?? ancestorModule).evaluationError === null) {
      //   v. Set ancestorModule.[[PendingAsyncDependencies]] to ancestorModule.[[PendingAsyncDependencies]] - 1.
      ancestorModule.pendingAsyncDependencies--;
      //   vi. If ancestorModule.[[PendingAsyncDependencies]] = 0, then
      if (ancestorModule.pendingAsyncDependencies === 0) {
        //   1. Append ancestorModule to execList.
        execList.push(ancestorModule);
        //   2. If ancestorModule.[[HasTLA]] is false, perform GatherAvailableAncestors(ancestorModule, execList).
        if (!ancestorModule.host.hasTLA) gatherAvailableAncestors(ancestorModule, execList);
      }
    }
  }
}

/** AsyncModuleExecutionFulfilled(module). */
function asyncModuleExecutionFulfilled(module: CyclicModuleRecord): void {
  // 1. If module.[[Status]] is ~evaluated~, then assert module.[[EvaluationError]] is not ~empty~ and return.
  if (module.status === 'evaluated') return;
  // 5. Set module.[[AsyncEvaluationOrder]] to ~done~. 6. Set module.[[Status]] to ~evaluated~.
  module.asyncEvaluationOrder = 'done';
  module.status = 'evaluated';
  // 7. If module.[[TopLevelCapability]] is not ~empty~, then perform ! Call(module.[[TopLevelCapability]].[[Resolve]], undefined, « undefined »).
  module.topLevelCapability?.resolve();
  // 8. Let execList be a new empty List. 9. Perform GatherAvailableAncestors(module, execList).
  const execList: CyclicModuleRecord[] = [];
  gatherAvailableAncestors(module, execList);
  // 11. Let sortedExecList be execList sorted by [[AsyncEvaluationOrder]] in ascending order.
  const sortedExecList = [...execList].sort((a, b) => order(a) - order(b));
  // 12. For each Cyclic Module Record ancestorModule of sortedExecList, do
  for (const ancestorModule of sortedExecList) {
    //   a. If ancestorModule.[[Status]] is ~evaluated~, then assert ancestorModule.[[EvaluationError]] is not ~empty~.
    if (ancestorModule.status === 'evaluated') continue;
    //   b. Else if ancestorModule.[[HasTLA]] is true, then perform ExecuteAsyncModule(ancestorModule).
    if (ancestorModule.host.hasTLA) {
      executeAsyncModule(ancestorModule);
      continue;
    }
    //   c. Else,
    //     i. Let result be Completion(ancestorModule.ExecuteModule()).
    try {
      ancestorModule.host.executeModule();
    } catch (error) {
      //     ii. If result is an abrupt completion, then perform AsyncModuleExecutionRejected(ancestorModule, result.[[Value]]).
      asyncModuleExecutionRejected(ancestorModule, error);
      continue;
    }
    //     iii. Else,
    //       1. Set ancestorModule.[[AsyncEvaluationOrder]] to ~done~. 2. Set ancestorModule.[[Status]] to ~evaluated~.
    ancestorModule.asyncEvaluationOrder = 'done';
    ancestorModule.status = 'evaluated';
    //       3. If ancestorModule.[[TopLevelCapability]] is not ~empty~, then perform ! Call(...[[Resolve]], undefined, « undefined »).
    ancestorModule.topLevelCapability?.resolve();
  }
}

/** An [[AsyncEvaluationOrder]] that is an integer, as GatherAvailableAncestors asserts each it gathers has. */
function order(module: CyclicModuleRecord): number {
  return typeof module.asyncEvaluationOrder === 'number' ? module.asyncEvaluationOrder : Number.MAX_SAFE_INTEGER;
}

/** AsyncModuleExecutionRejected(module, error). */
function asyncModuleExecutionRejected(module: CyclicModuleRecord, error: unknown): void {
  // 1. If module.[[Status]] is ~evaluated~, then assert module.[[EvaluationError]] is not ~empty~ and return.
  if (module.status === 'evaluated') return;
  // 5. Set module.[[EvaluationError]] to ThrowCompletion(error). 6. Set module.[[Status]] to ~evaluated~.
  module.evaluationError = { value: error };
  module.status = 'evaluated';
  // 7. Set module.[[AsyncEvaluationOrder]] to ~done~.
  module.asyncEvaluationOrder = 'done';
  // 9. If module.[[TopLevelCapability]] is not ~empty~, then perform ! Call(module.[[TopLevelCapability]].[[Reject]], undefined, « error »).
  module.topLevelCapability?.reject(error);
  // 10. For each Cyclic Module Record ancestorModule of module.[[AsyncParentModules]], perform AsyncModuleExecutionRejected(ancestorModule, error).
  for (const ancestorModule of module.asyncParentModules) asyncModuleExecutionRejected(ancestorModule, error);
}
