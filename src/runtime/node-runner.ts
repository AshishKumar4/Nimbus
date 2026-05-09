/**
 * node-runner.ts — Centralised dispatch for the shell `node` command.
 *
 * Why this exists (gap #2 from arch-gaps wave)
 * ────────────────────────────────────────────
 * Pre-arch-gaps, the `node` registry handler at src/session/init.ts:214
 * always called `facetMgr.exec(code, opts)` and awaited the resulting
 * facet RPC. That works for short scripts but blocks the supervisor
 * indefinitely for long-running scripts (http.listen, app.listen,
 * top-level await loops, --watch). G1 S3 captured a 3.2s setInterval
 * blocking the supervisor's facet.run() RPC — a real http.listen
 * would never resolve until the 5-min facet timeout.
 *
 * What this module does
 * ─────────────────────
 *   - `detectLongRunning(code, args)`: bounded-regex sniff over the
 *     script source + argv. Returns true when the source looks like
 *     it intends to keep running (server-style or top-level await).
 *   - `runNodeScript(facetMgr, opts)`: dispatcher.
 *       • short scripts → the existing `facetMgr.exec` fresh-isolate path
 *         (one Worker Loader isolate per call, awaited synchronously).
 *       • long-running scripts → `facetMgr.spawn(workerCode, command, cwd)`
 *         which returns immediately with `{pid, facetStub}`. Caller
 *         emits `[started (long-running): pid=N cmd="…"]`. The facet
 *         stays alive until killed or until ctx.facets evicts it
 *         (same eviction path as vite).
 *
 * Anti-requirements
 * ─────────────────
 *   - NO setTimeout / sleep on hot paths.
 *   - NO fallback to in-supervisor execution. facetMgr.spawn throws if
 *     env.LOADER is missing.
 *   - Detection is conservative on the long-running side: false-positive
 *     class (short script that imports `http`) gets forked but emits
 *     a `[started (long-running)]` line so the user knows.
 *
 * Detection rules
 * ───────────────
 *   - Argv flags: `--watch`, `--inspect`, `--inspect-brk`.
 *   - Source patterns (after stripping line + block comments to avoid
 *     false-positives in commented-out code):
 *       http.createServer  /  https.createServer
 *       require('http')   /  require("http")  /  require(`http`)
 *       require('https')  ...
 *       import http from 'http'  /  import https from 'https'  /
 *         (also same with double quotes / backticks)
 *       Bun.serve  /  Deno.serve
 *       app.listen  /  server.listen  (express/koa/fastify-style)
 *       top-level await: line starts with `await `
 *
 * False-negative class: a script that listens via a non-detected
 * pattern (e.g. third-party server framework) blocks until the 5-min
 * facet timeout. Logged in audit/sections/ARCH-GAPS-plan.md §2.5.
 */

import type { FacetManager, FacetExecResult } from '../facets/manager.js';

