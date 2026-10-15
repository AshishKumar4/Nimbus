/** REPL entries compiled without the host's interpreter/bootstrap modules. */
import type { FacetBindings } from '@nimbus-sh/core/runtime/facet-host.js';
/**
 * Facet-side, request-shaped: compiled at build time into the
 * pool's fetch entrypoint, so it captures nothing and names no import —
 * __cpythonReplRun is put on globalThis by the preamble, and unlike
 * __cpythonRun it keeps its interpreter between calls. The request body
 * is the step payload the adapter JSON-encodes; the response is the
 * step result. Request transport because it is the pool's only
 * cancellable dispatch: Ctrl-C aborts the request, workerd stops the
 * interpreter at its suspension point.
 */
export declare function pythonReplStepRequestFn(request: Request, facetEnv: FacetBindings): Promise<Response>;
/** What one prompt step hands the facet: the driver and where the prompt starts. */
export interface RubyReplStep {
    userCode: string;
    home: string;
    cwd: string;
    binName: string;
    supervisorPid: number;
}
export interface RubyReplFacetResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
    control?: Record<string, string>;
}
/**
 * Facet-side entry compiled with its dependencies at build time.
 *
 * Calls globalThis.__rubyRun (installed by RUBY_RUNNER_PREAMBLE_TAIL)
 * with the user code wrapped by the driver above, in the caller's working
 * directory, over the caller's filesystem (the pool's SUPERVISOR), as the
 * one-shot runner's entry does.
 */
export declare function rubyReplStepFacetFn(args: RubyReplStep, facetEnv: {
    SUPERVISOR?: unknown;
}): Promise<RubyReplFacetResult>;
//# sourceMappingURL=repl-facet-tasks.d.ts.map