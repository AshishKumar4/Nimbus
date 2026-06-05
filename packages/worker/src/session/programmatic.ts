/**
 * session/programmatic.ts - public sandbox RPC helpers.
 *
 * These helpers are called by NimbusSession one-line delegators so the
 * Durable Object exposes a typed, programmatic sandbox surface without
 * duplicating the interactive terminal boot path.
 */

import {
  ensureRuntimesProgrammatic,
  installRuntimeProgrammatic,
  listAvailableRuntimes,
  listInstalledRuntimes,
} from '../runtime/package-manager.js';
import type { ProcessEntry } from '../runtime/process-table.js';

type Host = any;

export interface ProgrammaticReadyOptions {
  preinstall?: string[];
}

export interface ProgrammaticExecOptions extends ProgrammaticReadyOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface ProgrammaticExecResult {
  command: string;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
  duration: number;
  timestamp: number;
}

export interface ProgrammaticStartResult extends ProgrammaticExecResult {
  pid: number | null;
  process: SerializedProcess | null;
  ports: SerializedPort[];
}

export interface SerializedProcess {
  pid: number;
  command: string;
  argv: string[];
  cwd: string;
  state: string;
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
  longRunning: boolean;
}

export interface SerializedPort {
  port: number;
  pid: number;
  registeredAt: number;
}

function makeHeadlessWebSocket(): WebSocket {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const ws = {
    readyState: 1,
    send(_data: string) {},
    close() {
      (ws as any).readyState = 3;
      for (const cb of listeners.get('close') ?? []) {
        try { cb(); } catch {}
      }
    },
    accept() {},
    addEventListener(type: string, cb: (event?: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener(type: string, cb: (event?: unknown) => void) {
      listeners.get(type)?.delete(cb);
    },
    serializeAttachment(_value: unknown) {},
    deserializeAttachment() { return { kind: 'programmatic' }; },
  };
  return ws as unknown as WebSocket;
}

function getHome(self: Host): string {
  try {
    const envHome = self.shell?.env?.HOME;
    if (envHome) return String(envHome);
  } catch {}
  try {
    const shellEnv = self.shell?.getEnv?.();
    if (shellEnv?.HOME) return String(shellEnv.HOME);
  } catch {}
  return '/home/user';
}

function runtimeDeps(self: Host) {
  self.ensureSqliteFs();
  return {
    env: self.env as any,
    vfs: self.sqliteFs!,
    registry: self._cpRegistry,
    getHome: () => getHome(self),
  };
}

export async function ensureProgrammaticReady(
  self: Host,
  options: ProgrammaticReadyOptions = {},
): Promise<{ ok: true; preinstalled: string[] }> {
  if (!self.shell) {
    self.initSession(makeHeadlessWebSocket());
    // Programmatic boot owns no real terminal socket. Mark the session
    // drained so a later browser /ws can warm-join instead of 409ing.
    self._b4Phase = 'drained';
  } else {
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

export async function rpcExec(
  self: Host,
  command: string,
  options: ProgrammaticExecOptions = {},
): Promise<ProgrammaticExecResult> {
  await ensureProgrammaticReady(self, options);
  const shell = self.shell;
  if (!shell) throw new Error('Nimbus shell did not initialize');

  const stdout: string[] = [];
  const stderr: string[] = [];
  const started = Date.now();
  const beforePids = new Set<number>(
    self.processTable.getAll().map((p: ProcessEntry) => p.pid),
  );
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const run = shell.execute(String(command), {
    cwd: options.cwd ?? shell.getCwd?.() ?? '/home/user',
    env: { ...(shell.getEnv?.() ?? {}), ...(options.env ?? {}) },
    onStdout: (d: string) => stdout.push(String(d)),
    onStderr: (d: string) => stderr.push(String(d)),
    signal: controller.signal,
    stdin: options.stdin,
  });

  const result = await (options.timeoutMs && options.timeoutMs > 0
    ? Promise.race([
        run,
        new Promise<{ exitCode: number }>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            try { controller.abort(); } catch {}
            resolve({ exitCode: 124 });
          }, options.timeoutMs);
        }),
      ])
    : run);

  if (timeout) clearTimeout(timeout);

  const exitCode = Number((result as any)?.exitCode ?? (timedOut ? 124 : 0));
  if (timedOut) {
    stderr.push(`command timed out after ${options.timeoutMs}ms\n`);
  }

  const logged = collectNewProcessOutput(self, beforePids);
  if (stdout.length === 0 && logged.stdout) stdout.push(logged.stdout);
  if (stderr.length === 0 && logged.stderr) stderr.push(logged.stderr);

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

function collectNewProcessOutput(
  self: Host,
  beforePids: Set<number>,
): { stdout: string; stderr: string } {
  const created = self.processTable.getAll()
    .filter((p: ProcessEntry) => !beforePids.has(p.pid))
    .sort((a: ProcessEntry, b: ProcessEntry) => a.startTime - b.startTime);
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const entry of created) {
    const chunks = self.processLogs.all(Number(entry.pid));
    for (const chunk of chunks) {
      if (chunk.stream === 'stderr') stderr.push(String(chunk.data));
      else stdout.push(String(chunk.data));
    }
  }
  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

export async function rpcStartProcess(
  self: Host,
  command: string,
  options: ProgrammaticExecOptions = {},
): Promise<ProgrammaticStartResult> {
  await ensureProgrammaticReady(self, options);
  const before = new Set<number>(
    self.processTable.getAll().map((p: ProcessEntry) => p.pid),
  );
  const result = await rpcExec(self, command, options);
  const created = self.processTable.getAll()
    .filter((p: ProcessEntry) => !before.has(p.pid))
    .sort((a: ProcessEntry, b: ProcessEntry) => b.startTime - a.startTime);
  const running = created.find((p: ProcessEntry) => p.state === 'running') ?? null;
  const pid = running?.pid ?? created[0]?.pid ?? null;
  const process = pid != null ? serializeProcess(self.processTable.get(pid)) : null;
  const ports = pid != null
    ? self.portRegistry.getAll().filter((p: any) => p.pid === pid).map(serializePort)
    : [];
  return { ...result, pid, process, ports };
}

export async function rpcRunCode(
  self: Host,
  code: string,
  options: ProgrammaticExecOptions & {
    language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
    install?: 'never' | 'ifMissing';
  } = {},
): Promise<ProgrammaticExecResult> {
  const language = options.language ?? 'javascript';
  if (language === 'python' && options.install === 'ifMissing') {
    await ensureProgrammaticReady(self, { ...options, preinstall: ['python'] });
  } else if (language === 'ruby' && options.install === 'ifMissing') {
    await ensureProgrammaticReady(self, { ...options, preinstall: ['ruby'] });
  } else {
    await ensureProgrammaticReady(self, options);
  }

  if (language === 'shell') return rpcExec(self, code, options);
  if (language === 'python') return rpcExec(self, `python -c ${shellQuote(code)}`, options);
  if (language === 'ruby') return rpcExec(self, `ruby -e ${shellQuote(code)}`, options);
  return rpcExec(self, `node -e ${shellQuote(code)}`, options);
}

export async function rpcInstallRuntime(
  self: Host,
  spec: string,
  options: { force?: boolean } = {},
) {
  await ensureProgrammaticReady(self);
  return installRuntimeProgrammatic(runtimeDeps(self), String(spec), options);
}

export async function rpcEnsureRuntimes(
  self: Host,
  specs: string[],
  options: { force?: boolean } = {},
) {
  await ensureProgrammaticReady(self);
  return ensureRuntimesProgrammatic(
    runtimeDeps(self),
    specs.map((s) => String(s)),
    options,
  );
}

export async function rpcListRuntimes(self: Host) {
  await ensureProgrammaticReady(self);
  return {
    installed: listInstalledRuntimes(self.sqliteFs!, getHome(self)),
    available: await listAvailableRuntimes(self.env as any),
  };
}

export async function rpcListProcesses(self: Host): Promise<SerializedProcess[]> {
  await ensureProgrammaticReady(self);
  return self.processTable.getAll().map((p: ProcessEntry) => serializeProcess(p)!);
}

export async function rpcKillProcess(self: Host, pid: number): Promise<{ ok: boolean; pid: number }> {
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
        try { await self.ctx.storage.delete('vite-config'); } catch {}
      }
    } catch {}
    try { self.portRegistry.unregisterByPid(n); } catch {}
    ok = self.processTable.kill(n);
    self._viteShimPid = null;
    self._viteShimPort = null;
  } else if (self.facetManager) {
    ok = self.facetManager.kill(n);
  } else {
    ok = self.processTable.kill(n);
  }
  return { ok, pid: n };
}