/** Substring-sniff for long-running shape. Cheap, no AST parse. */
export function detectLongRunning(code: string, args: string[]): boolean {
  // Fast-path: argv flags.
  for (const a of args) {
    if (a === '--watch') return true;
    if (a === '--inspect') return true;
    if (a === '--inspect-brk') return true;
  }
  if (typeof code !== 'string' || code.length === 0) return false;
  // Strip comments before pattern-matching so commented-out
  // require('http') doesn't trip us.
  const stripped = code
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  if (/\bhttp\.createServer\b/.test(stripped)) return true;
  if (/\bhttps\.createServer\b/.test(stripped)) return true;
  if (/require\s*\(\s*['"`]https?['"`]\s*\)/.test(stripped)) return true;
  if (/import\s+[^;\n]*\sfrom\s+['"`]https?['"`]/.test(stripped)) return true;
  if (/\bBun\.serve\b/.test(stripped)) return true;
  if (/\bDeno\.serve\b/.test(stripped)) return true;
  if (/\bapp\.listen\s*\(/.test(stripped)) return true;
  if (/\bserver\.listen\s*\(/.test(stripped)) return true;
  // Top-level await: any line beginning (after optional whitespace)
  // with `await `. Multiline `m` flag.
  if (/^\s*await\s+/m.test(stripped)) return true;

  return false;
}

/** Result of a `runNodeScript` call. Mirrors FacetExecResult plus an
 *  optional `spawnedPid` set when the script forked to a long-running
 *  facet. When `spawnedPid` is set, `stdout`/`stderr` carry only the
 *  spawn-notice line; the user's script output streams through the
 *  process_table log path. */
export interface RunNodeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  spawnedPid?: number;
  longRunning: boolean;
}

export interface RunNodeOpts {
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  filename?: string;
  dirname?: string;
  /** Display label for the long-running spawn. Defaults to
   *  `node ${filename}`. Surfaced in the `[started (long-running)]`
   *  notice + `/api/processes` listing. */
  command?: string;
}

/**
 * Build a small Worker Loader entrypoint that wraps the user's `code`
 * for the long-running fork path. The entrypoint exports a fetch
 * handler stub (FacetManager.spawn requires it) that returns 404 for
 * everything — long-running node scripts don't speak HTTP from the
 * shell's perspective. The user's code runs once at module init.
 *
 * NB: This is the simplest possible long-running shape. Future
 * improvement: wire fetch routing for `node` HTTP servers so the
 * supervisor can proxy /api/proc/<pid>/* requests into the facet.
 * Out of scope for this wave.
 */
function buildLongRunningEntrypoint(code: string, _opts: RunNodeOpts): string {
  // The user's code runs at module init. We catch errors so the
  // facet doesn't crash on startup. The fetch handler is a stub.
  const safeCode = JSON.stringify(code);
  return [
    'export default {',
    '  async fetch(req) {',
    '    return new Response("not implemented", { status: 404 });',
    '  }',
    '};',
    '// User code runs at module init.',
    'try {',
    '  // eslint-disable-next-line no-new-func',
    '  new Function(' + safeCode + ')();',
    '} catch (e) {',
    '  console.error("[long-running] startup error:", e && e.message ? e.message : String(e));',
    '}',
  ].join('\n');
}

/**
 * Dispatch a node script either through the existing fresh-isolate
 * `facetMgr.exec` path (short scripts) or fork it to a long-running
 * Worker Loader via `facetMgr.spawn` (long-running scripts).
 *
 * Caller (src/session/init.ts) is responsible for the VFS read +
 * esbuild transform pre-pass; this function only dispatches the
 * already-prepared `code`.
 */
export async function runNodeScript(
  facetMgr: FacetManager,
  code: string,
  opts: RunNodeOpts,
): Promise<RunNodeResult> {
  const args = opts.argv || [];
  const long = detectLongRunning(code, args);

  if (!long) {
    // Short-script path: existing fresh-isolate-per-call via
    // facetMgr.exec. Mirrors src/session/init.ts:243-330 pre-arch-gaps.
    const r: FacetExecResult = await facetMgr.exec(code, opts);
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      longRunning: false,
    };
  }

  // Long-running path: fork to a long-lived Worker Loader. Returns
  // immediately with {pid, facetStub}. We discard the facetStub —
  // future improvement: hand it to the port-registry for HTTP routing.
  const command = opts.command || `node ${opts.filename || '<script>'}`;
  const workerCode = buildLongRunningEntrypoint(code, opts);
  const cwd = opts.cwd || '/home/user';
  let spawned: { pid: number; facetStub: any };
  try {
    spawned = facetMgr.spawn(workerCode, command, cwd);
  } catch (e: any) {
    // Hard-fail per anti-requirement: missing env.LOADER throws here.
    return {
      exitCode: 1,
      stdout: '',
      stderr: `node: long-running fork failed: ${e?.message ?? String(e)}\n`,
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
