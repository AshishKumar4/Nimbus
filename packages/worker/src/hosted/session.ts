/**
 * The SDK's session surface, served by a hosted runtime.
 *
 * `Nimbus.fromSession` drives a `NimbusSandbox` over any object with the
 * `_rpc*` methods a `NimbusSession` Durable Object answers. A hosted runtime
 * has no such object of its own: its embedder's Durable Object owns it. So the
 * runtime hands out this `RpcTarget`, and the embedder passes it wherever a
 * sandbox client runs — another isolate included, since an `RpcTarget`
 * crosses RPC as a stub whose calls run here.
 *
 * A session may be scoped. Its scope names the one shell its commands may run
 * in, and the identity every command and file operation runs as; the stub is
 * the capability, so a caller that names another shell or identity is
 * refused rather than obeyed. A scoped session reaches only the processes it
 * started (and their children), and the ports they serve; the application
 * verbs, which address launches by owner across every shell, and the
 * workspace's destruction stay with the embedder.
 */

import { RpcTarget } from 'cloudflare:workers';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { encodeExecStream } from '@nimbus-sh/core/runtime/exec-stream.js';
import * as rpc from '../session/rpc.js';
import * as operations from '../session/programmatic.js';

export interface HostedSessionScope {
  /** The only named shell a command may run in; every command must name it (`sandbox(id, { shellId })`). */
  readonly shellId?: string;
  /** The identity every command and file operation runs as. */
  readonly cred?: VfsCred;
}

type RunCodeOptions = operations.ProgrammaticExecOptions & {
  language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
  install?: 'never' | 'ifMissing';
};

type Visibility = { visibility?: 'scoped' | 'public'; name?: string };

export interface HostedSessionOwner extends operations.ProgrammaticHost {
  noteClientActivity(): void;
}

function sameCred(a: VfsCred, b: VfsCred): boolean {
  return a.uid === b.uid && a.gid === b.gid && a.umask === b.umask
    && a.groups.length === b.groups.length && a.groups.every((group, index) => group === b.groups[index]);
}

/**
 * The pids each scope started, per runtime. Keyed by the scope's value, not
 * the session object: a client asks for a fresh session per call, and every
 * session with the same scope is the same capability.
 */
const startedByScope = new WeakMap<HostedSessionOwner, Map<string, Set<number>>>();

export class HostedSession extends RpcTarget {
  private readonly scope: HostedSessionScope | null;

  constructor(private readonly owner: HostedSessionOwner, scope: HostedSessionScope) {
    super();
    const { shellId, cred } = scope;
    this.scope = shellId === undefined && cred === undefined ? null : Object.freeze({ shellId, cred });
  }

  /** Every call is a client's, as every `composeHostedRuntime` call is: it notes activity for the resident keep-alive. */
  private client(): HostedSessionOwner {
    this.owner.noteClientActivity();
    return this.owner;
  }

  private cred(asked: VfsCred | undefined): VfsCred | undefined {
    if (this.scope === null || asked === undefined) return this.scope?.cred ?? asked;
    // A scope without a credential acts as the runtime's default identity,
    // which is still its own: naming any identity is naming another.
    if (this.scope.cred === undefined || !sameCred(this.scope.cred, asked)) {
      throw new Error('EPERM: this session is bound to another identity');
    }
    return this.scope.cred;
  }

  private exec<T extends operations.ProgrammaticExecOptions>(options: T | undefined): T {
    if (this.scope !== null && options?.shellId !== this.scope.shellId) {
      // Named, never defaulted: a client that omits the shell also sends a cwd
      // for the session's one shell, which would pin the named shell's cwd.
      // A scope without a shell names none, so it may enter none.
      throw new Error(this.scope.shellId === undefined
        ? 'EPERM: this session runs commands only on the workspace shell; it names no shell'
        : `EPERM: this session runs commands only in shell '${this.scope.shellId}'; name it`);
    }
    const cred = this.cred(options?.cred);
    return { ...options, ...(cred === undefined ? {} : { cred }) } as T;
  }

