/**
 * node-runner.ts — Always-fresh-isolate dispatch for `node` and `bun`.
 *
 * Architectural promise (post fresh-isolate-bun-behavioral wave)
 * ─────────────────────────────────────────────────────────────
 * Every external runtime invocation is dispatched into a Worker Loader
 * isolate. Explicit long-running flags and source that binds a server use
 * a keyed facet so later requests can resolve its route stub.
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
 *   long  — `facetMgr.spawnNode(code, opts)`. Boots a resident
 *           process through the fabric. Returns {pid} immediately;
 *           the shell prints a `[started (long-running): pid=N
 *           cmd=...]` notice and returns. The facet outlives the
 *           supervisor RPC until killed or evicted.
 *
 * Routing
 * ───────
 *   long-running argv flag or server bind in source  → long
 *   default                                          → short
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / sleep on hot paths.
 *   - NO fallback to in-supervisor execution. facetMgr.exec /
 *     facetMgr.spawnNode throw if env.LOADER is missing.
 *
 * Cold-start (measured against prod 9d30dc95):
 *   first-run `node -e`     : 152–608 ms (warm-isolate cold case)
 *   warm `node -e` (median) : 102 ms
 *   warm `node script.js`   : ~50–100 ms
 * All under the 250ms warm-pool gate; no warm-pool needed.
 */

import type { FacetManager, FacetExecResult } from '../facets/manager.js';
import { parsePortFromArgv } from '@nimbus-sh/core/runtime/long-running-handle.js';
import type { FacetBundleProfile } from '@nimbus-sh/core/runtime/bundle-profile.js';
import type { NodeLaunch } from '@nimbus-sh/core/runtime/node-cli.js';
import type { StdinBytes } from '../facets/manager.js';

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
  /** A pipe or redirect (runtime-registry's RuntimeRunOpts.stdin). */
  stdin?: { read(): Promise<string | null>; readBytes?(maxLength: number): Promise<Uint8Array | null> };
  /** A `< file` redirect: fd 0 is this file (RuntimeRunOpts.stdinFile). */
  stdinFile?: { path: string; offset: number };
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
  /** The invoking process (RuntimeRunOpts.invokerPid): a pid this run spawns carries its exec id. */
  invokerPid?: number;
  forceLongRunning?: boolean;
  attachedTty?: boolean;
  /** Its launcher writes and ends its stdin (RuntimeRunOpts.stdinWriter). */
  stdinWriter?: boolean;
  bundleProfile?: FacetBundleProfile;
  /** Shell abort (Ctrl+C): aborting this kills the run through the
   *  terminator exec registers on the pid. */
  signal?: AbortSignal;
  /** Running the program starts a server (RuntimeRunOpts.launchesServer, server-launch.ts). */
  launchesServer?: boolean;
  /** A node program's command line (RuntimeRunOpts.node). */
  node?: NodeLaunch;
}

