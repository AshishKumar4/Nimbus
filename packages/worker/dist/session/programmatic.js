/**
 * session/programmatic.ts - public sandbox RPC helpers.
 *
 * These helpers are called by NimbusSession one-line delegators so the
 * Durable Object exposes a typed, programmatic sandbox surface without
 * duplicating the interactive terminal boot path.
 */
import { ensureRuntimesProgrammatic, installRuntimeProgrammatic, listAvailableRuntimes, } from '../runtime/package-manager.js';
import { listInstalledRuntimes, } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { endProcessInput, resizeProcess, signalProcess, writeProcessInput, } from '@nimbus-sh/core/runtime/process-input-routing.js';
import { z } from 'zod/v4';
import { SESSION_DESTROYED_KEY, SHELL_STATE_KEY_PREFIX, VITE_CONFIG_KEY } from './keys.js';
import { clearPortCapability, persistPortCapability, restorePortCapability, } from './port-capability.js';
import { GENERATION_KEY, assumeGeneration, generation } from '@nimbus-sh/fabric/generation.js';
import { HeadlessTerminal, Shell } from '@nimbus-sh/core/substrate/lifo/index.js';
const ShellIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ShellStateSchema = z.object({
    cwd: z.string().startsWith('/'),
    env: z.record(z.string(), z.string()),
}).strict();
/**
 * A second Shell over the session's own kernel, filesystem and command
 * registry — the same objects the interactive shell uses, so a named shell is
 * not a second filesystem or a second process table. Only cwd and environment
 * are its own, which is exactly what makes `cd` stick between calls.
 */
export function createProgrammaticShell(self, pid, state) {
    const parent = self.shell;
    if (!parent)
        throw new Error('Nimbus shell did not initialize');
    const shell = new Shell(new HeadlessTerminal(), parent.getVfs(), parent.getRegistry(), { ...parent.getEnv(), ...state.env, $: String(pid) }, parent.getProcessRegistry(), {
        pid,
        get cred() { return self.processes.cred(pid); },
        setUmask: (mask) => self.processes.setUmask(pid, mask),
        runAs: parent.getRunAsHost(),
    });
    shell.setCwd(state.cwd);
    return shell;
}
/**
 * Run `body` against a named shell's durable state, or against nothing when no
 * `shellId` was given.
 *
 * Serialized per id: two concurrent calls naming one shell would otherwise
 * read the same cwd and race to write it back, and the loser's `cd` would
 * vanish. A background job reads the state but does not write it back — its
 * shell outlives the call, so what it would persist is a snapshot of a moment
 * nobody asked about.
 */
async function withShellState(self, options, background, run) {
    if (options.shellId === undefined)
        return run(null);
    const id = ShellIdSchema.parse(options.shellId);
    self._programmaticShellQueues ??= new Map();
    const queues = self._programmaticShellQueues;
    const previous = queues.get(id) ?? Promise.resolve();
    let release = () => { };
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    queues.set(id, tail);
    await previous.catch(() => undefined);
    try {
        const key = `${SHELL_STATE_KEY_PREFIX}${id}`;
        const stored = await self.ctx.storage.get(key);
        const root = typeof options.shellRoot === 'string' && options.shellRoot.startsWith('/')
            ? options.shellRoot
            : getHome(self);
        const state = stored === undefined
            ? { cwd: root, env: {} }
            : ShellStateSchema.parse(stored);
        let shell = null;
        try {
            return await run({
                cwd: state.cwd,
                create: (pid) => {
                    shell = createProgrammaticShell(self, pid, state);
                    return shell;
                },
            });
        }
        finally {
            const captured = background || shell === null ? state : capturedShellState(shell);
            await self.ctx.storage.put(key, captured);
        }
    }
    finally {
        release();
        if (queues.get(id) === tail)
            queues.delete(id);
    }
}
function capturedShellState(shell) {
    const env = { ...shell.getEnv() };
    // `$` is the pid of the call that just ended, not state of the shell.
    delete env.$;
    return { cwd: shell.getCwd(), env };
}
/**
 * The durable half of the port capability lives in `./port-capability.js`, so
 * the facet manager can retire a stale one without importing this module.
 */
