/**
 * session/dev-servers.ts — a dev server the session runs itself, recorded so
 * that a new incarnation of the session runs it again.
 *
 * `vite`, `vite preview`, real Vite and `wrangler dev` serve from the session:
 * each server lives in the session's memory, or in a facet the session holds,
 * behind one long-running process. A session's object is re-created routinely
 * (an idle one within about two minutes, measured) and by an instance reset,
 * and the server is gone with it. So while that process runs, its spawn is
 * recorded here, synced: the command line, argv, cwd, credential and exec id
 * it was started with, the environment its command was given, the root it
 * serves and the ports it serves on. The process's end, however it comes,
 * releases the record, and nothing else does. A new incarnation runs each
 * recorded command again once (restoreDevServers), as a restarted service
 * runs: the same line under a process with the same spawn, which the command
 * adopts, so it reads its configuration afresh and serves as it did. The
 * restore knows no program; it runs what was recorded.
 *
 * A command's environment is recorded as the command was given it, as the
 * resident launch journal records a recipe's (facets/manager.ts): a launch
 * overlay ($PORT, $NIMBUS_APP under a reservation) is applied only to facet
 * launches, so it is never in it.
 */
import { z } from 'zod/v4';
import { SinkWriter } from '@nimbus-sh/core/_shared/byte-stream.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { shellEscape } from '@nimbus-sh/core/_shared/shell-quote.js';
import { isVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { execIdField } from '@nimbus-sh/core/runtime/process-table.js';
import { DEV_SERVER_KEY_PREFIX } from './keys.js';
import { readPortCapability, readoptCapability } from './port-capability.js';
import { relaunchEnv } from '../facets/process-env.js';
const DevServerRecordSchema = z.object({
    /** The line its command ran, and what its process was spawned with. */
    command: z.string().min(1),
    argv: z.array(z.string()),
    cwd: z.string(),
    cred: z.custom(isVfsCred),
    execId: z.string().optional(),
    /** What an earlier release recorded: its command's environment, now kept where the host keeps environments, if anywhere. */
    env: z.record(z.string(), z.string()).optional(),
    /** What the server serves (a project or a build), for whoever reads the record. */
    root: z.string(),
    /** The ports it served: the links handed out for them are taken back by the restored server. */
    ports: z.array(z.number().int()),
    /**
     * A restore of it began: written, synced, before the command runs again.
     * An instance that ends during that run leaves it set, and the next one
     * reports the restore as unfinished rather than running it again: a
     * command whose run ends its session would otherwise restart it forever.
     */
    restoring: z.literal(true).optional(),
});
const recordKey = (pid) => `${DEV_SERVER_KEY_PREFIX}${pid}`;
/** The spawn `entry` was made with. */
export function spawnOf(entry) {
    return { command: entry.command, argv: [...entry.argv], cwd: entry.cwd, cred: entry.cred, ...execIdField(entry) };
}
/**
 * How the dev server the command `name` starts runs: as the process its
 * caller handed it (bin-spawn: a script's wrapper, an SDK launch, a restore),
 * else as a child of the command with the command's line, argv and cwd.
 */
export function devServerSpawn(processes, name, ctx) {
    const binSpawn = ctx.__nimbusBinSpawn;
    const handed = binSpawn?.skipSpawn && binSpawn.callerPid != null ? processes.get(binSpawn.callerPid) : undefined;
    if (handed !== undefined)
        return { spawn: spawnOf(handed), handed };
    const argv = [name, ...ctx.args];
    return { spawn: { command: argv.map(shellEscape).join(' '), argv, cwd: ctx.cwd, cred: ctx.cred, ...execIdField(processes.get(ctx.pid)) }, handed };
}
/**
 * A dev server lives as long as its process `pid`: the process's end, however
 * it comes, runs `stop`, and until then the session holds the server as the
 * process's work (a kill reaches it, and a caller that handed the process to
 * the command sees it still served).
 */
export function bindDevServer(processes, pid, stop) {
    processes.setTerminator(pid, stop);
    processes.subscribeTerminal(pid, stop);
}
/**
 * The dev server's process (devServerSpawn), bound to it (bindDevServer): the
 * one handed it, now long-running, or a new child of the command; null when
 * the one handed it has already ended.
 */
export function devServerProcess(processes, name, ctx, stop) {
    const { spawn, handed } = devServerSpawn(processes, name, ctx);
    if (handed !== undefined && handed.state !== 'running')
        return null;
    if (handed !== undefined)
        processes.setLongRunning(handed.pid);
    const entry = handed ?? processes.spawn(spawn.command, spawn.argv, spawn.cwd, { longRunning: true, parentPid: ctx.pid, cred: spawn.cred, ...execIdField(spawn) });
    bindDevServer(processes, entry.pid, stop);
    return { entry, adopted: handed !== undefined };
}
/** Whether `pid` runs inside a restore: it, or a process above it, restarts one the session lost. */
function inRestore(processes, pid) {
    for (let at = pid === undefined ? undefined : processes.get(pid); at !== undefined; at = at.parentPid === undefined ? undefined : processes.get(at.parentPid)) {
        if (at.restartedFrom?.cause === 'session-restart')
            return true;
    }
    return false;
}
/**
 * Wait for the restore of the previous incarnation's dev servers before a
 * command starts or stops one, so the user's action comes after it rather
 * than being undone by it. A command the restore itself runs does not wait.
 */
export async function afterDevServerRestore(host, processes, ctx) {
    if (inRestore(processes, ctx.pid) || inRestore(processes, ctx.__nimbusBinSpawn?.callerPid))
        return;
    await host.restoreDevServers();
}
async function release(host, key) {
    await host.ctx.storage.delete(key);
    await host.processEnv.keepProcessEnv?.forget(key);
    await host.ctx.storage.sync();
}
/**
 * Record how the dev server behind `pid` was spawned and the ports it serves
 * now, until `pid` ends; its command's environment goes to the host, if it
 * keeps environments, never into the record. Synced, so a reset right after
 * it still finds it; a process that ended meanwhile leaves none.
 */
export async function recordDevServer(host, pid, spawn) {
    const key = recordKey(pid);
    const record = {
        command: spawn.command, argv: [...spawn.argv], cwd: spawn.cwd, cred: spawn.cred, ...execIdField(spawn),
        root: spawn.root, ports: host.portRegistry.getRouteablePortsByPid(pid),
    };
    await host.processEnv.keepProcessEnv?.remember(key, { ...spawn.env });
    await host.ctx.storage.put(key, record);
    await host.ctx.storage.sync();
    if (host.processes.get(pid)?.state !== 'running') {
        await release(host, key);
        return;
    }
    host.processes.subscribeTerminal(pid, () => {
        release(host, key).catch((error) => console.warn(`[dev-servers] the record of pid ${pid} was not released: ${errorText(error)}`));
    });
}
/**
 * Each host's restore, once per incarnation of its session (its pid range):
 * the requests and the commands that meet it wait on it. A destroy makes the
 * session again with a range of its own, which ends the restore under way
 * and gives the new session one of its own.
 */
const restores = new WeakMap();
/**
 * Run again, once, each dev server a previous incarnation of the session
 * recorded, one at a time; every caller waits on that one run. A server whose
 * command fails is not tried again: the failure is answered, and its
 * process's log says why.
 */
export function restoreDevServers(host) {
    const base = host.processes.pidBase;
    let restore = restores.get(host);
    if (restore === undefined || restore.base !== base) {
        restore = { base, done: restoreAll(host, base) };
        restores.set(host, restore);
        // One that could not read the records is tried again by the next caller.
        const tried = restore;
        tried.done.catch(() => { if (restores.get(host) === tried)
            restores.delete(host); });
    }
    return restore.done;
}
async function restoreAll(host, base) {
    // The session it began in is still the host's: a destroy made it again, and
    // then this restore runs nothing more and writes nothing but releases.
    const ours = () => host.processes.pidBase === base;
    const rows = await host.ctx.storage.list({ prefix: DEV_SERVER_KEY_PREFIX });
    const failures = [];
    for (const [key, value] of rows) {
        if (!ours())
            break;
        const pid = Number(key.slice(DEV_SERVER_KEY_PREFIX.length));
        // This incarnation's own: running, or released by its end.
        if (pid > base)
            continue;
        const failure = await restoreOne(host, ours, key, pid, DevServerRecordSchema.safeParse(value));
        if (failure !== null)
            failures.push(failure);
    }
    return failures;
}
async function restoreOne(host, ours, key, from, parsed) {
    if (!parsed.success) {
        await release(host, key);
        return { command: '(unreadable)', cwd: '', pid: null, reason: `its record could not be read: ${parsed.error.message}` };
    }
    const record = parsed.data;
    if (record.restoring) {
        await release(host, key);
        return { command: record.command, cwd: record.cwd, pid: null, reason: 'its start after an earlier restart of the session did not finish' };
    }
    if (!ours())
        return null;
    // A record an earlier release wrote holds its environment: kept where the
    // host keeps environments, and not written back.
    const { env: held, ...kept } = record;
    if (held !== undefined)
        await host.processEnv.keepProcessEnv?.remember(key, held);
    await host.ctx.storage.put(key, { ...kept, restoring: true });
    await host.ctx.storage.sync();
    // The links handed out for its ports: a registration that is not a restore retires them.
    const capabilities = new Map();
    for (const port of record.ports) {
        const capability = await readPortCapability(host, port);
        if (capability !== null)
            capabilities.set(port, capability);
    }
    let failure = null;
    try {
        await host.ensureRuntimeReady();
        // A destroy that came meanwhile made the session again: nothing of this one runs in it.
        if (ours())
            failure = await runAgain(host, record, from, await relaunchEnv(host.processEnv.resolveProcessEnv, { pid: from, cred: record.cred, record: key, ...execIdField(record) }));
    }
    catch (error) {
        failure = { command: record.command, cwd: record.cwd, pid: null, reason: errorText(error) };
    }
    finally {
        await release(host, key);
    }
    for (const [port, capability] of capabilities) {
        if (ours() && host.portRegistry.has(port))
            await readoptCapability(host, port, capability);
    }
    return failure;
}
/**
 * The recorded line, run once more as it was: under a process spawned as the
 * recorded one was, in its directory, with its environment. The command
 * adopts that process as its server's, as it adopts a script wrapper's; one
 * that hands its server to a process of its own leaves this one to exit.
 */
async function runAgain(host, record, from, env) {
    const workspace = host.runtimeWorkspace;
    if (workspace === null)
        throw new Error('the session has no shell to run it in');
    const processes = host.processes;
    const entry = processes.spawn(record.command, record.argv, record.cwd, {
        longRunning: true, cred: record.cred, ...execIdField(record), restartedFrom: { pid: from, cause: 'session-restart' },
    });
    const pid = entry.pid;
    processes.appendOutput(pid, 'stderr', `[nimbus] the session restarted: running \`${record.command}\` again in ${record.cwd}\n`);
    const shell = workspace.shellFor(pid, { cwd: record.cwd, env, inheritEnv: false });
    let stderr = '';
    const keep = new SinkWriter({ write: (text) => { stderr = (stderr + text).slice(-2000); } });
    const stop = new AbortController();
    const stopped = processes.holdWork(pid, (reason) => stop.abort(reason), stop.signal);
    let exitCode = 1;
    let reason = '';
    try {
        const result = await shell.execute(record.command, {
            onStdout: (data) => processes.appendOutputBytes(pid, 'stdout', data),
            onStderr: async (data) => {
                await keep.write(data);
                await processes.appendOutputBytes(pid, 'stderr', data);
            },
            commandContext: {
                pid,
                cred: entry.cred,
                setUmask: (mask) => processes.setUmask(pid, mask),
                __nimbusBinSpawn: { skipSpawn: true, callerPid: pid, command: record.command, forceLongRunning: true },
            },
            signal: stop.signal,
        });
        exitCode = result.exitCode;
    }
    catch (error) {
        reason = errorText(error);
        processes.appendOutput(pid, 'stderr', `${reason}\n`);
    }
    finally {
        await keep.end();
        try {
            await shell.closeDescriptors();
        }
        finally {
            stopped();
        }
    }
    reason ||= stderr.trim().split('\n').slice(-6).join('\n');
    if (exitCode === 0) {
        // Not adopted: its server runs as a process of its own (real Vite's), or it served nothing.
        if (!processes.runsWork(pid))
            processes.exit(pid, 0);
        return null;
    }
    processes.appendOutput(pid, 'stderr', `[nimbus] \`${record.command}\` did not start again (exit ${exitCode}); run it again in ${record.cwd} to start the server\n`);
    processes.exit(pid, exitCode);
    return { command: record.command, cwd: record.cwd, pid, reason: reason ? `exit ${exitCode}: ${reason}` : `exit ${exitCode}` };
}
