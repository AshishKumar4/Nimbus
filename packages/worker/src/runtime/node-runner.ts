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
import { STDIN_SYNC_READ_BYTES } from '@nimbus-sh/core/runtime/stdin-read.js';
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
  /** Its code reads stdin synchronously (RuntimeRunOpts.stdinReadsSync). */
  stdinReadsSync?: boolean;
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
  /** Shell abort (Ctrl+C): aborting this kills the run through the
   *  terminator exec registers on the pid. */
  signal?: AbortSignal;
  /** Running the program starts a server (RuntimeRunOpts.launchesServer, server-launch.ts). */
  launchesServer?: boolean;
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
    isLongRunningInvocation(args) ||
    (!opts.skipSpawn && opts.launchesServer === true);

  if (!wantsLongRunning) {
    // Short path: fresh-isolate-per-call via facetMgr.exec.
    // LOADER.get(codeId) keyed on hash(code+bundle+manifest) — every
    // invocation gets a fresh isolate; warm slots are reused only
    // for byte-identical re-invocations.
    // A pipe or redirect streams to the program as it arrives (facetMgr.exec),
    // unless its code reads stdin synchronously: then the pipe is read ahead,
    // and delivered whole if it ends within the bound.
    const { stdin, stdinReadsSync, ...execOpts } = opts;
    let stdinOpts: { stdinBytes?: Uint8Array; stdinPipe?: StdinBytes } = {};
    if (stdin) {
      const source = stdinBytesOf(stdin);
      if (stdinReadsSync) {
        const ahead = await readAhead(source, STDIN_SYNC_READ_BYTES, opts.signal);
        if (ahead === null) return { exitCode: 130, stdout: '', stderr: '', longRunning: false };
        stdinOpts = ahead.ended ? { stdinBytes: concatBytes(ahead.chunks) } : { stdinPipe: replaying(ahead.chunks, source) };
      } else {
        stdinOpts = { stdinPipe: source };
      }
    }
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
      skipSpawn: opts.skipSpawn,
      callerPid: opts.callerPid,
      bundleProfile: opts.bundleProfile,
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

/** How many bytes of a pipe one read asks for. */
const STDIN_CHUNK_BYTES = 64 * 1024;

/** A shell stream's bytes: exact through readBytes, else its text encoded. */
function stdinBytesOf(stream: NonNullable<RunFreshOpts['stdin']>): StdinBytes {
  const encoder = new TextEncoder();
  return {
    readBytes: stream.readBytes
      ? (maxLength) => stream.readBytes!(maxLength)
      : async () => { const text = await stream.read(); return text === null ? null : encoder.encode(text); },
  };
}

/**
 * Read `source` until it ends or holds more than `limit` bytes; null when
 * `signal` aborts first (the shell's Ctrl+C).
 */
async function readAhead(source: StdinBytes, limit: number, signal?: AbortSignal)
  : Promise<{ chunks: Uint8Array[]; ended: boolean } | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const aborted = signal
    ? new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    })
    : null;
  while (total <= limit) {
    const next = source.readBytes(STDIN_CHUNK_BYTES);
    const chunk = aborted ? await Promise.race([next, aborted]) : await next;
    if (chunk === 'aborted') return null;
    if (chunk === null) return { chunks, ended: true };
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return { chunks, ended: false };
}

/** `source` with `chunks` read from it already put back in front. */
function replaying(chunks: Uint8Array[], source: StdinBytes): StdinBytes {
  return { readBytes: (maxLength) => chunks.length > 0 ? Promise.resolve(chunks.shift()!) : source.readBytes(maxLength) };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