export async function rpcProcessLogs(
  self: Host,
  pid: number,
  options: { lines?: number; bytes?: number } = {},
) {
  await ensureProgrammaticReady(self);
  const chunks = self.processLogs.tail(Number(pid), options.bytes ? { bytes: options.bytes } : { lines: options.lines ?? 200 });
  return {
    pid: Number(pid),
    chunks,
    text: chunks.map((c: any) => c.data).join(''),
    exit: self.processLogs.getExit(Number(pid)),
  };
}

export async function rpcListPorts(self: Host): Promise<SerializedPort[]> {
  await ensureProgrammaticReady(self);
  return self.portRegistry.getAll().map(serializePort);
}

export async function rpcExposePort(self: Host, port: number) {
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

export async function rpcUnexposePort(self: Host, port: number) {
  await ensureProgrammaticReady(self);
  const n = Number(port);
  return { port: n, ok: self.portRegistry.unregister(n) };
}

export async function rpcDeleteFile(
  self: Host,
  path: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await ensureProgrammaticReady(self);
  const p = String(path).replace(/^\/+/, '');
  if (!self.sqliteFs!.exists(p)) return;
  if (self.sqliteFs!.isDirectory(p)) {
    if (!options.recursive) {
      self.sqliteFs!.rmdir(p);
      return;
    }
    rmrf(self.sqliteFs!, p);
    return;
  }
  self.sqliteFs!.unlink(p);
}

function rmrf(vfs: any, path: string): void {
  for (const entry of vfs.readdir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.type === 'directory') rmrf(vfs, child);
    else vfs.unlink(child);
  }
  vfs.rmdir(path);
}

function serializeProcess(p: ProcessEntry | undefined): SerializedProcess | null {
  if (!p) return null;
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
  };
}

function serializePort(p: any): SerializedPort {
  return {
    port: Number(p.port),
    pid: Number(p.pid),
    registeredAt: Number(p.registeredAt),
  };
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
