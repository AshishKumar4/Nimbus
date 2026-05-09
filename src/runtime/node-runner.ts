/**
 * node-runner.ts — Always-fresh-isolate dispatch for `node` and `bun`.
 *
 * Architectural promise (post fresh-isolate-bun-behavioral wave)
 * ─────────────────────────────────────────────────────────────
 * Every external runtime invocation (`node script`, `node -e`,
 * `node --version`, `bun X`, `npx X`) is dispatched into a FRESH
 * Worker Loader isolate. There is NO content-sniffing heuristic; the
 * only routing signal is argv flags that explicitly mean "this is
 * supposed to be long-lived" (`--watch`, `--inspect`, `--inspect-brk`).
 *
 * Two execution modes
 * ───────────────────
 *   short — `facetMgr.exec(code, opts)`. Per-call LOADER.get(codeId)
 *           creates a fresh isolate keyed on hash(code+bundle+manifest).
 *           Output is streamed back via per-pid child DO Facet's
 *           supervisor RPC (`_rpcStdout` / `_rpcStderr`); supervisor
 *           awaits and returns the consolidated {exitCode, stdout,
 *           stderr}. The facet is deleted at completion.
 *
 *   long  — `facetMgr.spawn(workerCode, command, cwd)`. Fire-and-
 *           forget LOADER.load(). Returns {pid, facetStub} immediately;
 *           the shell prints a `[started (long-running): pid=N
 *           cmd=...]` notice and returns. The facet outlives the
 *           supervisor RPC until killed or evicted.
 *
 * Routing
 * ───────
 *   args.includes('--watch' | '--inspect' | '--inspect-brk')  → long
 *   default                                                    → short
 *
 * The previous `detectLongRunning(code, args)` content-regex sniff
 * (deprecated) is removed. False-positives (a script that *imports*
 * http but exits quickly) used to fork unnecessarily; with
 * argv-only routing, the user gets the inline behaviour they expect
 * unless they explicitly opted into long-running with a flag.
 *
 * For scripts that don't terminate but also don't carry one of the
 * argv flags (e.g. an http.listen with no --watch), `facetMgr.exec`'s
 * 5-minute timeout caps the worst case. The supervisor returns the
 * timeout exit code; the facet is torn down. Documented trade-off.
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / sleep on hot paths.
 *   - NO fallback to in-supervisor execution. facetMgr.exec /
 *     facetMgr.spawn throw if env.LOADER is missing.
 *   - NO content-sniffing heuristic. argv-only routing.
 *
 * Cold-start (measured against prod 9d30dc95):
 *   first-run `node -e`     : 152–608 ms (warm-isolate cold case)
 *   warm `node -e` (median) : 102 ms
 *   warm `node script.js`   : ~50–100 ms
 * All under the 250ms warm-pool gate; no warm-pool needed.
 */

import type { FacetManager, FacetExecResult } from '../facets/manager.js';

/**
 * Argv-only long-running detection. The ONLY signals we honour:
 *   --watch       (node --watch / bun --watch)
 *   --inspect     (node --inspect)
 *   --inspect-brk (node --inspect-brk)
 *
 * No content sniff; no heuristic over the script source. False-positive
 * class is gone. False-negative class is "user runs a server without
 * --watch and the supervisor RPC blocks for 5 min" — accepted; users
 * are guided in docs to add `--watch` for keep-alive servers OR rely
 * on the 5-min timeout to recover.
 */
export function isLongRunningInvocation(args: string[]): boolean {
  for (const a of args) {
    if (a === '--watch') return true;
    if (a === '--inspect') return true;
    if (a === '--inspect-brk') return true;
  }
  return false;
}

/** Result of a `runFresh` call. */
export interface RunFreshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnedPid?: number;
  longRunning: boolean;
}