  private started(): Set<number> | null {
    if (this.scope === null) return null;
    let scopes = startedByScope.get(this.owner);
    if (scopes === undefined) startedByScope.set(this.owner, scopes = new Map());
    const { shellId, cred } = this.scope;
    const key = JSON.stringify([shellId ?? null, cred === undefined ? null : [cred.uid, cred.gid, cred.umask, cred.groups]]);
    let pids = scopes.get(key);
    if (pids === undefined) scopes.set(key, pids = new Set());
    return pids;
  }

  /** Whether this session may act on `pid`: unscoped, or a process its scope started, or one of theirs. */
  private reaches(pid: number): boolean {
    const started = this.started();
    if (started === null) return true;
    const seen = new Set<number>();
    for (let at: number | undefined = Number(pid); at !== undefined && !seen.has(at); at = this.owner.processes.get(at)?.parentPid) {
      if (started.has(at)) return true;
      seen.add(at);
    }
    return false;
  }

  private process(pid: number): HostedSessionOwner {
    if (!this.reaches(pid)) throw new Error(`EPERM: process ${pid} was not started by this session`);
    return this.client();
  }

  private port(port: number): HostedSessionOwner {
    const live = this.scope === null ? undefined : this.owner.portRegistry.get(Number(port));
    if (this.scope !== null && (live === undefined || !this.reaches(live.pid))) {
      throw new Error(`EPERM: port ${port} is not served by a process this session started`);
    }
    return this.client();
  }

  /** Applications are addressed by owner, across every shell's launches: the embedder's to manage. */
  private apps(): HostedSessionOwner {
    if (this.scope !== null) throw new Error('EPERM: a scoped session cannot manage the workspace\'s applications');
    return this.client();
  }

  _rpcReady(options?: operations.ProgrammaticReadyOptions) { return operations.ensureProgrammaticReady(this.client(), options); }
  async _rpcExecStream(command: string, options?: operations.ProgrammaticExecOptions): Promise<ReadableStream<Uint8Array>> {
    return encodeExecStream(await operations.rpcExecStream(this.client(), command, this.exec(options)));
  }
  async _rpcStartProcess(command: string, options?: operations.ProgrammaticExecOptions) {
    const started = await operations.rpcStartProcess(this.client(), command, this.exec(options));
    this.started()?.add(started.pid);
    return started;
  }
  async _rpcRunCode(code: string, options?: RunCodeOptions) { return operations.rpcRunCode(this.client(), code, this.exec(options)); }

  // The file methods keep the session's wire shape: the third slot is a
  // process claim no SDK caller makes, and is not accepted here either.
  async _rpcReadFile(path: string, _pid?: undefined, cred?: VfsCred): Promise<string | null> {
    return rpc._rpcReadFile(this.client(), path, undefined, this.cred(cred));
  }
  async _rpcReadFileBytes(path: string, _pid?: undefined, cred?: VfsCred): Promise<Uint8Array | null> {
    return rpc._rpcReadFileBytes(this.client(), path, undefined, this.cred(cred));
  }
  async _rpcWriteFile(path: string, content: string | Uint8Array, _pid?: undefined, cred?: VfsCred): Promise<void> {
    await rpc._rpcWriteFile(this.client(), path, content, undefined, this.cred(cred));
  }
  async _rpcStat(path: string, _pid?: undefined, cred?: VfsCred) { return rpc._rpcStat(this.client(), path, undefined, this.cred(cred)); }
  async _rpcLstat(path: string, _pid?: undefined, cred?: VfsCred) { return rpc._rpcLstat(this.client(), path, undefined, this.cred(cred)); }
  async _rpcReaddir(path: string, _pid?: undefined, cred?: VfsCred) { return rpc._rpcReaddir(this.client(), path, undefined, this.cred(cred)); }
  async _rpcRename(from: string, to: string, _pid?: undefined, cred?: VfsCred) {
    return rpc._rpcRename(this.client(), from, to, undefined, this.cred(cred));
  }
  async _rpcChmod(path: string, mode: number, _pid?: undefined, cred?: VfsCred) {
    return rpc._rpcChmod(this.client(), path, mode, undefined, this.cred(cred));
  }
  async _rpcFsReadRange(path: string, offset: number, length: number, _pid?: undefined, cred?: VfsCred) {
    return rpc._rpcFsReadRange(this.client(), path, offset, length, undefined, this.cred(cred));
  }
  async _rpcExists(path: string, _pid?: undefined, cred?: VfsCred) { return rpc._rpcExists(this.client(), path, undefined, this.cred(cred)); }
  async _rpcMkdir(path: string, _pid?: undefined, cred?: VfsCred) { return rpc._rpcMkdir(this.client(), path, undefined, this.cred(cred)); }
  async _rpcDeleteFile(path: string, options?: { recursive?: boolean }, cred?: VfsCred) {
    return operations.rpcDeleteFile(this.client(), path, options, this.cred(cred));
  }

