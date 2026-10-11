import { type FacetTaskSource } from "@nimbus-sh/core/runtime/facet-task.js";
export declare const NPM_INSTALL_BATCH_TASK: FacetTaskSource<Parameters<typeof import("../npm/install-batch-facet.js").installPackagesInFacet>[0], Awaited<ReturnType<typeof import("../npm/install-batch-facet.js").installPackagesInFacet>>>;
export declare const NPM_RESOLVE_ONE_TASK: FacetTaskSource<Parameters<typeof import("../npm/resolve-one-facet.js").resolveOnePackumentInFacet>[0], Awaited<ReturnType<typeof import("../npm/resolve-one-facet.js").resolveOnePackumentInFacet>>>;
export declare const PYTHON_REPL_TASK: FacetTaskSource<Parameters<typeof import("../runtime/python-repl.js").pythonReplStepRequestFn>[0], Awaited<ReturnType<typeof import("../runtime/python-repl.js").pythonReplStepRequestFn>>>;
export declare const RUBY_REPL_TASK: FacetTaskSource<Parameters<typeof import("../runtime/ruby-repl.js").rubyReplStepFacetFn>[0], Awaited<ReturnType<typeof import("../runtime/ruby-repl.js").rubyReplStepFacetFn>>>;
export declare const FANOUT_BENCH_TASK: FacetTaskSource<Parameters<typeof import("./bench-tasks.js").fanoutBenchTask>[0], Awaited<ReturnType<typeof import("./bench-tasks.js").fanoutBenchTask>>>;
export declare const SERIAL_BENCH_TASK: FacetTaskSource<Parameters<typeof import("./bench-tasks.js").serialBenchTask>[0], Awaited<ReturnType<typeof import("./bench-tasks.js").serialBenchTask>>>;
export declare const NPM_INSTALL_HELPERS_SOURCE: string;
export declare const NPM_ABI_POLICY_SOURCE: string;
export declare const RESIDENCY_MISS_REPORT_SOURCE: string;
//# sourceMappingURL=compiled-bodies.generated.d.ts.map