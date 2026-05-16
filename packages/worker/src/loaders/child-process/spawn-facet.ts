/**
 * spawn-facet.ts — Per-spawn task body run inside a fresh Worker Loader
 * isolate via NimbusFanoutPool.
 *
 * Why this exists (gap #1 from arch-gaps wave)
 * ────────────────────────────────────────────
 * Pre-arch-gaps, child_process.spawn from inside a node facet RPCs back
 * to the supervisor's FacetProcessManager._dispatch, which directly
 * invokes either commandRegistry.runPureBuiltin or facetMgr.execStream.
 * Both paths execute IN THE SUPERVISOR'S V8 CONTEXT. The supervisor's
 * heap thus accumulates per-spawn allocation pressure.
 *
 * arch-gaps target: every cp.spawn / spawnSync / exec / execFile call
 * runs inside a fresh Worker Loader isolate. NimbusFanoutPool (proven
 * by F-1 install-batch and F-2 resolver fan-out) provides the auto-
 * routing primitive (in-DO POC C for <5, peer-DO POC B for ≥5).
 *
 * What this task does
 * ───────────────────
 *   1. Mints a per-isolate token (`globalThis.__nimbus_g3_token__`).
 *      The first call into a fresh isolate creates the token; warm
 *      slots reuse it. Distinct tokens across calls = distinct
 *      isolates. Probe surface: audit/probes/arch-gaps/g3-e2e/
 *      child-spawn-isolation.mjs.
 *   2. Delegates the actual command execution to
 *      `env.SUPERVISOR.cpDispatchInline(req, kind)`. This RPC reuses
 *      the existing pure-builtin / facet-direct execution paths
 *      (preserves correctness) but the dispatch envelope itself ran
 *      in a fresh isolate.
 *   3. Returns `{ exitCode, marker, stdout, stderr }`. The supervisor-
 *      side ChildProcessSpawnPool wraps the marker into a per-spawn
 *      stderr line and forwards stdout/stderr to the parent's WS.
 *
 * Single-ownership invariant (carried over from git-freeze Q-fix):
 * stdin (if any) is passed by-value as a string in `req.stdin`; no
 * shared ArrayBuffer/Uint8Array refs. The result envelope returns
 * stdout/stderr as strings (already copied by the structured-clone
 * boundary).
 *
 * Stability invariants (cloudflare-parallel serialises via fn.toString):
 *   - No `this` references.
 *   - No closure capture other than args + (optional) preamble.
 *   - The function is the only export's body; helpers inlined.
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
  kind: 'pure-builtin' | 'facet-direct' | 'unknown';
  /** Stable id the parent captured for the spawn (for hooks-routing). */
  parentChildId: number | string;
}

export interface SpawnInIsolateResult {
  exitCode: number;
  /** Per-isolate token line: `[g3-spawn-isolate] tok=<TOKEN>\n`.
   *  Pre-pended to stderr by the supervisor-side spawn-pool when the
   *  result is forwarded to the cp.spawn parent. Distinct values across
   *  results = distinct isolates ran the dispatch. */
  marker: string;
  stdout: string;
  stderr: string;
}

/**
 * Per-spawn task body. Serialised via fn.toString() and dispatched
 * by NimbusFanoutPool.submitMany. Signature must be (spec, env) so
 * NimbusFanoutPool's internal `fn(item, env)` lines up.
 *
 * `env.SUPERVISOR` is the supervisor-rpc binding wired automatically
 * by NimbusLoaderPool (see src/loaders/loader-pool.ts:288 — bindings
 * default to `{ SUPERVISOR }`).
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
  // Mint or reuse the per-isolate token.
  const g: any = globalThis as any;
  if (typeof g.__nimbus_g3_token__ !== 'string') {
    g.__nimbus_g3_token__ = Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 6);
  }
  const marker = '[g3-spawn-isolate] tok=' + g.__nimbus_g3_token__ + '\n';

  if (!spec || !spec.req) {
    return { exitCode: 1, marker, stdout: '', stderr: 'spawn-facet: missing spec.req\n' };
  }

  if (spec.kind === 'unknown') {
    return {
      exitCode: 127,
      marker,
      stdout: '',
      stderr: spec.req.command + ': command not found\n',
    };
  }

  // env.SUPERVISOR is auto-injected by NimbusLoaderPool and pinned to
  // THIS DO's id (props.doId = ctx.id.toString()). With the in-DO
  // POC C route, "this DO" IS the user-session DO whose _cpRegistry
  // is populated; cpDispatchInline therefore reaches the right
  // dispatcher.
  if (!env || !env.SUPERVISOR || typeof env.SUPERVISOR.cpDispatchInline !== 'function') {
    return {
      exitCode: 1,
      marker,
      stdout: '',
      stderr: 'spawn-facet: env.SUPERVISOR.cpDispatchInline missing\n',
    };
  }

  try {
    const r = await env.SUPERVISOR.cpDispatchInline(spec.req, spec.kind);
    return {
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
      marker,
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
    };
  } catch (e: any) {
    return {
      exitCode: 1,
      marker,
      stdout: '',
      stderr: 'spawn-facet error: ' + (e && e.message ? e.message : String(e)) + '\n',
    };
  }
};
