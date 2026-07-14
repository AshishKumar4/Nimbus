/**
 * session/programmatic.ts - public sandbox RPC helpers.
 *
 * These helpers are called by NimbusSession one-line delegators so the
 * Durable Object exposes a typed, programmatic sandbox surface without
 * duplicating the interactive terminal boot path.
 */
import { ensureRuntimesProgrammatic, installRuntimeProgrammatic, listAvailableRuntimes, listInstalledRuntimes, } from '../runtime/package-manager.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import { PortRegistry } from '../runtime/port-registry.js';
import { endProcessInput, resizeProcess, signalProcess, writeProcessInput, } from '../runtime/process-input-routing.js';
import { z } from 'zod/v4';
import { SESSION_DESTROYED_KEY, W9_ISOLATE_GEN_KEY } from './keys.js';
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
        self.initSession(makeHeadlessWebSocket());
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
export async function rpcExec(self, command, options = {}) {
    await ensureProgrammaticReady(self, options);
    const shell = self.shell;
    if (!shell)
        throw new Error('Nimbus shell did not initialize');
    const stdout = [];
    const stderr = [];
    const started = Date.now();
    const beforePids = new Set(self.processes.getAll().map((p) => p.pid));
    const controller = new AbortController();
    let timeout = null;
    let timedOut = false;
    const run = shell.execute(String(command), {
        cwd: options.cwd ?? shell.getCwd?.() ?? '/home/user',
        env: { ...(shell.getEnv?.() ?? {}), ...(options.env ?? {}) },
        onStdout: (d) => stdout.push(String(d)),
        onStderr: (d) => stderr.push(String(d)),
        signal: controller.signal,
        stdin: options.stdin,
    });
    const result = options.timeoutMs && options.timeoutMs > 0
        ? await Promise.race([
            run,
            new Promise((resolve) => {
                timeout = setTimeout(() => {
                    timedOut = true;
                    try {
                        controller.abort();
                    }
                    catch { }
                    resolve({ exitCode: 124 });
                }, options.timeoutMs);
            }),
        ])
        : await run;
    if (timeout)
        clearTimeout(timeout);
    const exitCode = Number(result.exitCode ?? (timedOut ? 124 : 0));
    if (timedOut) {
        stderr.push(`command timed out after ${options.timeoutMs}ms\n`);
    }
    const logged = collectNewProcessOutput(self, beforePids);
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
function collectNewProcessOutput(self, beforePids) {
    const created = self.processes.getAll()
        .filter((p) => !beforePids.has(p.pid))
        .sort((a, b) => a.startTime - b.startTime);
    const stdout = [];
    const stderr = [];
    for (const entry of created) {
        const chunks = self.processes.allLogs(Number(entry.pid));
        for (const chunk of chunks) {
            if (chunk.stream === 'stderr')
                stderr.push(String(chunk.data));
            else
                stdout.push(String(chunk.data));
        }
    }
    return { stdout: stdout.join(''), stderr: stderr.join('') };
}
export async function rpcStartProcess(self, command, options = {}) {
    await ensureProgrammaticReady(self, options);
    const before = new Set(self.processes.getAll().map((p) => p.pid));
    const result = await rpcExec(self, command, options);
    const created = self.processes.getAll()
        .filter((p) => !before.has(p.pid))
        .sort((a, b) => b.startTime - a.startTime);
    const running = created.find((p) => p.state === 'running') ?? null;
    const pid = running?.pid ?? created[0]?.pid ?? null;
    const process = pid != null ? serializeProcess(self.processes.get(pid)) : null;
    const ports = pid != null
        ? self.portRegistry.getAll().filter((p) => p.pid === pid).map(serializePort)
        : [];
    return { ...result, pid, process, ports };
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
                    await self.ctx.storage.delete('vite-config');
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
    return self.portRegistry.getAll().map(serializePort);
}
export async function rpcExposePort(self, port) {
    await ensureProgrammaticReady(self);
    const n = Number(port);
    const entry = self.portRegistry.get(n);
    return {
        port: n,
        listening: !!entry,
        pid: entry?.pid ?? null,
        registeredAt: entry?.registeredAt ?? null,
    };
}
export async function rpcUnexposePort(self, port) {
    await ensureProgrammaticReady(self);
    const n = Number(port);
    return { port: n, ok: self.portRegistry.unregister(n) };
}
export async function rpcDeleteFile(self, path, options = {}) {
    await ensureProgrammaticReady(self);
    const p = String(path).replace(/^\/+/, '');
    if (!self.sqliteFs.exists(p))
        return;
    if (self.sqliteFs.isDirectory(p)) {
        if (!options.recursive) {
            self.sqliteFs.rmdir(p);
            return;
        }
        rmrf(self.sqliteFs, p);
        return;
    }
    self.sqliteFs.unlink(p);
}
export async function rpcDestroy(self, options = {}) {
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
                    await self.ctx.storage.delete('vite-config');
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
        await self.ctx.storage.put(W9_ISOLATE_GEN_KEY, self._w9IsolateGen ?? 0);
    }
    catch { /* best-effort */ }
    resetInMemorySessionState(self);
    return { ok: true, killed, destroyedAt, reason };
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
    self.processes = new SessionProcessSupervisor();
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
    self.runtimeFsBridge = null;
    self._cpRegistry = null;
    self._viteShimPid = null;
    self._viteShimPort = null;
    self.sessionBasePath = '';
    self.sessionBasePathHydrated = false;
    self.wranglerAliasBannerShown = false;
    self._b4Phase = 'drained';
    self.processes = new SessionProcessSupervisor();
    self.portRegistry = new PortRegistry();
    self._w9PersistWired = false;
    self._w9SchemaInit = false;
    self._w9IsolateGen = 0;
    self._w9IsolateGenPersisted = false;
    try {
        self._w9WireProcessLogPersist?.();
    }
    catch { }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function rmrf(vfs, path) {
    for (const entry of vfs.readdir(path)) {
        const child = `${path}/${entry.name}`;
        if (entry.type === 'directory')
            rmrf(vfs, child);
        else
            vfs.unlink(child);
    }
    vfs.rmdir(path);
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
    };
}
function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
