import { type FacetTaskSource } from "./facet-task.js";
export declare const CPYTHON_RUN_TASK: FacetTaskSource<Parameters<typeof import("./cpython-runner.js").cpythonRunFacetFn>[0], Awaited<ReturnType<typeof import("./cpython-runner.js").cpythonRunFacetFn>>>;
export declare const WASM_CALL_TASK: FacetTaskSource<Parameters<typeof import("./wasm-runner.js").wasmFacetCall>[0], Awaited<ReturnType<typeof import("./wasm-runner.js").wasmFacetCall>>>;
export declare const CLANG_CALL_TASK: FacetTaskSource<Parameters<typeof import("./clang-runner.js").clangFacetCall>[0], Awaited<ReturnType<typeof import("./clang-runner.js").clangFacetCall>>>;
export declare const RUBY_CALL_TASK: FacetTaskSource<Parameters<typeof import("./ruby-runner.js").rubyFacetCall>[0], Awaited<ReturnType<typeof import("./ruby-runner.js").rubyFacetCall>>>;
export declare const BASH_STEP_TASK: FacetTaskSource<Parameters<typeof import("./bash-runner.js").bashFacetStep>[0], Awaited<ReturnType<typeof import("./bash-runner.js").bashFacetStep>>>;
export declare const BASH_REQUEST_TASK: FacetTaskSource<Parameters<typeof import("./bash-runner.js").bashRequestStep>[0], Awaited<ReturnType<typeof import("./bash-runner.js").bashRequestStep>>>;
export declare const ESBUILD_FACET_RUNTIME_SOURCE: string;
export declare const TRANSFORM_FACET_RUNTIME_SOURCE: string;
export declare const OPENTUI_BACKEND_CLASS_SOURCE: string;
//# sourceMappingURL=compiled-bodies.generated.d.ts.map