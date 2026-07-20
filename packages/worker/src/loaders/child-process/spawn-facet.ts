/**
 * Per-spawn task body for Worker Loader isolates.
 *
 * The isolate delegates command execution back to the supervisor through a
 * narrow RPC and returns copied string output. The parent pool owns streaming
 * and process bookkeeping.
 */

export interface SpawnInIsolateSpec {
  /** The original cp.spawn payload from node-shims.ts. */
  req: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    stdio?: any;
    detached?: boolean;
    shell?: boolean | string;
    stdin?: string;
  };
  /** Pre-resolved kind from FacetProcessManager._dispatch. */
  kind: 'pure-builtin' | 'facet-direct' | 'shell-direct';
}

export interface SpawnInIsolateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

declare const __nimbusUseRpcResult: <T, R>(
  promise: Promise<T>,
  use: (value: T) => R | Promise<R>,
) => Promise<R>;

/**
 * Signature must remain `(spec, env)` because Worker Loader dispatch calls
 * the task as `fn(item, env)`.
 */
export const runSpawnInIsolate = async function runSpawnInIsolate(
  spec: SpawnInIsolateSpec,
  env: {
    SUPERVISOR: {
      cpDispatchInline(req: any, kind: string): Promise<{
        exitCode: number; stdout: string; stderr: string;
      }>;
    };
  },
): Promise<SpawnInIsolateResult> {
  if (!spec || !spec.req) {
    return { exitCode: 1, stdout: '', stderr: 'spawn-facet: missing spec.req\n' };
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
    return await __nimbusUseRpcResult(
      env.SUPERVISOR.cpDispatchInline(spec.req, spec.kind),
      (r) => ({
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
        stdout: typeof r.stdout === 'string' ? r.stdout : '',
        stderr: typeof r.stderr === 'string' ? r.stderr : '',
      }),
    );
  } catch (e: any) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'spawn-facet error: ' + (e && e.message ? e.message : String(e)) + '\n',
    };
  }
};