/** Dispatch a Node-compatible invocation into a fresh or keyed facet. */
export async function runFresh(
  facetMgr: FacetManager,
  code: string,
  opts: RunFreshOpts,
): Promise<RunFreshResult> {
  const args = opts.argv || [];

  // A program that starts a server runs in the keyed long-running facet even
  // without --watch: only its route stub is re-resolvable across requests
  // (the one-shot facet is LOADER.load, unkeyed), so only there is the port it
  // binds reachable. The runtime handler judges that from the code this
  // invocation runs (server-launch.ts), its arguments included. .bin wrapper
  // invocations (skipSpawn) keep the one-shot fast path — those are CLIs, and
  // their PID accounting assumes a single foreground exec.
  const wantsLongRunning =
    opts.forceLongRunning ||
    // Node's options are its execArgv now, not its argv (node-cli.ts).
    isLongRunningInvocation([...(opts.node?.execArgv ?? []), ...args]) ||
    (!opts.skipSpawn && opts.launchesServer === true);

  if (!wantsLongRunning) {
    // Short path: fresh-isolate-per-call via facetMgr.exec.
    // LOADER.get(codeId) keyed on hash(code+bundle+manifest) — every
    // invocation gets a fresh isolate; warm slots are reused only
    // for byte-identical re-invocations.
    // A pipe streams to the program as it arrives (facetMgr.exec), and a
    // `< file` is fd 0 itself. Nothing is read ahead of the program: a
    // synchronous read of stdin that needs input not there yet stops the run,
    // and facetMgr.exec runs the program again once the input is there
    // (runtime/stop-replay.ts). A program that never makes such a read is
    // never held for its stdin.
    const { stdin, stdinFile, ...execOpts } = opts;
    const stdinOpts = stdinFile ? { stdinFile: { ...stdinFile, syncRead: false } }
      : stdin ? { stdinPipe: stdinBytesOf(stdin) } : {};
    const r: FacetExecResult = await facetMgr.exec(code, { ...execOpts, ...stdinOpts });
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      longRunning: false,
    };
  }

  // Long path: an argv flag (--watch/--inspect/--inspect-brk) or a server-bind
  // in the source opted in. Fork to a keyed long-lived facet via
  // facetMgr.spawnNode — the fabric binds a re-resolvable route target for the
  // pid, so a bound port is reachable from any later request. Returns
  // immediately with {pid}.
  const command = opts.command || `node ${opts.filename || '<script>'}`;
  const cwd = opts.cwd || '/home/user';
  let spawned: { pid: number };
  // Pre-reserve ONLY a port this invocation named on argv. $PORT does not
  // qualify: the session exports PORT=3000 by default so Express-style scripts
  // find it, which meant every long-running `node x.js` reserved 3000 whatever
  // it really bound — so the second server started in a session took over the
  // first one's port, and /port/3000 answered from the newest process while
  // the one the user started kept running, unreachable. A port a program
  // truly binds registers itself through the http shim's listen() ->
  // SUPERVISOR.registerPort, which is where the honest registration comes
  // from (and how a script that does honour $PORT still gets routed).
  const port = parsePortFromArgv(args) ?? undefined;
  try {
    spawned = await facetMgr.spawnNode(code, {
      argv: args,
      env: opts.env,
      cwd,
      filename: opts.filename,
      dirname: opts.dirname,
      command,
      port,
      attachedTty: opts.attachedTty,
      ...(opts.stdinWriter ? { stdinWriter: true } : {}),
      skipSpawn: opts.skipSpawn,
      callerPid: opts.callerPid,
      invokerPid: opts.invokerPid,
      bundleProfile: opts.bundleProfile,
      ...(opts.node ? { node: opts.node } : {}),
    });
  } catch (e: any) {
    // Hard-fail per anti-requirement: missing env.LOADER throws here.
    return {
      exitCode: 1,
      stdout: '',
      stderr: `runFresh: long-running fork failed: ${e?.message ?? String(e)}\n`,
      longRunning: true,
    };
  }
  // A server-shaped program that finished during its boot (`--version`,
  // `--help`, a one-shot run of a CLI that also serves) is an ordinary
  // completed command: its own exit code, no "started" notice.
  const finished = facetMgr.processExitCode?.(spawned.pid) ?? null;
  if (finished !== null) {
    return { exitCode: finished, stdout: '', stderr: '', longRunning: false };
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

function isByteStream(stream: NonNullable<RunFreshOpts['stdin']>): stream is NonNullable<RunFreshOpts['stdin']> & StdinBytes {
  return !!stream.readBytes;
}

/** A shell stream's bytes: exact through readBytes, else its text encoded. */
function stdinBytesOf(stream: NonNullable<RunFreshOpts['stdin']>): StdinBytes {
  if (isByteStream(stream)) return { readBytes: (maxLength) => stream.readBytes(maxLength) };
  // A text-only stream: at most `maxLength` bytes a read, as readBytes gives,
  // so a piece is never more than the pump asked for.
  const encoder = new TextEncoder();
  let rest: Uint8Array | null = null;
  return {
    readBytes: async (maxLength) => {
      if (rest === null) {
        const text = await stream.read();
        if (text === null) return null;
        rest = encoder.encode(text);
      }
      const piece = rest.subarray(0, maxLength);
      rest = piece.byteLength < rest.byteLength ? rest.subarray(piece.byteLength) : null;
      return piece;
    },
  };
}