const ProcessLogsOptionsSchema = z.object({
    cursor: z.number().int().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
}).strict();
function makeHeadlessWebSocket() {
    const listeners = new Map();
    const state = { readyState: 1 };
    const ws = {
        get readyState() { return state.readyState; },
        send(_data) { },
        close() {
            state.readyState = 3;
            for (const cb of listeners.get('close') ?? []) {
                try {
                    cb();
                }
                catch { }
            }
        },
        accept() { },
        addEventListener(type, cb) {
            const set = listeners.get(type) ?? new Set();
            set.add(cb);
            listeners.set(type, set);
        },
        removeEventListener(type, cb) {
            listeners.get(type)?.delete(cb);
        },
        serializeAttachment(_value) { },
        deserializeAttachment() { return { kind: 'programmatic' }; },
    };
    return ws;
}
function getHome(self) {
    try {
        const envHome = self.shell?.env?.HOME;
        if (envHome)
            return String(envHome);
    }
    catch { }
    try {
        const shellEnv = self.shell?.getEnv?.();
        if (shellEnv?.HOME)
            return String(shellEnv.HOME);
    }
    catch { }
    return '/home/user';
}
function runtimeDeps(self) {
    self.ensureSqliteFs();
    if (!self.sqliteFs)
        throw new Error('Nimbus SQLite filesystem did not initialize');
    if (!self._cpRegistry)
        throw new Error('Nimbus shell registry did not initialize');
    return {
        env: self.env,
        vfs: self.sqliteFs,
        registry: self._cpRegistry,
        getHome: () => getHome(self),
    };
}
export async function ensureProgrammaticReady(self, options = {}) {
    if (!self.shell) {
        await self.initSession(makeHeadlessWebSocket());
        // Programmatic boot owns no real terminal socket. Mark the session
        // drained so a later browser /ws can warm-join instead of 409ing.
        self._b4Phase = 'drained';
    }
    else {
        self.ensureSqliteFs();
        self.ensureFacetManager();
    }
    const preinstall = Array.from(new Set(options.preinstall ?? []))
        .map((s) => String(s).trim())
        .filter(Boolean);
    if (preinstall.length > 0) {
        const results = await ensureRuntimesProgrammatic(runtimeDeps(self), preinstall);
        const failed = results.filter((r) => r.exitCode !== 0);
        if (failed.length > 0) {
            const details = failed.map((r) => `${r.spec}: ${r.stderr || r.stdout}`).join('\n');
            throw new Error(`runtime preinstall failed:\n${details}`);
        }
    }
    return { ok: true, preinstalled: preinstall };
}
function startShellJob(self, command, options, job, scoped) {
    const parentShell = self.shell;
    if (!parentShell)
        throw new Error('Nimbus shell did not initialize');
    const line = String(command);
    const cwd = options.cwd ?? scoped?.cwd ?? parentShell.getCwd?.() ?? '/home/user';
    const entry = self.processes.spawn(line, [line], cwd, {
        longRunning: job.background,
        cred: options.cred,
    });
    // The scoped shell is built around the pid, so its `$` and its credential
    // are the ones this command actually runs under.
    const shell = scoped?.create(entry.pid) ?? parentShell;
    const pid = entry.pid;
    if (job.background)
        self.processes.openInput(pid);
    const controller = new AbortController();
    self.processes.setTerminator(pid, () => {
        try {
            controller.abort();
        }
        catch { /* already settled */ }
    });
    const emit = (stream, sink) => (data) => {
        const text = String(data);
        if (job.background) {
            try {
                self.processes.appendOutput(pid, stream, text);
            }
            catch { /* ring gone */ }
        }
        sink?.(text);
    };
    const run = shell.execute(line, {
        // A named shell already holds its own cwd and env; passing them again
        // would pin it to the values this call started with and `cd` would not
        // survive the call, which is the whole point of naming one.
        cwd: scoped ? options.cwd : cwd,
        env: scoped ? options.env : { ...(shell.getEnv?.() ?? {}), ...(options.env ?? {}) },
        onStdout: emit('stdout', job.onStdout),
        onStderr: emit('stderr', job.onStderr),
        signal: controller.signal,
        stdin: options.stdin,
        // A background job must not mutate the interactive shell's cwd, env, or
        // options; a foreground exec stays stateful, as it always has been.
        isolateShellState: job.background,
        commandContext: {
            pid,
            cred: entry.cred,
            setUmask: (mask) => self.processes.setUmask(pid, mask),
            ...(job.background
                ? {
                    __nimbusBinSpawn: {
                        skipSpawn: true,
                        callerPid: pid,
                        command: line,
                        forceLongRunning: true,
                    },
                }
                : {}),
        },
    });
    return { pid, entry, run, abort: () => { try {
            controller.abort();
        }
        catch { } } };
}
export async function rpcExec(self, command, options = {}) {
    await ensureProgrammaticReady(self, options);
    return withShellState(self, options, false, (scoped) => execOnShell(self, command, options, scoped));
}
async function execOnShell(self, command, options, scoped) {
    const stdout = [];
    const stderr = [];
    const started = Date.now();
    let timeout = null;
    let timedOut = false;
    const job = startShellJob(self, command, options, {
        background: false,
        onStdout: (d) => stdout.push(d),
        onStderr: (d) => stderr.push(d),
    }, scoped);
    let result;
    try {
        result = options.timeoutMs && options.timeoutMs > 0
            ? await Promise.race([
                job.run,
                new Promise((resolve) => {
                    timeout = setTimeout(() => {
                        timedOut = true;
                        job.abort();
                        resolve({ exitCode: 124 });
                    }, options.timeoutMs);
                }),
            ])
            : await job.run;
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
    const exitCode = Number(result.exitCode ?? (timedOut ? 124 : 0));
    self.processes.exit(job.pid, exitCode);
    if (timedOut) {
        stderr.push(`command timed out after ${options.timeoutMs}ms\n`);
    }
    const logged = collectJobOutput(self, job.pid);
    if (stdout.length === 0 && logged.stdout)
        stdout.push(logged.stdout);
    if (stderr.length === 0 && logged.stderr)
        stderr.push(logged.stderr);
    return {
        command: String(command),
        exitCode,
        success: exitCode === 0,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        duration: Date.now() - started,
        timestamp: Date.now(),
    };
}
/**
 * Output a command produced through a log ring instead of the caller's
 * streams — an npm bin, a facet-backed runtime, an adopted long-running
 * process. Attribution follows the process tree rooted at the job's own pid:
 * a start-time window would also sweep up the output of commands issued
 * concurrently against the same session.
 *
 * The ring is read without hydrating from SQL. Every pid here was allocated
 * by the job this call is collecting for, so there is nothing persisted to
 * find; asking anyway made the first exec of every session bootstrap the W9
 * log schema and pay a second durable commit for it (~28 ms).
 */
function collectJobOutput(self, pid) {
    const stdout = [];
    const stderr = [];
    const owned = [self.processes.get(pid), ...self.processes.descendantsOf(pid)];
    for (const entry of owned) {
        if (!entry)
            continue;
        const chunks = self.processes.bufferedLogs(entry.pid);
        for (const chunk of chunks) {
            if (chunk.stream === 'stderr')
                stderr.push(String(chunk.data));
            else
                stdout.push(String(chunk.data));
        }
    }
    return { stdout: stdout.join(''), stderr: stderr.join('') };
}
/**
 * Start a command in the background and return its handle immediately.
 *
 * The command runs for as long as it needs to: the session holds its work
 * open through `ctx.waitUntil`, the same contract a long-running facet uses.
 * Status, incremental output, and termination are read back through the
 * process surface (`listProcesses`, `processLogs`, `killProcess`).
 */
export async function rpcStartProcess(self, command, options = {}) {
    await ensureProgrammaticReady(self, options);
    return withShellState(self, options, true, (scoped) => startOnShell(self, command, options, scoped));
}
async function startOnShell(self, command, options, scoped) {
    const job = startShellJob(self, command, options, { background: true }, scoped);
    const line = String(command);
    notifyTerminalEvent(self.terminal ?? null, {
        type: 'spawn', pid: job.pid, command: line, longRunning: true, attachedTty: false,
    });
    let timeout = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
            self.processes.appendOutput(job.pid, 'stderr', `command timed out after ${options.timeoutMs}ms\n`);
            job.abort();
        }, options.timeoutMs);
    }
    const lifecycle = job.run
        .then((result) => Number(result?.exitCode ?? 0))
        .catch((error) => {
        const message = error instanceof Error ? (error.stack || error.message) : String(error);
        try {
            self.processes.appendOutput(job.pid, 'stderr', message + '\n');
        }
        catch { }
        return 1;
    })
        .then((exitCode) => {
        if (timeout)
            clearTimeout(timeout);
        finishBackgroundJob(self, job.pid, line, exitCode);
    });
    self.ctx.waitUntil?.(lifecycle);
    return {
        command: line,
        pid: job.pid,
        process: serializeProcess(job.entry),
        ports: self.portRegistry.getAll().filter((p) => p.pid === job.pid).map(serializePort),
        startedAt: job.entry.startTime,
    };
}
/**
 * Record a background command's exit — unless a resident facet adopted the
 * pid through the bin-spawn contract. Then the shell call returning is only
 * the handoff, the facet is the live process, and it reports its own exit.
 */