  _rpcInstallRuntime(spec: string, options?: { force?: boolean }) { return operations.rpcInstallRuntime(this.client(), spec, options); }
  _rpcEnsureRuntimes(specs: string[], options?: { force?: boolean }) { return operations.rpcEnsureRuntimes(this.client(), specs, options); }
  _rpcListRuntimes() { return operations.rpcListRuntimes(this.client()); }

  async _rpcListProcesses() {
    return (await operations.rpcListProcesses(this.client())).filter((process) => this.reaches(process.pid));
  }
  async _rpcKillProcess(pid: number) { return operations.rpcKillProcess(this.process(pid), pid); }
  async _rpcWriteProcessInput(pid: number, data: string) { return operations.rpcWriteProcessInput(this.process(pid), pid, data); }
  async _rpcEndProcessInput(pid: number) { return operations.rpcEndProcessInput(this.process(pid), pid); }
  async _rpcResizeProcess(pid: number, size: { columns: number; rows: number }) {
    return operations.rpcResizeProcess(this.process(pid), pid, size);
  }
  async _rpcSignalProcess(pid: number, signal: string) { return operations.rpcSignalProcess(this.process(pid), pid, signal); }
  async _rpcProcessLogs(pid: number, options?: { cursor?: number; lines?: number; bytes?: number }) {
    return operations.rpcProcessLogs(this.process(pid), pid, options);
  }

  async _rpcListPorts() {
    return (await operations.rpcListPorts(this.client())).filter((port) => this.reaches(port.pid));
  }
  async _rpcExposePort(port: number, options?: Visibility) { return operations.rpcExposePort(this.port(port), port, options); }
  async _rpcUnexposePort(port: number) { return operations.rpcUnexposePort(this.port(port), port); }
  async _rpcListApps() {
    return (await operations.rpcListApps(this.client())).filter((app) => this.scope === null || (app.pid !== null && this.reaches(app.pid)));
  }
  async _rpcExposeApp(target: operations.AppTarget, options?: Visibility) { return operations.rpcExposeApp(this.apps(), target, options); }
  async _rpcRotateLink(target: operations.AppTarget) { return operations.rpcRotateLink(this.apps(), target); }
  async _rpcRemoveApp(target: operations.AppTarget) { return operations.rpcRemoveApp(this.apps(), target); }
  async _rpcEnsureDurableApp(input: { owner: string; preferredPort?: number; visibility?: 'scoped' | 'public'; name?: string }) {
    return operations.rpcEnsureDurableApp(this.apps(), input);
  }
  async _rpcRemoveDurableApp(owner: string) { return operations.rpcRemoveDurableApp(this.apps(), owner); }

  /** The embedder owns the workspace's life; a session it handed out cannot end it. */
  async _rpcDestroy(): Promise<never> {
    throw new Error('EPERM: a hosted session cannot destroy the workspace; its embedder closes the runtime');
  }
}
