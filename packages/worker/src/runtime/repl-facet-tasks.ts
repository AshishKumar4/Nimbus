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
export async function pythonReplStepRequestFn(request: Request, facetEnv: FacetBindings): Promise<Response> {
    const args = await request.json();
    if (typeof args !== 'object' || args === null || !('userCode' in args) || typeof args.userCode !== 'string') {
        throw new Error('Python REPL request must contain userCode');
    }
    const run = Reflect.get(globalThis, '__cpythonReplRun');
    if (typeof run !== 'function') {
        return Response.json({
            stdout: '', stderr: '', exitCode: 127,
            error: 'cpython preamble missing: __cpythonReplRun not in scope',
        });
    }
    const adopt = Reflect.get(globalThis, '__wasiAdoptSupervisor');
    const supervisor = facetEnv && facetEnv.SUPERVISOR;
    // Published where the boot re-adopts it after the mount, because
    // __wasiInitFS clears the adoption on purpose. Omitting this here — while
    // cpython-runner's entry had it — is what made the prompt start with no
    // filesystem it could read.
    if (supervisor)
        Reflect.set(globalThis, '__nimbusPySupervisor', supervisor);
    if (typeof adopt === 'function')
        Reflect.apply(adopt, undefined, [supervisor ?? null]);
    return Response.json(await run(args));
}
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
export function rubyReplStepFacetFn(args: RubyReplStep, facetEnv: {
    SUPERVISOR?: unknown;
}): Promise<RubyReplFacetResult> {
    const g: any = globalThis as any;
    return (async function () {
        const fn = g.__rubyRun;
        if (typeof fn !== 'function') {
            return {
                stdout: '', stderr: '', exitCode: 127,
                error: 'ruby-repl preamble missing: __rubyRun not in scope',
            };
        }
        const adopt = g.__wasiAdoptSupervisor as ((s: unknown) => void) | undefined;
        const supervisor = facetEnv && facetEnv.SUPERVISOR;
        // Published where __rubyRun re-adopts it after the mount; adopting only
        // here would be undone by __wasiInitFS.
        if (supervisor)
            Reflect.set(globalThis, '__nimbusRubySupervisor', supervisor);
        adopt?.(supervisor);
        // The prompt starts in the shell's cwd once per VM; a later line keeps
        // whatever directory the program's own Dir.chdir left.
        const started = Reflect.get(globalThis, '__nimbusRubyPromptStarted') === true;
        Reflect.set(globalThis, '__nimbusRubyPromptStarted', true);
        const r = await fn({
            userCode: args.userCode,
            rbArgv: ['ruby', '-e', args.userCode],
            userEnv: { HOME: args.home },
            progName: 'ruby',
            binName: args.binName,
            cwd: started ? undefined : args.cwd,
            supervisorPid: args.supervisorPid,
            outputControls: [{ key: 'incomplete', prefix: '__NIMBUS_INCOMPLETE__' }],
        });
        return {
            stdout: r.stdout || '',
            stderr: r.stderr || '',
            exitCode: typeof r.exitCode === 'number' ? r.exitCode : 0,
            error: r.error,
            control: r.control,
        };
    })();
}
