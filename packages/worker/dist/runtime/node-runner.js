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
import { parsePortFromArgv } from '@nimbus-sh/core/runtime/long-running-handle.js';
import { STDIN_SYNC_READ_BYTES } from '@nimbus-sh/core/runtime/stdin-read.js';
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
/** Dispatch a Node-compatible invocation into a fresh or keyed facet. */
export async function runFresh(facetMgr, code, opts) {
    const args = opts.argv || [];
    // A program that starts a server runs in the keyed long-running facet even
    // without --watch: only its route stub is re-resolvable across requests
    // (the one-shot facet is LOADER.load, unkeyed), so only there is the port it
    // binds reachable. The runtime handler judges that from the code this
    // invocation runs (server-launch.ts), its arguments included. .bin wrapper
    // invocations (skipSpawn) keep the one-shot fast path — those are CLIs, and
    // their PID accounting assumes a single foreground exec.
    const wantsLongRunning = opts.forceLongRunning ||
        isLongRunningInvocation(args) ||
        (!opts.skipSpawn && opts.launchesServer === true);
    if (!wantsLongRunning) {
        // Short path: fresh-isolate-per-call via facetMgr.exec.
        // LOADER.get(codeId) keyed on hash(code+bundle+manifest) — every
        // invocation gets a fresh isolate; warm slots are reused only
        // for byte-identical re-invocations.
        // A pipe streams to the program as it arrives (facetMgr.exec). When its
        // code reads stdin synchronously, the pipe is read ahead first, up to the
        // bound, each piece charged to the session's budget as it is read
        // (facetMgr.stdinReadAhead): a pipe that ends within it is the program's
        // whole stdin before it starts (still streamed, from here). When the
        // budget, held by concurrent launches' read ahead, cannot cover the next
        // piece, the launch streams the rest. A `< file` needs no read ahead:
        // fd 0 is the file.
        // A program whose own input channel is its stdin (a child_process
        // child's) and reads it synchronously reads that channel ahead itself,
        // to the same bound (stdinSyncRead): there is no second channel to feed.
        const { stdin, stdinReadsSync, stdinFile, ...execOpts } = opts;
        let stdinOpts = {};
        let account = null;
        try {
            if (stdinFile) {
                stdinOpts = { stdinFile: { ...stdinFile, syncRead: stdinReadsSync === true } };
            }
            else if (!stdin) {
                if (stdinReadsSync)
                    stdinOpts = { stdinSyncRead: true };
            }
            else {
                const source = stdinBytesOf(stdin);
                if (stdinReadsSync) {
                    account = facetMgr.stdinReadAhead.open();
                    const ahead = await readAhead(source, STDIN_SYNC_READ_BYTES, account, opts.signal);
                    if (ahead === null)
                        return { exitCode: 130, stdout: '', stderr: '', longRunning: false };
                    stdinOpts = { stdinPipe: replaying(ahead.chunks, source, account), stdinWhole: ahead.ended };
                }
                else {
                    stdinOpts = { stdinPipe: source };
                }
            }
            const r = await facetMgr.exec(code, { ...execOpts, ...stdinOpts });
            return {
                exitCode: r.exitCode,
                stdout: r.stdout,
                stderr: r.stderr,
                longRunning: false,
            };
        }
        finally {
            // However the launch ended: exit, abort, or a launch that failed.
            account?.give();
        }
    }
    // Long path: an argv flag (--watch/--inspect/--inspect-brk) or a server-bind
    // in the source opted in. Fork to a keyed long-lived facet via
    // facetMgr.spawnNode — the fabric binds a re-resolvable route target for the
    // pid, so a bound port is reachable from any later request. Returns
    // immediately with {pid}.
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
            invokerPid: opts.invokerPid,
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
function isByteStream(stream) {
    return !!stream.readBytes;
}
/** A shell stream's bytes: exact through readBytes, else its text encoded. */
function stdinBytesOf(stream) {
    if (isByteStream(stream))
        return { readBytes: (maxLength) => stream.readBytes(maxLength) };
    // A text-only stream: at most `maxLength` bytes a read, as readBytes gives,
    // so a read ahead holds no more than it charged to the budget.
    const encoder = new TextEncoder();
    let rest = null;
    return {
        readBytes: async (maxLength) => {
            if (rest === null) {
                const text = await stream.read();
                if (text === null)
                    return null;
                rest = encoder.encode(text);
            }
            const piece = rest.subarray(0, maxLength);
            rest = piece.byteLength < rest.byteLength ? rest.subarray(piece.byteLength) : null;
            return piece;
        },
    };
}
/**
 * The bytes a read ahead holds, in buffers it owns: pieces smaller than a
 * sixteenth of a read are copied into one shared buffer, so a writer's tiny
 * writes hold a buffer per read rather than an array each, and a view into a
 * larger buffer is copied, so it holds only the bytes it was charged for.
 */
class ReadAheadBuffers {
    chunks = [];
    pending = null;
    used = 0;
    add(piece) {
        if (piece.byteLength === 0)
            return;
        if (piece.byteLength >= STDIN_CHUNK_BYTES / 16) {
            this.flush();
            this.chunks.push(piece.byteLength === piece.buffer.byteLength ? piece : piece.slice());
            return;
        }
        if (this.pending !== null && this.used + piece.byteLength > this.pending.byteLength)
            this.flush();
        this.pending ??= new Uint8Array(STDIN_CHUNK_BYTES);
        this.pending.set(piece, this.used);
        this.used += piece.byteLength;
    }
    /** The held bytes, the shared buffer's included; call once, when reading stops. */
    finish() {
        this.flush();
        return this.chunks;
    }
    flush() {
        if (this.pending === null || this.used === 0)
            return;
        const full = this.used === this.pending.byteLength;
        this.chunks.push(full ? this.pending : this.pending.slice(0, this.used));
        if (full)
            this.pending = null;
        this.used = 0;
    }
}
/**
 * `read`, or 'aborted' once `signal` aborts first. The abort listener lives
 * only as long as this one read, so a read ahead of many tiny reads leaves
 * nothing behind on a signal that outlives it (the shell's, for the whole
 * command).
 */
function untilAborted(read, signal) {
    if (signal === undefined)
        return read;
    if (signal.aborted)
        return Promise.resolve('aborted');
    return new Promise((resolve, reject) => {
        const onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        read.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
}
/**
 * Read `source` until it ends, holds more than `limit` bytes (at most
 * `limit` + 1: the extra byte shows whether it ended exactly at the limit), or
 * `account` cannot cover the next piece; null when `signal` aborts first (the
 * shell's Ctrl+C). Each piece is charged to `account` before it is read, for
 * no more than the read asks, and what the read did not return is given back.
 */
async function readAhead(source, limit, account, signal) {
    const held = new ReadAheadBuffers();
    let total = 0;
    while (total <= limit) {
        const granted = account.take(Math.min(STDIN_CHUNK_BYTES, limit + 1 - total));
        if (granted === 0)
            return { chunks: held.finish(), ended: false };
        const chunk = await untilAborted(source.readBytes(granted), signal);
        if (chunk === 'aborted')
            return null;
        if (chunk === null) {
            account.give(granted);
            return { chunks: held.finish(), ended: true };
        }
        account.give(granted - chunk.byteLength);
        held.add(chunk);
        total += chunk.byteLength;
    }
    return { chunks: held.finish(), ended: false };
}
/**
 * `source` with `chunks` read from it already put back in front, each
 * released as it is handed on, back to the session's budget too, so the read
 * ahead leaves this isolate as the program takes it.
 */
function replaying(chunks, source, account) {
    return {
        readBytes: (maxLength) => {
            const next = chunks.shift();
            if (next === undefined)
                return source.readBytes(maxLength);
            account.give(next.byteLength);
            return Promise.resolve(next);
        },
    };
}