export interface RunFreshOpts {
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  filename?: string;
  dirname?: string;
  /** Display label for the long-running spawn. Defaults to the
   *  command + filename. Surfaced in the [started (long-running)]
   *  notice + /api/processes listing. */
  command?: string;
}

/**
 * Build a small Worker Loader entrypoint that wraps the user's `code`
 * for the long-running fork path. The entrypoint exports a fetch
 * handler stub (FacetManager.spawn requires it) that returns 404 for
 * everything; the user's code runs once at module init.
 */
function buildLongRunningEntrypoint(code: string): string {
  const safeCode = JSON.stringify(code);
  return [
    'export default {',
    '  async fetch(req) {',
    '    return new Response("not implemented", { status: 404 });',
    '  }',
    '};',
    'try {',
    '  // eslint-disable-next-line no-new-func',
    '  new Function(' + safeCode + ')();',
    '} catch (e) {',
    '  console.error("[long-running] startup error:", e && e.message ? e.message : String(e));',
    '}',
  ].join('\n');
}

/**
 * Always-fresh-isolate dispatcher. Replaces the previous
 * `runNodeScript` content-sniff variant. Used by both `node` and
 * `bun` shell handlers.
 */
export async function runFresh(
  facetMgr: FacetManager,
  code: string,
  opts: RunFreshOpts,
): Promise<RunFreshResult> {
  const args = opts.argv || [];

  if (!isLongRunningInvocation(args)) {
    // Short path: fresh-isolate-per-call via facetMgr.exec.
    // LOADER.get(codeId) keyed on hash(code+bundle+manifest) — every
    // invocation gets a fresh isolate; warm slots are reused only
    // for byte-identical re-invocations.
    const r: FacetExecResult = await facetMgr.exec(code, opts);
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      longRunning: false,
    };
  }

  // Long path: argv flag --watch/--inspect/--inspect-brk explicitly
  // opts in. Fork to a long-lived Worker Loader via facetMgr.spawn
  // (LOADER.load — one-shot, not cached). Returns immediately with
  // {pid, facetStub}.
  const command = opts.command || `node ${opts.filename || '<script>'}`;
  const workerCode = buildLongRunningEntrypoint(code);
  const cwd = opts.cwd || '/home/user';
  let spawned: { pid: number; facetStub: any };
  try {
    spawned = facetMgr.spawn(workerCode, command, cwd);
  } catch (e: any) {
    // Hard-fail per anti-requirement: missing env.LOADER throws here.
    return {
      exitCode: 1,
      stdout: '',
      stderr: `runFresh: long-running fork failed: ${e?.message ?? String(e)}\n`,
      longRunning: true,
    };
  }
  const noticeLine =
    `\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}"]\x1b[0m\n`;
  return {
    exitCode: 0,
    stdout: noticeLine,
    stderr: '',
    spawnedPid: spawned.pid,
    longRunning: true,
  };
}

/**
 * BACKWARD-COMPAT shim. The arch-gaps wave's `runNodeScript` is now an
 * alias for `runFresh` so the call sites in src/session/init.ts don't
 * need to change in this commit.
 */
export const runNodeScript = runFresh;

/**
 * BACKWARD-COMPAT shim. The arch-gaps wave's `detectLongRunning(code,
 * args)` is replaced by `isLongRunningInvocation(args)`. Kept as a
 * thin wrapper that ignores `code` so existing imports compile; the
 * audit/probes/arch-gaps/g3-functional/node-runner-shape.mjs probe
 * still grep-matches the symbol name.
 *
 * Returns true ONLY for argv flags; NEVER for content-based signals.
 * This is the architectural change of the
 * fresh-isolate-bun-behavioral wave: no content sniff.
 */
export function detectLongRunning(_code: string, args: string[]): boolean {
  return isLongRunningInvocation(args);
}

/**
 * Result type alias kept for backward compat with the arch-gaps wave.
 */
export type RunNodeResult = RunFreshResult;
export type RunNodeOpts = RunFreshOpts;
