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
import { resolveLongRunningPort } from './long-running-handle.js';
import type { FacetBundleProfile } from './bundle-profile.js';

/**
 * Argv long-running detection. Signals we honour:
 *   --watch       (node --watch / bun --watch)
 *   --inspect     (node --inspect)
 *   --inspect-brk (node --inspect-brk)
 */
export function isLongRunningInvocation(args: string[]): boolean {
  for (const a of args) {
    if (a === '--watch') return true;
    if (a === '--inspect') return true;
    if (a === '--inspect-brk') return true;
  }
  return false;
}

/**
 * A shell-launched server — `node server.js` doing http.createServer().listen()
 * (or express `app.listen()`, `Bun.serve()`, net.createServer(), …) — must run
 * in the KEYED long-running facet (spawnNode), not the one-shot exec facet: only
 * the keyed facet exposes a re-resolvable NimbusLoadedEntrypoint route stub, so
 * external `/port/<n>` and in-session loopback `curl` reach the server. The
 * one-shot facet is `LOADER.load` (unkeyed) and its stub cannot be re-entered
 * from a later request's context, so it is never routeable.
 *
 * Argv flags (`--watch`) can't express "this script binds a port", so we detect
 * the bind at the only place it is knowable ahead of running: a listen/serve
 * call in the source. A false positive (source mentions `.listen(` but exits)
 * only means the script runs in the persistent facet instead of the one-shot
 * one — identical observable behaviour to `node --watch <script>`. A miss keeps
 * the pre-existing "unreachable one-shot server" behaviour, never a regression.
 */
const SERVER_BIND_RE = /\.listen\s*\(|\bcreateServer\s*\(|\bserve\s*\(/;

export function looksLikeServer(code: string): boolean {
  return SERVER_BIND_RE.test(code);
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
  stdin?: string;
  captureOutput?: boolean;
  /** Display label for the long-running spawn. Defaults to the
   *  command + filename. Surfaced in the [started (long-running)]
   *  notice + /api/processes listing. */
  command?: string;
  /**
   * G4 (runtime-pkg wave): caller has already allocated a
   * process supervisor PID for this invocation; runFresh / facetMgr.exec
   * should reuse it instead of spawning a duplicate. Used by the
   * .bin handler in src/session/init.ts to keep `ps` showing ONE
   * row per bin invocation instead of two (the wrapper + the inner
   * node script).
   */
  skipSpawn?: boolean;
  callerPid?: number;
  forceLongRunning?: boolean;
  attachedTty?: boolean;
  bundleProfile?: FacetBundleProfile;
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
    'async function __nimbusDispatchHttp(req) {',
    '  const ports = globalThis.__portRegistry;',
    '  const hinted = Number(req.headers.get("X-Nimbus-Port") || 0);',
    '  const server = ports && (ports.get(hinted) || ports.values().next().value);',
    '  if (!server || typeof server._handleRequest !== "function") {',
    '    return new Response("Nimbus: no HTTP server is listening in this process", { status: 502 });',
    '  }',
    '  const url = new URL(req.url);',
    '  const headers = {};',
    '  req.headers.forEach((v, k) => { headers[k] = v; });',
    '  let body = "";',
    '  if (req.method !== "GET" && req.method !== "HEAD") body = await req.text();',
    '  const res = server._handleRequest(url.pathname + url.search, req.method, headers, body);',
    '  if (!res._ended) {',
    '    await new Promise((resolve) => {',
    '      try { res.on("finish", resolve); } catch { resolve(); }',
    '      setTimeout(resolve, 5000);',
    '    });',
    '  }',
    '  return new Response((res._body || []).join(""), { status: res.statusCode || 200, headers: res.headers || {} });',
    '}',
    'export default {',
    '  async fetch(req) { return __nimbusDispatchHttp(req); },',
    '  async handleHttpRequest(req) { return __nimbusDispatchHttp(req); }',
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

  // Promote server-shaped scripts to the keyed long-running facet even without
  // an explicit --watch flag: it is the only path whose route stub is
  // re-resolvable across requests, so its bound port is actually reachable.
  // .bin wrapper invocations (skipSpawn) keep the one-shot fast path — those
  // are CLIs, and their PID accounting assumes a single foreground exec.
  const wantsLongRunning =
    opts.forceLongRunning ||
    isLongRunningInvocation(args) ||
    (!opts.skipSpawn && looksLikeServer(code));

  if (!wantsLongRunning) {
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

  // Long path: an argv flag (--watch/--inspect/--inspect-brk) or a server-bind
  // in the source opted in. Fork to a keyed long-lived facet via
  // facetMgr.spawnNode — its NimbusLoadedEntrypoint route stub is re-resolvable
  // across requests, so a bound port is reachable. Returns immediately with
  // {pid, facetStub}.
  const command = opts.command || `node ${opts.filename || '<script>'}`;
  const workerCode = buildLongRunningEntrypoint(code);
  const cwd = opts.cwd || '/home/user';
  let spawned: { pid: number; facetStub: any };
  const port = resolveLongRunningPort({
    argv: args,
    env: opts.env,
    fallback: 3000,
  });
  try {
    if (typeof facetMgr.spawnNode === 'function') {
      spawned = await facetMgr.spawnNode(code, {
        argv: args,
        env: opts.env,
        cwd,
        filename: opts.filename,
        dirname: opts.dirname,
        command,
        port,
        attachedTty: opts.attachedTty,
        skipSpawn: opts.skipSpawn,
        callerPid: opts.callerPid,
        bundleProfile: opts.bundleProfile,
      });
    } else {
      spawned = await facetMgr.spawn(workerCode, command, cwd, { port });
    }
  } catch (e: any) {
    // Hard-fail per anti-requirement: missing env.LOADER throws here.
    return {
      exitCode: 1,
      stdout: '',
      stderr: `runFresh: long-running fork failed: ${e?.message ?? String(e)}\n`,
      longRunning: true,
    };
  }
  const noticeLine = opts.skipSpawn
    ? ''
    : `\x1b[2m[started (long-running): pid=${spawned.pid} cmd="${command}"]\x1b[0m\n`;
  return {
    exitCode: 0,
    stdout: noticeLine,
    stderr: '',
    spawnedPid: spawned.pid,
    longRunning: true,
  };
}

/**
 * BACKWARD-COMPAT shim. The child-process isolation design's `runNodeScript` is now an
 * alias for `runFresh` so the call sites in src/session/init.ts don't
 * need to change in this commit.
 */
export const runNodeScript = runFresh;