function finishBackgroundJob(self, pid, command, exitCode) {
    if (exitCode === 0 && self.facetManager?.hasResidentProcess(pid))
        return;
    self.processes.exit(pid, exitCode);
    if (!self.processes.getExit(pid))
        self.processes.markExit(pid, exitCode);
    notifyTerminalEvent(self.terminal ?? null, {
        type: 'exit', pid, code: exitCode, command,
    });
}
export async function rpcRunCode(self, code, options = {}) {
    const language = options.language ?? 'javascript';
    if (language === 'python' && options.install === 'ifMissing') {
        await ensureProgrammaticReady(self, { ...options, preinstall: ['python'] });
    }
    else if (language === 'ruby' && options.install === 'ifMissing') {
        await ensureProgrammaticReady(self, { ...options, preinstall: ['ruby'] });
    }
    else {
        await ensureProgrammaticReady(self, options);
    }
    if (language === 'shell')
        return rpcExec(self, code, options);
    if (language === 'python')
        return rpcExec(self, `python -c ${shellQuote(code)}`, options);
    if (language === 'ruby')
        return rpcExec(self, `ruby -e ${shellQuote(code)}`, options);
    return rpcExec(self, `node -e ${shellQuote(code)}`, options);
}
export async function rpcInstallRuntime(self, spec, options = {}) {
    await ensureProgrammaticReady(self);
    return installRuntimeProgrammatic(runtimeDeps(self), String(spec), options);
}
export async function rpcEnsureRuntimes(self, specs, options = {}) {
    await ensureProgrammaticReady(self);
    return ensureRuntimesProgrammatic(runtimeDeps(self), specs.map((s) => String(s)), options);
}
export async function rpcListRuntimes(self) {
    await ensureProgrammaticReady(self);
    return {
        installed: listInstalledRuntimes(self.sqliteFs, getHome(self)),
        available: await listAvailableRuntimes(self.env),
    };
}
export async function rpcListProcesses(self) {
    await ensureProgrammaticReady(self);
    return self.processes.getAll().map((p) => serializeProcess(p));
}
export async function rpcKillProcess(self, pid) {
    await ensureProgrammaticReady(self);
    const n = Number(pid);
    let ok = false;
    if (self._viteShimPid === n) {
        try {
            if (self.cirrusReal?.isRunning) {
                self.cirrusReal.stop(self.ctx);
                self.cirrusReal = null;
            }
            if (self.viteDevServer?.isRunning) {
                self.viteDevServer.stop();
                self.viteDevServer = null;
                try {
                    await self.ctx.storage.delete(VITE_CONFIG_KEY);
                }
                catch { }
            }
        }
        catch { }
        try {
            self.portRegistry.unregisterByPid(n);
        }
        catch { }
        ok = self.processes.kill(n);
        self._viteShimPid = null;
        self._viteShimPort = null;
    }
    else if (self.facetManager) {
        ok = self.facetManager.kill(n);
    }
    else {
        ok = self.processes.kill(n);
    }
    return { ok, pid: n };
}
export async function rpcWriteProcessInput(self, pid, data) {
    await ensureProgrammaticReady(self);
    const n = Number(pid);
    return writeProcessInput(self.processes, n, String(data ?? ''));
}
export async function rpcEndProcessInput(self, pid) {
    await ensureProgrammaticReady(self);
    const n = Number(pid);
    return endProcessInput(self.processes, n);
}
export async function rpcResizeProcess(self, pid, size) {
    await ensureProgrammaticReady(self);
    return resizeProcess(self.processes, Number(pid), Number(size.columns), Number(size.rows));
}
export async function rpcSignalProcess(self, pid, signal) {
    await ensureProgrammaticReady(self);
    return signalProcess(self.processes, Number(pid), String(signal));
}
export async function rpcProcessLogs(self, pid, options = {}) {
    await ensureProgrammaticReady(self);
    const parsed = ProcessLogsOptionsSchema.parse(options);
    const readOptions = {
        cursor: parsed.cursor,
        ...(parsed.bytes !== undefined ? { bytes: parsed.bytes } : { lines: parsed.lines ?? 200 }),
    };
    const chunks = self.processes.readLogs(Number(pid), readOptions);
    return {
        pid: Number(pid),
        chunks: chunks.chunks,
        text: chunks.chunks.map((c) => c.data).join(''),
        cursor: chunks.cursor,
        truncated: chunks.truncated,
        exit: self.processes.getExit(Number(pid)),
    };
}
export async function rpcListPorts(self) {
    await ensureProgrammaticReady(self);
    const entries = self.portRegistry.getAll();
    // Persisted at the moment the embedder is told the value, not at
    // registration: a capability nobody has been handed does not need to
    // survive anything.
    await Promise.all(entries.map((entry) => persistPortCapability(self, entry.port, entry.capability)));
    return entries.map(serializePort);
}
export async function rpcExposePort(self, port) {
    await ensureProgrammaticReady(self);
    const n = Number(port);
    const entry = self.portRegistry.get(n);
    if (entry)
        await persistPortCapability(self, n, entry.capability);
    return {
        port: n,
        listening: !!entry,
        pid: entry?.pid ?? null,
        registeredAt: entry?.registeredAt ?? null,
        capability: entry?.capability ?? null,
    };
}
export async function rpcUnexposePort(self, port) {
    await ensureProgrammaticReady(self);
    const n = Number(port);
    // Before the unregister, so a crash between the two leaves a dead token
    // rather than a live one.
    await clearPortCapability(self, n);
    return { port: n, ok: self.portRegistry.unregister(n) };
}
/**
 * Route an embedder request that carries a port capability. The embedder has
 * authenticated the capability at its edge and stripped its own credentials,
 * so the guest's `Authorization` is preserved through this path and no other.
 */
