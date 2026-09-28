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
 * A session may be scoped. A scope confines two things: the one named shell
 * its commands run in, and the identity every command and file operation
 * runs as. The stub is the capability, so a caller that names another shell
 * or identity is refused rather than obeyed; a scope that names no shell
 * runs no command, since the only shell left to it is the embedder's own.
 * The workspace's destruction stays with the embedder. Processes, ports,
 * logs and applications are not confined: they are workspace-wide, as they
 * are to the shell's own `ps`, `kill`, `logs` and `nimbus expose`/`app`.
 */

import { RpcTarget } from 'cloudflare:workers';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
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

  /**
   * The identity a call acts as. A scoped session always names one: its own,
   * or the session user every command runs as by default, so no verb's own
   * default (the kernel, for `files.delete`) applies to it.
   */
  private cred(asked: VfsCred | undefined): VfsCred | undefined {
    if (this.scope === null) return asked;
    const bound = this.scope.cred ?? CRED_SESSION_USER;
    if (asked !== undefined && !sameCred(bound, asked)) throw new Error('EPERM: this session is bound to another identity');
    return bound;
  }

  private exec<T extends operations.ProgrammaticExecOptions>(options: T | undefined): T {
    if (this.scope !== null && (this.scope.shellId === undefined || options?.shellId !== this.scope.shellId)) {
      // Named, never defaulted: a client that omits the shell also sends a cwd
      // for the session's one shell, which would pin the named shell's cwd.
      // A scope without a shell would run on the embedder's workspace shell,
      // reading and planting its environment, so it runs nothing.
      throw new Error(this.scope.shellId === undefined
        ? 'EPERM: this session names no shell, so it runs no command'
        : `EPERM: this session runs commands only in shell '${this.scope.shellId}'; name it`);
    }
    const cred = this.cred(options?.cred);
    return { ...options, ...(cred === undefined ? {} : { cred }) } as T;
  }

  _rpcReady(options?: operations.ProgrammaticReadyOptions) { return operations.ensureProgrammaticReady(this.client(), options); }
  async _rpcExecStream(command: string, options?: operations.ProgrammaticExecOptions): Promise<ReadableStream<Uint8Array>> {
    return encodeExecStream(await operations.rpcExecStream(this.client(), command, this.exec(options)));
  }
  async _rpcStartProcess(command: string, options?: operations.ProgrammaticExecOptions) {
    return operations.rpcStartProcess(this.client(), command, this.exec(options));
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

  _rpcListProcesses() { return operations.rpcListProcesses(this.client()); }
  _rpcKillProcess(pid: number) { return operations.rpcKillProcess(this.client(), pid); }
  _rpcWriteProcessInput(pid: number, data: string) { return operations.rpcWriteProcessInput(this.client(), pid, data); }
  _rpcEndProcessInput(pid: number) { return operations.rpcEndProcessInput(this.client(), pid); }
  _rpcResizeProcess(pid: number, size: { columns: number; rows: number }) { return operations.rpcResizeProcess(this.client(), pid, size); }
  _rpcSignalProcess(pid: number, signal: string) { return operations.rpcSignalProcess(this.client(), pid, signal); }
  _rpcProcessLogs(pid: number, options?: { cursor?: number; lines?: number; bytes?: number }) {
    return operations.rpcProcessLogs(this.client(), pid, options);
  }
  _rpcListPorts() { return operations.rpcListPorts(this.client()); }
  _rpcExposePort(port: number, options?: Visibility) { return operations.rpcExposePort(this.client(), port, options); }
  _rpcUnexposePort(port: number) { return operations.rpcUnexposePort(this.client(), port); }
  _rpcListApps() { return operations.rpcListApps(this.client()); }
  _rpcExposeApp(target: operations.AppTarget, options?: Visibility) { return operations.rpcExposeApp(this.client(), target, options); }
  _rpcRotateLink(target: operations.AppTarget) { return operations.rpcRotateLink(this.client(), target); }
  _rpcRemoveApp(target: operations.AppTarget) { return operations.rpcRemoveApp(this.client(), target); }
  _rpcEnsureDurableApp(input: { owner: string; preferredPort?: number; visibility?: 'scoped' | 'public'; name?: string }) {
    return operations.rpcEnsureDurableApp(this.client(), input);
  }
  _rpcRemoveDurableApp(owner: string) { return operations.rpcRemoveDurableApp(this.client(), owner); }

  /** The embedder owns the workspace's life; a session it handed out cannot end it. */
  async _rpcDestroy(): Promise<never> {
    throw new Error('EPERM: a hosted session cannot destroy the workspace; its embedder closes the runtime');
  }
}
