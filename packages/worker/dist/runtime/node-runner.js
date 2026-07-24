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
 *   long  — `facetMgr.spawnNode(code, opts)`. Fire-and-
 *           forget LOADER.load(). Returns {pid, facetStub} immediately;
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
import { parsePortFromArgv } from './long-running-handle.js';
/**
 * Argv long-running detection. Signals we honour:
 *   --watch       (node --watch / bun --watch)
 *   --inspect     (node --inspect)
 *   --inspect-brk (node --inspect-brk)
 */
export function isLongRunningInvocation(args) {
    for (const a of args) {
        if (a === '--watch')
            return true;
        if (a === '--inspect')
            return true;
        if (a === '--inspect-brk')
            return true;
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
export function looksLikeServer(code) {
    return SERVER_BIND_RE.test(code);
}
/** Dispatch a Node-compatible invocation into a fresh or keyed facet. */
export async function runFresh(facetMgr, code, opts) {
    const args = opts.argv || [];
    // Promote server-shaped scripts to the keyed long-running facet even without
    // an explicit --watch flag: it is the only path whose route stub is
    // re-resolvable across requests, so its bound port is actually reachable.
    // .bin wrapper invocations (skipSpawn) keep the one-shot fast path — those
    // are CLIs, and their PID accounting assumes a single foreground exec.
    const wantsLongRunning = opts.forceLongRunning ||
        isLongRunningInvocation(args) ||
        (!opts.skipSpawn && looksLikeServer(code));
    if (!wantsLongRunning) {
        // Short path: fresh-isolate-per-call via facetMgr.exec.
        // LOADER.get(codeId) keyed on hash(code+bundle+manifest) — every
        // invocation gets a fresh isolate; warm slots are reused only
        // for byte-identical re-invocations.
        const r = await facetMgr.exec(code, opts);
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
    const cwd = opts.cwd || '/home/user';
    let spawned;
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
    }
    catch (e) {
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