export async function rpcRouteCapabilityPort(self, port, capability, request, pathname) {
    await ensureProgrammaticReady(self);
    await restorePortCapability(self, port);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        // A 101 cannot cross the DO RPC boundary this entrypoint is reached
        // through; the session fetch route is the one that keeps fetch semantics.
        return new Response('WebSocket upgrades must use the session fetch route', { status: 409 });
    }
    const routed = await self.portRegistry.routeCapabilityRequest(Number(port), String(capability), request, pathname);
    return routed ?? new Response('Not found', { status: 404 });
}
export async function rpcDeleteFile(self, path, options = {}) {
    await ensureProgrammaticReady(self);
    const p = String(path).replace(/^\/+/, '');
    const vfs = self.sqliteFs.as(CRED_KERNEL);
    if (!vfs.exists(p))
        return;
    if (vfs.isDirectory(p)) {
        if (!options.recursive) {
            vfs.rmdir(p);
            return;
        }
        vfs.removeRecursive(p);
        return;
    }
    vfs.unlink(p);
}
export async function rpcDestroy(self, options = {}) {
    self.ensureSqliteFs();
    if (self.sqliteFs.hasExclusiveMutation()) {
        throw new Error('EBUSY: session has an active exclusive filesystem mutation');
    }
    const guardedVfs = self.sqliteFs;
    const destroyLease = guardedVfs.acquireGlobalExclusiveMutation();
    let destroyed = false;
    try {
        const reason = typeof options.reason === 'string' && options.reason.trim()
            ? options.reason.trim().slice(0, 200)
            : null;
        const destroyedAt = Date.now();
        let killed = 0;
        const running = self.processes.getAll()
            .filter((p) => p.state === 'running');
        for (const entry of running) {
            const pid = Number(entry.pid);
            try {
                if (self._viteShimPid === pid) {
                    if (self.cirrusReal?.isRunning)
                        self.cirrusReal.stop(self.ctx);
                    self.cirrusReal = null;
                    if (self.viteDevServer?.isRunning)
                        self.viteDevServer.stop();
                    self.viteDevServer = null;
                    try {
                        await self.ctx.storage.delete(VITE_CONFIG_KEY);
                    }
                    catch { }
                    self._viteShimPid = null;
                    self._viteShimPort = null;
                }
                else if (self.facetManager?.kill?.(pid)) {
                    // facetManager.kill already marks process state and unregisters ports.
                }
                else {
                    try {
                        self.processes.kill(pid);
                    }
                    catch { }
                }
                try {
                    self.portRegistry?.unregisterByPid?.(pid);
                }
                catch { }
                try {
                    if (!self.processes.getExit(pid)) {
                        self.processes.markExit(pid, 137, reason ?? 'destroyed');
                    }
                }
                catch { }
                killed++;
            }
            catch {
                try {
                    self.processes.kill(pid);
                }
                catch { }
                try {
                    self.portRegistry?.unregisterByPid?.(pid);
                }
                catch { }
            }
        }
        try {
            self.processes.flushLogs();
        }
        catch { }
        await quiesceInMemorySessionState(self);
        try {
            await self.ctx.storage.deleteAll();
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(`Nimbus destroy failed while deleting Durable Object storage: ${message}`);
        }
        // deleteAll() does NOT delete a pending alarm (per CF docs). Without
        // this, every destroyed session left an alarm behind that kept booting
        // its DO forever (the W1 janitor cycle), and the accumulated zombie
        // fleet's storage churn intermittently reset live session DOs.
        try {
            await self.ctx.storage.deleteAlarm();
        }
        catch { /* best-effort */ }
        // Tombstone (written AFTER the wipe, deliberately surviving it): a
        // straggler facet RPC can wake this DO again, and its log activity must
        // not re-arm the janitor alarm cycle on a destroyed session — this
        // instance via the flag, any FUTURE instance via the persisted key
        // (hydrated in the constructor).
        self._w1SessionDestroyed = true;
        try {
            await self.ctx.storage.put(SESSION_DESTROYED_KEY, destroyedAt);
        }
        catch { /* best-effort */ }
        // deleteAll also wiped the isolate-generation counter; without
        // re-persisting it the next boot would restart at generation 1, and a
        // straggler facet from a HIGHER pre-destroy generation would classify as
        // current-generation (pid > pidBase) — landing its output on the
        // destroyed/recreated session. Keep {tombstone, isolateGen} consistent.
        try {
            await self.ctx.storage.put(GENERATION_KEY, generation(self.ctx));
        }
        catch { /* best-effort */ }
        resetInMemorySessionState(self);
        destroyed = true;
        return { ok: true, killed, destroyedAt, reason };
    }
    finally {
        if (!destroyed)
            guardedVfs.releaseExclusiveMutation(destroyLease.owner);
    }
}
async function quiesceInMemorySessionState(self) {
    if (self._w9FlushTimer) {
        try {
            clearTimeout(self._w9FlushTimer);
        }
        catch { }
        self._w9FlushTimer = null;
    }
    try {
        self.terminal?.close?.();
    }
    catch { }
    self.terminal = null;
    await closeAcceptedWebSockets(self);
    try {
        self._cirrusHmrWsClients?.clear?.();
    }
    catch { }
    installEmptyProcessState(self, successorGeneration(self));
}
/**
 * The generation the NEXT boot of this session will run as.
 *
 * rpcDestroy re-persists the pre-destroy generation after wiping storage,
 * so `adoptGeneration` reads it back and bumps once — landing here.
 */
