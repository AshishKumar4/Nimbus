/**
 * Per-spawn task body for Worker Loader isolates.
 *
 * The isolate delegates command execution back to the supervisor through a
 * narrow RPC and returns copied string output. The parent pool owns streaming
 * and process bookkeeping.
 */
/**
 * Signature must remain `(spec, env)` because Worker Loader dispatch calls
 * the task as `fn(item, env)`.
 */
export const runSpawnInIsolate = async function runSpawnInIsolate(spec, env) {
    if (!spec || !spec.req) {
        return { exitCode: 1, stdout: '', stderr: 'spawn-facet: missing spec.req\n' };
    }
    if (spec.kind === 'unknown') {
        return {
            exitCode: 127,
            stdout: '',
            stderr: spec.req.command + ': command not found\n',
        };
    }
    // env.SUPERVISOR is auto-injected by NimbusLoaderPool and pinned to
    // THIS DO's id (props.doId = ctx.id.toString()). With the in-DO
    // in-DO fanout route, "this DO" IS the user-session DO whose _cpRegistry
    // is populated; cpDispatchInline therefore reaches the right
    // dispatcher.
    if (!env || !env.SUPERVISOR || typeof env.SUPERVISOR.cpDispatchInline !== 'function') {
        return {
            exitCode: 1,
            stdout: '',
            stderr: 'spawn-facet: env.SUPERVISOR.cpDispatchInline missing\n',
        };
    }
    try {
        return await __nimbusUseRpcResult(env.SUPERVISOR.cpDispatchInline(spec.req, spec.kind), (r) => ({
            exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
            stdout: typeof r.stdout === 'string' ? r.stdout : '',
            stderr: typeof r.stderr === 'string' ? r.stderr : '',
        }));
    }
    catch (e) {
        return {
            exitCode: 1,
            stdout: '',
            stderr: 'spawn-facet error: ' + (e && e.message ? e.message : String(e)) + '\n',
        };
    }
};
