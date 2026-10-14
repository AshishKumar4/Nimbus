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
import { textSink } from '@nimbus-sh/core/_shared/bytes.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { shellEscape } from '@nimbus-sh/core/_shared/shell-quote.js';
import { isVfsCred, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { execIdField, type ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace/nimbus-workspace.js';
import { DEV_SERVER_KEY_PREFIX } from './keys.js';
import type { DevServerRestoreFailure } from './helpers.js';
import { readPortCapability, readoptCapability, type PortCapabilityHost } from './port-capability.js';

const DevServerRecordSchema = z.object({
  /** The line its command ran, and what its process was spawned with. */
  command: z.string().min(1),
  argv: z.array(z.string()),
  cwd: z.string(),
  cred: z.custom<VfsCred>(isVfsCred),
  execId: z.string().optional(),
  env: z.record(z.string(), z.string()),
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
type DevServerRecord = z.infer<typeof DevServerRecordSchema>;

/** How a dev server's process is spawned: the command line it runs, and the process's argv, cwd, credential and exec id. */
export interface DevServerSpawn {
  command: string;
  argv: string[];
  cwd: string;
  cred: VfsCred;
  execId?: string;
}

/** The command a dev server is started by: its process, and the pid a caller handed it to adopt. */
export type DevServerCommandContext = Pick<CommandContext, 'pid' | 'cred' | 'args' | 'cwd'> & {
  __nimbusBinSpawn?: { skipSpawn?: boolean; callerPid?: number };
};

/** Where a dev server process's record is kept. */
export interface DevServerHost {
  readonly ctx: { readonly storage: DurableObjectStorage };
  readonly processes: SessionProcessSupervisor;
  readonly portRegistry: PortRegistry;
}

const recordKey = (pid: number): string => `${DEV_SERVER_KEY_PREFIX}${pid}`;

/** The spawn `entry` was made with. */
export function spawnOf(entry: ProcessEntry): DevServerSpawn {
  return { command: entry.command, argv: [...entry.argv], cwd: entry.cwd, cred: entry.cred, ...execIdField(entry) };
}

/**
 * How the dev server the command `name` starts runs: as the process its
 * caller handed it (bin-spawn: a script's wrapper, an SDK launch, a restore),
 * else as a child of the command with the command's line, argv and cwd.
 */
export function devServerSpawn(processes: SessionProcessSupervisor, name: string, ctx: DevServerCommandContext): { spawn: DevServerSpawn; handed: ProcessEntry | undefined } {
  const binSpawn = ctx.__nimbusBinSpawn;
  const handed = binSpawn?.skipSpawn && binSpawn.callerPid != null ? processes.get(binSpawn.callerPid) : undefined;
  if (handed !== undefined) return { spawn: spawnOf(handed), handed };
  const argv = [name, ...ctx.args];
  return { spawn: { command: argv.map(shellEscape).join(' '), argv, cwd: ctx.cwd, cred: ctx.cred, ...execIdField(processes.get(ctx.pid)) }, handed };
}

/** The dev server's process (devServerSpawn): the one handed it, now long-running, or a new child of the command. */
export function devServerProcess(processes: SessionProcessSupervisor, name: string, ctx: DevServerCommandContext): { entry: ProcessEntry; adopted: boolean } {
  const { spawn, handed } = devServerSpawn(processes, name, ctx);
  if (handed !== undefined) {
    processes.setLongRunning(handed.pid);
    return { entry: handed, adopted: true };
  }
  const entry = processes.spawn(spawn.command, spawn.argv, spawn.cwd, { longRunning: true, parentPid: ctx.pid, cred: spawn.cred, ...execIdField(spawn) });
  return { entry, adopted: false };
}

async function release(host: Pick<DevServerHost, 'ctx'>, key: string): Promise<void> {
  await host.ctx.storage.delete(key);
  await host.ctx.storage.sync();
}

/**
 * Record how the dev server behind `pid` was spawned, with the environment
 * its command was given and the ports it serves now, until `pid` ends.
 * Synced, so a reset right after it still finds it; a process that ended
 * meanwhile leaves none.
 */
export async function recordDevServer(host: DevServerHost, pid: number, spawn: DevServerSpawn & { env: Readonly<Record<string, string>>; root: string }): Promise<void> {
  const key = recordKey(pid);
  const record: DevServerRecord = {
    command: spawn.command, argv: [...spawn.argv], cwd: spawn.cwd, cred: spawn.cred, ...execIdField(spawn),
    env: { ...spawn.env }, root: spawn.root, ports: host.portRegistry.getRouteablePortsByPid(pid),
  };
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

/** What restoring the session's dev servers needs: its shell, to run each command again. */
export interface DevServerRestoreHost extends DevServerHost {
  readonly ctx: DevServerHost['ctx'] & PortCapabilityHost['ctx'];
  readonly runtimeWorkspace: NimbusWorkspace | null;
  ensureRuntimeReady(): Promise<void>;
}

/** Each host's restore, once: the requests and the start that meet it wait on it. */
const restores = new WeakMap<object, Promise<readonly DevServerRestoreFailure[]>>();

/**
 * Run again, once, each dev server a previous incarnation of the session
 * recorded, one at a time; every caller waits on that one run. A server whose
 * command fails is not tried again: the failure is answered, and its
 * process's log says why.
 */
export function restoreDevServers(host: DevServerRestoreHost): Promise<readonly DevServerRestoreFailure[]> {
  let restore = restores.get(host);
  if (restore === undefined) {
    restore = restoreAll(host);
    restores.set(host, restore);
    // One that could not read the records is tried again by the next caller.
    restore.catch(() => { if (restores.get(host) === restore) restores.delete(host); });
  }
  return restore;
}

async function restoreAll(host: DevServerRestoreHost): Promise<readonly DevServerRestoreFailure[]> {
  const base = host.processes.pidBase;
  const rows = await host.ctx.storage.list({ prefix: DEV_SERVER_KEY_PREFIX });
  const failures: DevServerRestoreFailure[] = [];
  for (const [key, value] of rows) {
    const pid = Number(key.slice(DEV_SERVER_KEY_PREFIX.length));
    // This incarnation's own: running, or released by its end.
    if (pid > base) continue;
    const failure = await restoreOne(host, key, pid, DevServerRecordSchema.safeParse(value));
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

async function restoreOne(
  host: DevServerRestoreHost, key: string, from: number, parsed: ReturnType<typeof DevServerRecordSchema.safeParse>,
): Promise<DevServerRestoreFailure | null> {
  if (!parsed.success) {
    await release(host, key);
    return { command: '(unreadable)', cwd: '', pid: null, reason: `its record could not be read: ${parsed.error.message}` };
  }
  const record = parsed.data;
  if (record.restoring) {
    await release(host, key);
    return { command: record.command, cwd: record.cwd, pid: null, reason: 'its start after an earlier restart of the session did not finish' };
  }
  await host.ctx.storage.put(key, { ...record, restoring: true });
  await host.ctx.storage.sync();
  // The links handed out for its ports: a registration that is not a restore retires them.
  const capabilities = new Map<number, string>();
  for (const port of record.ports) {
    const capability = await readPortCapability(host, port);
    if (capability !== null) capabilities.set(port, capability);
  }
  let failure: DevServerRestoreFailure | null;
  try {
    await host.ensureRuntimeReady();
    failure = await runAgain(host, record, from);
  } catch (error) {
    failure = { command: record.command, cwd: record.cwd, pid: null, reason: errorText(error) };
  } finally {
    await release(host, key);
  }
  for (const [port, capability] of capabilities) {
    if (host.portRegistry.has(port)) await readoptCapability(host, port, capability);
  }
  return failure;
}

/**
 * The recorded line, run once more as it was: under a process spawned as the
 * recorded one was, in its directory, with its environment. The command
 * adopts that process as its server's, as it adopts a script wrapper's; one
 * that hands its server to a process of its own leaves this one to exit.
 */
async function runAgain(host: DevServerRestoreHost, record: DevServerRecord, from: number): Promise<DevServerRestoreFailure | null> {
  const workspace = host.runtimeWorkspace;
  if (workspace === null) throw new Error('the session has no shell to run it in');
  const processes = host.processes;
  const entry = processes.spawn(record.command, record.argv, record.cwd, {
    longRunning: true, cred: record.cred, ...execIdField(record), restartedFrom: { pid: from, cause: 'session-restart' },
  });
  const pid = entry.pid;
  processes.appendOutput(pid, 'stderr', `[nimbus] the session restarted: running \`${record.command}\` again in ${record.cwd}\n`);
  const shell = workspace.shellFor(pid, { cwd: record.cwd, env: record.env });
  let stderr = '';
  const keep = textSink((text) => { stderr = (stderr + text).slice(-2000); });
  const stop = new AbortController();
  const stopped = processes.holdWork(pid, (reason) => stop.abort(reason), stop.signal);
  let exitCode = 1;
  let reason = '';
  try {
    const result = await shell.execute(record.command, {
      onStdout: (data) => processes.appendOutputBytes(pid, 'stdout', data),
      onStderr: async (data) => {
        await keep(data);
        await processes.appendOutputBytes(pid, 'stderr', data);
      },
      commandContext: {
        pid,
        cred: entry.cred,
        setUmask: (mask: number) => processes.setUmask(pid, mask),
        __nimbusBinSpawn: { skipSpawn: true, callerPid: pid, command: record.command, forceLongRunning: true },
      },
      signal: stop.signal,
    });
    exitCode = result.exitCode;
    reason = stderr.trim().split('\n').slice(-6).join('\n');
  } catch (error) {
    reason = errorText(error);
    processes.appendOutput(pid, 'stderr', `${reason}\n`);
  } finally {
    try {
      await shell.closeDescriptors();
    } finally {
      stopped();
    }
  }
  if (exitCode === 0) {
    if (!await recorded(host, pid)) processes.exit(pid, 0);
    return null;
  }
  processes.appendOutput(pid, 'stderr', `[nimbus] \`${record.command}\` did not start again (exit ${exitCode}); run it again in ${record.cwd} to start the server\n`);
  processes.exit(pid, exitCode);
  return { command: record.command, cwd: record.cwd, pid, reason: reason ? `exit ${exitCode}: ${reason}` : `exit ${exitCode}` };
}

async function recorded(host: DevServerHost, pid: number): Promise<boolean> {
  return (await host.ctx.storage.get(recordKey(pid))) !== undefined;
}