function successorGeneration(self) {
    return generation(self.ctx) + 1;
}
/**
 * Install the empty process/port state a destroyed session leaves behind.
 *
 * A brand-new SessionProcessSupervisor starts at pidBase 0, and
 * `isPriorGenerationPid` (session/rpc.ts) counts a pid as prior-generation
 * only when it is at or below that floor. Left at 0, NOTHING classifies as
 * prior-generation — so a straggler facet spawned before the destroy lands
 * its output, exit and stdin pump on the recreated session instead of being
 * refused with an attributed death.
 *
 * Storage already gets this right: the next boot floors pids at
 * `generation * PID_GEN_STRIDE`, which is above every pid the destroyed
 * generation could have issued. This instance has to refuse exactly the
 * same set for the rest of its life, so it takes the same floor.
 */
function installEmptyProcessState(self, generation) {
    self.processes = new SessionProcessSupervisor();
    self.processes.setPidBase(generation * PID_GEN_STRIDE);
    self.portRegistry = new PortRegistry();
    self._w9PersistWired = false;
}
async function closeAcceptedWebSockets(self) {
    const getWebSockets = self.ctx.getWebSockets;
    if (typeof getWebSockets !== 'function')
        return;
    let sockets = [];
    try {
        sockets = getWebSockets.call(self.ctx);
    }
    catch {
        sockets = [];
    }
    for (const ws of sockets) {
        try {
            ws.close(1000, 'session destroyed');
        }
        catch { }
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        try {
            sockets = getWebSockets.call(self.ctx);
        }
        catch {
            sockets = [];
        }
        if (sockets.length === 0)
            return;
        for (const ws of sockets) {
            try {
                ws.close(1000, 'session destroyed');
            }
            catch { }
        }
        await delay(25);
    }
}
function resetInMemorySessionState(self) {
    try {
        self._cirrusHmrWsClients?.clear?.();
    }
    catch { }
    try {
        self.terminal?.close?.();
    }
    catch { }
    self.sqliteFs = null;
    self.kernel = null;
    self.shell = null;
    self.shellProcessPid = null;
    self.terminal = null;
    self.facetManager = null;
    self.facetProcessManager = null;
    self.esbuildService = null;
    self.viteDevServer = null;
    self.cirrusReal = null;
    self._cirrusHmrWsClients = null;
    self.nimbusWrangler = null;
    self.npmInstaller = null;
    self.fetchProxyEntrypoint = null;
    self.runtimeFsBridges?.clear();
    self.runtimeFsBridges = null;
    self._cpRegistry = null;
    self._viteShimPid = null;
    self._viteShimPort = null;
    self.sessionBasePath = '';
    self.sessionBasePathHydrated = false;
    self.wranglerAliasBannerShown = false;
    self._b4Phase = 'drained';
    // Adopt the generation the next boot will derive from the counter
    // rpcDestroy just re-persisted, so the in-memory pid floor and the
    // persisted one agree. Deliberately left unpersisted: storage keeps the
    // pre-destroy value, and adoptGeneration re-derives this one from it.
    const successor = successorGeneration(self);
    installEmptyProcessState(self, successor);
    self._w9SchemaInit = false;
    assumeGeneration(self.ctx, successor);
    try {
        self._w9WireProcessLogPersist?.();
    }
    catch { }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function serializeProcess(p) {
    if (!p)
        return null;
    return {
        pid: p.pid,
        command: p.command,
        argv: p.argv,
        cwd: p.cwd,
        state: p.state,
        exitCode: p.exitCode,
        startTime: p.startTime,
        endTime: p.endTime,
        longRunning: p.longRunning === true,
        attachedTty: p.attachedTty === true,
    };
}
function serializePort(p) {
    return {
        port: Number(p.port),
        pid: Number(p.pid),
        registeredAt: Number(p.registeredAt),
        capability: String(p.capability),
    };
}
function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
