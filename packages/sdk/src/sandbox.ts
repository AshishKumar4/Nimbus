/**
 * @nimbus-sh/sdk/sandbox - programmatic Nimbus sandbox handle.
 */

import {
  isPreviewHostSafeSid,
  previewHostUrl,
  readPreviewHostSuffix,
} from '@nimbus-sh/worker/preview-host';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  EXEC_STREAM_CONTENT_TYPE,
  collectExecStream,
  decodeExecStream,
  type ExecChunk,
  type ExecExit,
  type ExecStream,
  type ExecOutput,
} from '@nimbus-sh/core/runtime/exec-stream.js';
import {
  SessionResults, SessionSuccessSchema, SessionFailureSchema,
  type SessionJsonOperation, type SessionOperation, type SessionResult,
  type SessionRpc as NimbusSessionSurface,
  type SessionExecOptions, type SessionRunCodeOptions,
  type SessionRestartPolicy as NimbusRestartPolicy,
  type SessionAppVisibility as NimbusAppVisibility,
  type SessionAppTarget as NimbusAppTarget,
  type SessionApp, type SessionExposedApp,
  type SessionTerminalSize as NimbusTerminalSize,
  type SessionDestroyOptions as NimbusDestroyOptions,
  type SessionDestroyResult as NimbusDestroyResult,
  type SessionStartResult as NimbusStartResult,
  type SessionProcess as NimbusProcess,
  type SessionProcessLogChunk as NimbusProcessLogChunk,
  type SessionProcessExit as NimbusProcessExitInfo,
  type SessionProcessLogsOptions as NimbusProcessLogsOptions,
  type SessionProcessLogs as NimbusProcessLogsResult,
  type SessionPort as NimbusPort,
  type SessionFileStat as NimbusFileStat, type SessionDirectoryEntry,
  type SessionRuntimeSummary as NimbusRuntimeSummary,
  type SessionAvailableRuntime as NimbusAvailableRuntime,
} from '@nimbus-sh/core/runtime/session-protocol.js';
export type {
  NimbusSessionSurface, NimbusRestartPolicy, NimbusAppVisibility, NimbusAppTarget,
  NimbusTerminalSize, NimbusDestroyOptions, NimbusDestroyResult, NimbusStartResult,
  NimbusProcess, NimbusProcessLogChunk, NimbusProcessExitInfo, NimbusProcessLogsOptions,
  NimbusProcessLogsResult, NimbusPort, NimbusFileStat, NimbusRuntimeSummary, NimbusAvailableRuntime,
};
import { z } from 'zod/v4';
import { WireEncoder, WireDecoder } from '@nimbus-sh/core/_shared/wire-codec.js';
import { DEFAULT_HOME } from '@nimbus-sh/core/constants.js';
import { isNimbusIdComponent } from '@nimbus-sh/core/_shared/id-component.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import {
  codeRuntimeRequirement,
  runtimePolicyError,
  type NimbusConfig,
  type NimbusSandboxProfile,
  type NimbusRuntimeAction,
  type NimbusCodeLanguage,
  type RuntimeSpec,
} from '@nimbus-sh/config/sandbox';
export type { NimbusConfig, NimbusSandboxProfile, NimbusRuntimePolicy, RuntimeSpec, NimbusRuntimeName as RuntimeName } from '@nimbus-sh/config/sandbox';

export interface NimbusFromEnvOptions {
  binding?: string;
  endpoint?: string;
}

export type NimbusHeaders =
  | HeadersInit
  | (() => HeadersInit | Promise<HeadersInit>);

export interface NimbusConnectOptions {
  /** Base URL of a Nimbus deployment, for example `https://nimbus.example.com`. */
  endpoint: string;
  /** Nimbus JWT. Sent as `Authorization: Bearer <token>` when provided. */
  token?: string;
  /** Additional headers, or a callback for rotating credentials. */
  headers?: NimbusHeaders;
  /** Custom fetch implementation. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Remote API base path. Defaults to `/api/nimbus/v1`. */
  basePath?: string;
  /** Sandbox profiles used by this client. The deployment should use the same config. */
  config?: NimbusConfig;
}

export interface NimbusSandboxOptions {
  profile?: string;
  tenant?: string;
  subject?: string;
  root?: string;
  /** The named shell every command runs in unless the call names another; see {@link NimbusExecOptions.shellId}. */
  shellId?: string;
}

export type NimbusExecOptions = Omit<SessionExecOptions, 'preinstall' | 'shellRoot'>;

/** The sandbox file plane; see `NimbusSandbox.files`. */
export interface NimbusSandboxFiles {
  /** The same API bound to `cred` — the view `SqliteVFS.as(cred)` gives in-process. */
  as(cred: VfsCred): NimbusSandboxFiles;
  read(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<NimbusFileStat | null>;
  /** stat without following a symlink leaf. */
  lstat(path: string): Promise<NimbusFileStat | null>;
  /** Read a symlink's stored target without following its final component. */
  readlink(path: string): Promise<string | null>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Read `length` bytes at `offset` without materializing the whole file. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  list(path?: string): Promise<SessionDirectoryEntry[]>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The trailing wire argument a credentialed file op carries, or nothing. */
function fileWireOptions(cred: VfsCred | undefined): [] | [{ cred: VfsCred }] {
  return cred === undefined ? [] : [{ cred }];
}

/** The SDK builds a browser URL, or leaves it undefined when the deployment is not addressable. */
export type NimbusExposedApp = Omit<SessionExposedApp, 'url'> & { url: string | undefined };
export type NimbusApp = Omit<SessionApp, 'url'> & { url: string | undefined };

/** A slice of a command's stdout or stderr, as the bytes it wrote. */
export type NimbusExecChunk = ExecChunk;
/** How a command ended: what `exec` returns, without the output. */
export type NimbusExecExit = ExecExit;
/**
 * A running command's output. Read `output` to the end (or cancel it, which
 * kills the command); `exit` settles after the last chunk. A reader that
 * stops reading stops the command at its next write.
 */
export type NimbusExecStream = ExecStream;

export type NimbusExecResult = ExecOutput;

export interface NimbusProcessAttachOptions {
  pollIntervalMs?: number;
  lines?: number;
  bytes?: number;
  signal?: AbortSignal;
}

interface NimbusSessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): NimbusSessionSurface;
}

type NimbusTarget =
  | { kind: 'binding'; namespace: NimbusSessionNamespace }
  | { kind: 'session'; open: () => NimbusSessionSurface }
  | {
      kind: 'remote';
      endpoint: string;
      basePath: string;
      token?: string;
      headers?: NimbusHeaders;
      fetch: typeof fetch;
    };

export class NimbusRemoteError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(message: string, options: { status: number; code?: string; body?: unknown }) {
    super(message);
    this.name = 'NimbusRemoteError';
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }
}

async function remotePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new NimbusRemoteError(`Nimbus remote API returned non-JSON response (${response.status})`, {
      status: response.status,
      body: text,
    });
  }
}

function remoteFailure(response: Response, payload: unknown): NimbusRemoteError {
  const failure = SessionFailureSchema.safeParse(payload);
  const fallback = `Nimbus remote API request failed (${response.status})`;
  return new NimbusRemoteError(failure.success ? failure.data.error ?? failure.data.message ?? fallback : fallback, {
    status: response.status,
    code: failure.success ? failure.data.code : undefined,
    body: payload,
  });
}

const ToolPathInputSchema = z.object({
  path: z.string().optional(),
}).passthrough();

const ToolWriteFileInputSchema = z.object({
  path: z.string().optional(),
  content: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
  data: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
}).passthrough();

const ToolDeleteFileInputSchema = z.object({
  path: z.string().optional(),
  recursive: z.boolean().optional(),
}).passthrough();

export class Nimbus {
  static fromEnv(
    env: Record<string, unknown>,
    config: NimbusConfig = {},
    options: NimbusFromEnvOptions = {},
  ): Nimbus {
    const bindingName = options.binding ?? 'NIMBUS_SESSION';
    const binding = env[bindingName] as NimbusSessionNamespace | undefined;
    if (!binding) {
      throw new Error(`Nimbus.fromEnv: env.${bindingName} Durable Object binding is missing`);
    }
    return new Nimbus({ kind: 'binding', namespace: binding }, {
      ...config,
      endpoint: options.endpoint ?? config.endpoint,
      // The binding is the deployment's own answer for whether port previews
      // have a host suffix, so in-Worker callers never restate it in config.
      previewHostSuffix: readPreviewHostSuffix(env) ?? config.previewHostSuffix,
    });
  }

  /**
   * A client over a session surface the caller already holds, such as the
   * one a hosted runtime's `session()` returns, possibly as an RPC stub from
   * another isolate. `open` is asked once per call, so a caller whose stub
   * does not outlive one RPC session can hand out a fresh one each time. It
   * is a function, never the surface itself: an RPC stub is callable too,
   * so the two could not be told apart. The sandbox id names nothing here;
   * the surface is the session.
   */
  static fromSession(open: () => NimbusSessionSurface, config: NimbusConfig = {}): Nimbus {
    return new Nimbus({ kind: 'session', open }, config);
  }

  static connect(options: NimbusConnectOptions): Nimbus {
    if (!options.endpoint) {
      throw new Error('Nimbus.connect: endpoint is required');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') {
      throw new Error('Nimbus.connect: fetch is unavailable; pass a custom fetch implementation');
    }
    const config = {
      ...(options.config ?? {}),
      endpoint: options.endpoint,
    };
    return new Nimbus({
      kind: 'remote',
      endpoint: trimTrailingSlashes(options.endpoint),
      basePath: normalizeBasePath(options.basePath ?? '/api/nimbus/v1'),
      token: options.token,
      headers: options.headers,
      fetch: fetchImpl,
    }, config);
  }

  private readonly target: NimbusTarget;

  constructor(
    target: NimbusSessionNamespace | NimbusTarget,
    private readonly config: NimbusConfig = {},
  ) {
    this.target = isNimbusTarget(target)
      ? target
      : { kind: 'binding', namespace: target };
  }

  sandbox(id: string, options: NimbusSandboxOptions = {}): NimbusSandbox {
    return new NimbusSandbox(this.target, String(id), options, this.config);
  }
}

export class NimbusSandbox {
  readonly id: string;
  readonly profileName: string;
  private readonly profile: NimbusSandboxProfile;
  private readyPromise: Promise<void> | null = null;

  constructor(
    private readonly target: NimbusTarget,
    id: string,
    private readonly options: NimbusSandboxOptions,
    private readonly config: NimbusConfig,
  ) {
    this.id = idComponent(id, 'sandbox id');
    this.profileName = options.profile ?? 'default';
    this.profile = config.sandboxes?.[this.profileName] ?? config.sandboxes?.default ?? {};
  }

  private get tenantSegment(): string {
    const tenant = idComponent(this.options.tenant ?? 'default', 'tenant');
    const subject = idComponent(this.options.subject ?? '_', 'subject');
    return `${tenant}:${subject}`;
  }

  private get doName(): string {
    return `${this.tenantSegment}:${this.id}`;
  }

  private get root(): string {
    return this.options.root ?? this.profile.root ?? DEFAULT_HOME;
  }

  private stub(): NimbusSessionSurface {
    if (this.target.kind === 'remote') return this.remoteStub();
    if (this.target.kind === 'session') return this.target.open();
    const id = this.target.namespace.idFromName(this.doName);
    return this.target.namespace.get(id);
  }

  private remoteStub(): NimbusSessionSurface {
    return {
      _rpcReady: (options) => this.remoteRpc('ready', [options]),
      _rpcExecStream: (command, options) => this.remoteExecStream([command, options]),
      _rpcStartProcess: (command, options) => this.remoteRpc('startProcess', [command, options]),
      _rpcDetachExec: (detachId) => this.remoteRpc('detachExec', [detachId]),
      _rpcRunCode: (code, options) => this.remoteRpc('runCode', [code, options]),
      // A credential rides the wire as a trailing `{ cred }` options object
      // so the payload names it explicitly; the remote dispatcher decides
      // what to do with it (today: refuse, as it refuses `cred` on exec).
      _rpcReadFile: (path, _pid, cred) => this.remoteRpc('readFile', [path, ...fileWireOptions(cred)]),
      _rpcReadFileBytes: (path, _pid, cred) => this.remoteRpc('readFileBytes', [path, ...fileWireOptions(cred)]),
      _rpcWriteFile: (path, content, _pid, cred) => this.remoteRpc('writeFile', [path, content, ...fileWireOptions(cred)]),
      _rpcStat: (path, _pid, cred) => this.remoteRpc('stat', [path, ...fileWireOptions(cred)]),
      _rpcLstat: (path, _pid, cred) => this.remoteRpc('lstat', [path, ...fileWireOptions(cred)]),
      _rpcReadlink: (path, _pid, cred) => this.remoteRpc('readlink', [path, ...fileWireOptions(cred)]),
      _rpcRename: (from, to, _pid, cred) => this.remoteRpc('rename', [from, to, ...fileWireOptions(cred)]),
      _rpcChmod: (path, mode, _pid, cred) => this.remoteRpc('chmod', [path, mode, ...fileWireOptions(cred)]),
      _rpcFsReadRange: (path, offset, length, _pid, cred) =>
        this.remoteRpc('readRange', [path, offset, length, ...fileWireOptions(cred)]),
      _rpcReaddir: (path, _pid, cred) => this.remoteRpc('readdir', [path, ...fileWireOptions(cred)]),
      _rpcExists: (path, _pid, cred) => this.remoteRpc('exists', [path, ...fileWireOptions(cred)]),
      _rpcMkdir: (path, _pid, cred) => this.remoteRpc('mkdir', [path, ...fileWireOptions(cred)]),
      _rpcDeleteFile: (path, options, cred) =>
        this.remoteRpc('deleteFile', [path, { ...(options ?? {}), ...(cred !== undefined ? { cred } : {}) }]),
      _rpcInstallRuntime: (spec, options) => this.remoteRpc('installRuntime', [spec, options]),
      _rpcEnsureRuntimes: (specs, options) => this.remoteRpc('ensureRuntimes', [specs, options]),
      _rpcListRuntimes: () => this.remoteRpc('listRuntimes', []),
      _rpcListProcesses: () => this.remoteRpc('listProcesses', []),
      _rpcKillProcess: (pid) => this.remoteRpc('killProcess', [pid]),
      _rpcWriteProcessInput: (pid, data) => this.remoteRpc('writeProcessInput', [pid, data]),
      _rpcEndProcessInput: (pid) => this.remoteRpc('endProcessInput', [pid]),
      _rpcResizeProcess: (pid, size) => this.remoteRpc('resizeProcess', [pid, size]),
      _rpcSignalProcess: (pid, signal) => this.remoteRpc('signalProcess', [pid, signal]),
      _rpcProcessLogs: (pid, options) => this.remoteRpc('processLogs', [pid, options]),
      _rpcListPorts: () => this.remoteRpc('listPorts', []),
      _rpcExposePort: (port, options) => this.remoteRpc('exposePort', [port, options]),
      _rpcEnsureDurableApp: (input) => this.remoteRpc('ensureDurableApp', [input]),
      _rpcRemoveDurableApp: (owner) => this.remoteRpc('removeDurableApp', [{ owner }]),
      _rpcExposeApp: (target, options) => this.remoteRpc('exposeApp', [target, options]),
      _rpcListApps: () => this.remoteRpc('listApps', []),
      _rpcRotateLink: (target) => this.remoteRpc('rotateLink', [target]),
      _rpcRemoveApp: (target) => this.remoteRpc('removeApp', [target]),
      _rpcUnexposePort: (port) => this.remoteRpc('unexposePort', [port]),
      _rpcDestroy: (options) => this.remoteRpc('destroy', [options]),
    };
  }

  private async remoteRpc<Op extends SessionJsonOperation>(op: Op, args: unknown[]): Promise<SessionResult<Op>> {
    const response = await this.remoteFetch(op, args, 'application/json');
    const payload = await remotePayload(response);
    const success = SessionSuccessSchema.safeParse(payload);
    if (!response.ok || !success.success) throw remoteFailure(response, payload);
    return SessionResults[op].parse(WireDecoder.parse(success.data.result));
  }

  /** The `execStream` op answers with the encoded stream as its body, or a JSON error. */
  private async remoteExecStream(args: unknown[]): Promise<ReadableStream<Uint8Array>> {
    const response = await this.remoteFetch('execStream', args, EXEC_STREAM_CONTENT_TYPE);
    const type = response.headers.get('Content-Type') ?? '';
    if (response.ok && response.body && type.startsWith(EXEC_STREAM_CONTENT_TYPE)) return response.body;
    throw remoteFailure(response, await remotePayload(response));
  }

  private async remoteFetch(op: SessionOperation, args: unknown[], accept: string): Promise<Response> {
    if (this.target.kind !== 'remote') {
      throw new Error('Nimbus internal error: remote call on non-remote target');
    }

    const headers = new Headers(await resolveHeaders(this.target.headers));
    headers.set('Accept', accept);
    headers.set('Content-Type', 'application/json');
    if (this.target.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.target.token}`);
    }

    return this.target.fetch(
      `${this.target.endpoint}${this.target.basePath}/sandboxes/${encodeURIComponent(this.id)}/rpc`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(WireEncoder.parse({
          profile: this.profileName,
          tenant: this.options.tenant,
          subject: this.options.subject,
          root: this.root,
          op,
          args,
        })),
      },
    );
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) {
      const preinstall = this.profile.runtimes?.preinstall ?? [];
      for (const spec of preinstall) this.assertRuntimeAllowed(spec, 'preinstall');
      this.readyPromise = this.rpc(this.stub()._rpcReady({ preinstall })).then(() => undefined);
    }
    return this.readyPromise;
  }

  /** Run a command to completion and return its output as strings. Built on {@link execStream}. */
  async exec(command: string, options: NimbusExecOptions = {}): Promise<NimbusExecResult> {
    return collectExecStream(await this.execStream(command, options));
  }

  /**
   * Run a command and read its stdout and stderr as they are written, as
   * bytes, without the sandbox or this client holding the whole output.
   * Resolves once the command has started. `timeoutMs` still applies.
   */
  async execStream(command: string, options: NimbusExecOptions = {}): Promise<NimbusExecStream> {
    await this.ready();
    const stub = this.stub();
    const wire = this.execOptions(options);
    const detach = options.detach;
    if (!detach) return decodeExecStream(await stub._rpcExecStream(command, wire));
    const detachId = wire.detachId ?? crypto.randomUUID();
    const stream = decodeExecStream(await stub._rpcExecStream(command, { ...wire, detachId }));
    // Register only after the start is acknowledged, so independent HTTP
    // requests cannot deliver detach before the invocation exists. An abort
    // that happened while awaiting start is sent immediately afterwards.
    // Detach is a separate control call. Its failure is reported independently
    // and must never replace the still-running command's actual exit.
    const leave = () => { this.rpc(stub._rpcDetachExec(detachId)).catch((error: unknown) => {
      console.error(`Nimbus: could not detach invocation '${detachId}'; its command is still running`, error);
    }); };
    const forget = () => detach.removeEventListener('abort', leave);
    stream.exit.then(forget, forget);
    if (detach.aborted) leave();
    else detach.addEventListener('abort', leave, { once: true });
    return stream;
  }

  /**
   * Start a command in the background. Returns as soon as the process has a
   * pid — it does not wait for the command to finish.
   */
  async startProcess(command: string, options: NimbusExecOptions = {}): Promise<NimbusStartResult> {
    await this.ready();
    return this.rpc(this.stub()._rpcStartProcess(command, this.execOptions(options)));
  }

  async runCode(
    code: string,
    options: Omit<SessionRunCodeOptions, 'preinstall' | 'shellRoot' | 'language'> & { language?: NimbusCodeLanguage } = {},
  ): Promise<NimbusExecResult> {
    const language = options.language ?? 'javascript';
    const requirement = codeRuntimeRequirement(language, options.install);
    if (requirement) this.assertRuntimeAllowed(requirement.spec, requirement.action);
    await this.ready();
    return this.rpc(this.stub()._rpcRunCode(code, {
      ...this.execOptions(options),
      language,
      install: options.install ?? 'never',
    }));
  }

  async destroy(options: NimbusDestroyOptions = {}): Promise<NimbusDestroyResult> {
    this.readyPromise = null;
    return this.rpc(this.stub()._rpcDestroy(options));
  }

  /**
   * The session file plane. Every method acts as the session's default
   * identity for a pid-less caller — the session user for reads, writes,
   * stat, list, mkdir, rename and chmod; the kernel for `delete` — which is
   * the embedder's trusted surface, reached only by a caller holding the DO
   * binding or a remote token. `files.as(cred)` returns the same API bound
   * to `cred` instead, the view `SqliteVFS.as(cred)` gives in-process: a
   * file the identity cannot read answers EACCES, one it owns answers.
   * Over the remote endpoint a `cred` is refused by the dispatcher, as it is
   * on `exec` — a token authenticates a session, not a user inside it.
   */
  files: NimbusSandboxFiles = this.filesAs(undefined);

  private filesAs(cred: VfsCred | undefined): NimbusSandboxFiles {
    return {
      as: (bound: VfsCred): NimbusSandboxFiles => this.filesAs(bound),
      read: async (path: string): Promise<string | null> => {
        await this.ready();
        return this.rpc(this.stub()._rpcReadFile(path, undefined, cred));
      },
      readBytes: async (path: string): Promise<Uint8Array | null> => {
        await this.ready();
        return this.rpc(this.stub()._rpcReadFileBytes(path, undefined, cred));
      },
      write: async (path: string, content: string | Uint8Array): Promise<void> => {
        await this.ready();
        await this.rpc(this.stub()._rpcWriteFile(path, content, undefined, cred));
      },
      stat: async (path: string): Promise<NimbusFileStat | null> => {
        await this.ready();
        return this.rpc(this.stub()._rpcStat(path, undefined, cred));
      },
      /** stat without following a symlink leaf. */
      lstat: async (path: string): Promise<NimbusFileStat | null> => {
        await this.ready();
        return this.rpc(this.stub()._rpcLstat(path, undefined, cred));
      },
      readlink: async (path: string): Promise<string | null> => {
        await this.ready();
        return this.rpc(this.stub()._rpcReadlink(path, undefined, cred));
      },
      rename: async (from: string, to: string): Promise<void> => {
        await this.ready();
        return this.rpc(this.stub()._rpcRename(from, to, undefined, cred));
      },
      chmod: async (path: string, mode: number): Promise<void> => {
        await this.ready();
        return this.rpc(this.stub()._rpcChmod(path, mode, undefined, cred));
      },
      /** Read `length` bytes at `offset` without materializing the whole file. */
      readRange: async (path: string, offset: number, length: number): Promise<Uint8Array | null> => {
        await this.ready();
        return this.rpc(this.stub()._rpcFsReadRange(path, offset, length, undefined, cred));
      },
      list: async (path = this.root): Promise<SessionDirectoryEntry[]> => {
        await this.ready();
        return this.rpc(this.stub()._rpcReaddir(path, undefined, cred));
      },
      mkdir: async (path: string): Promise<void> => {
        await this.ready();
        return this.rpc(this.stub()._rpcMkdir(path, undefined, cred));
      },
      exists: async (path: string): Promise<boolean> => {
        await this.ready();
        return this.rpc(this.stub()._rpcExists(path, undefined, cred));
      },
      delete: async (path: string, options: { recursive?: boolean } = {}): Promise<void> => {
        await this.ready();
        return this.rpc(this.stub()._rpcDeleteFile(path, options, cred));
      },
    };
  }

  runtimes = {
    available: async (): Promise<NimbusAvailableRuntime[]> => {
      await this.ready();
      return (await this.rpc(this.stub()._rpcListRuntimes())).available;
    },
    installed: async (): Promise<NimbusRuntimeSummary[]> => {
      await this.ready();
      return (await this.rpc(this.stub()._rpcListRuntimes())).installed;
    },
    list: async () => {
      await this.ready();
      return this.rpc(this.stub()._rpcListRuntimes());
    },
    install: async (spec: RuntimeSpec, options: { force?: boolean } = {}) => {
      this.assertRuntimeAllowed(spec, 'onDemand');
      await this.ready();
      return this.rpc(this.stub()._rpcInstallRuntime(spec, options));
    },
    ensure: async (specs: RuntimeSpec | RuntimeSpec[], options: { force?: boolean } = {}) => {
      const list = Array.isArray(specs) ? specs : [specs];
      for (const spec of list) this.assertRuntimeAllowed(spec, 'onDemand');
      await this.ready();
      return this.rpc(this.stub()._rpcEnsureRuntimes(list, options));
    },
  };

  processes = {
    list: async (): Promise<NimbusProcess[]> => {
      await this.ready();
      return this.rpc(this.stub()._rpcListProcesses());
    },
    kill: async (pid: number) => {
      await this.ready();
      return this.rpc(this.stub()._rpcKillProcess(pid));
    },
    write: async (pid: number, data: string) => {
      await this.ready();
      return this.rpc(this.stub()._rpcWriteProcessInput(pid, data));
    },
    endInput: async (pid: number) => {
      await this.ready();
      return this.rpc(this.stub()._rpcEndProcessInput(pid));
    },
    resize: async (pid: number, size: NimbusTerminalSize) => {
      await this.ready();
      return this.rpc(this.stub()._rpcResizeProcess(pid, size));
    },
    signal: async (pid: number, signal: string) => {
      await this.ready();
      return this.rpc(this.stub()._rpcSignalProcess(pid, signal));
    },
    logs: async (pid: number, options: NimbusProcessLogsOptions = {}): Promise<NimbusProcessLogsResult> => {
      await this.ready();
      return this.rpc(this.stub()._rpcProcessLogs(pid, options));
    },
    attach: (pid: number, options: NimbusProcessAttachOptions = {}): NimbusProcessAttachment => {
      return new NimbusProcessAttachment(this, pid, options);
    },
  };

  ports = {
    list: async (): Promise<NimbusPort[]> => {
      await this.ready();
      return this.rpc(this.stub()._rpcListPorts());
    },
    /**
     * Expose a port. When the port's occupant carries an identity (a node
     * resident, a durable worker app) this is the same lazy reservation
     * `apps.expose` makes and the result names the owner; a bare port —
     * a dev server, a python resident — is written port-only as before.
     */
    expose: async (port: number, options: { visibility?: 'scoped' | 'public'; name?: string } = {}) => {
      await this.ready();
      const result = await this.rpc(this.stub()._rpcExposePort(port, options));
      return {
        ...result,
        url: this.portUrl(port, {
          visibility: result.visibility ?? 'scoped',
          capability: result.capability ?? undefined,
          name: result.name ?? undefined,
        }),
      };
    },
    unexpose: async (port: number) => {
      await this.ready();
      return this.rpc(this.stub()._rpcUnexposePort(port));
    },
    /**
     * Reserve (or re-answer) a durable application's port: the capability it
     * answers is minted here and survives every reset, so the URL it builds
     * is the URL the application keeps.
     */
    ensureDurableApp: async (input: { owner: string; preferredPort?: number; visibility?: 'scoped' | 'public' }) => {
      await this.ready();
      return this.rpc(this.stub()._rpcEnsureDurableApp(input));
    },
    /**
     * End a durable application's contract: its launch is killed, the journal
     * row purged, the reserved port released, the durable slot freed. Answers
     * the owner, whether anything was removed, and the durable port that was
     * released — null when no reservation existed.
     */
    removeDurableApp: async (owner: string) => {
      await this.ready();
      return this.rpc(this.stub()._rpcRemoveDurableApp(owner));
    },
    url: (port: number, options: { visibility?: 'scoped' | 'public'; capability?: string; name?: string } = {}): string | undefined =>
      this.portUrl(port, options),
  };

  /**
   * The application surface: every server is durable under its identity
   * from the moment it is spawned; exposing it reserves its port for that
   * identity, names it, and (when public) mints the capability its shared
   * URL is built on. `ports.expose` is the port-addressed alias of
   * `apps.expose`; the identity-addressed verbs live here.
   */
  apps = {
    list: async (): Promise<NimbusApp[]> => {
      await this.ready();
      const apps = await this.rpc(this.stub()._rpcListApps());
      return apps.map((app) => ({
        ...app,
        url: app.port === null ? undefined : this.portUrl(app.port, {
          visibility: app.visibility,
          capability: app.capability ?? undefined,
          name: app.name ?? undefined,
        }) ?? app.url ?? undefined,
      }));
    },
    expose: async (target: NimbusAppTarget, options: { visibility?: 'scoped' | 'public'; name?: string } = {}): Promise<NimbusExposedApp> => {
      await this.ready();
      const result = await this.rpc(this.stub()._rpcExposeApp(target, options));
      return this.exposedApp(result);
    },
    rotateLink: async (target: NimbusAppTarget): Promise<NimbusExposedApp> => {
      await this.ready();
      const result = await this.rpc(this.stub()._rpcRotateLink(target));
      return this.exposedApp(result);
    },
    remove: async (target: NimbusAppTarget) => {
      await this.ready();
      return this.rpc(this.stub()._rpcRemoveApp(target));
    },
  };

  private exposedApp(result: SessionExposedApp): NimbusExposedApp {
    return {
      ...result,
      url: this.portUrl(result.port, {
        visibility: result.visibility,
        capability: result.capability ?? undefined,
        name: result.name ?? undefined,
      }) ?? result.url ?? undefined,
    };
  }

  tools(options: { namespace?: string; kind?: string; name?: string } = {}) {
    const namespace = options.namespace ?? this.profile.tools?.namespace ?? 'nimbus';
    const kind = options.kind ?? this.profile.tools?.kind ?? 'nimbus';
    const callPath = (input: unknown): string => {
      if (typeof input === 'string') return input;
      return ToolPathInputSchema.parse(input).path ?? '';
    };
    const writeFileInput = (input: unknown): { path: string; content: string | Uint8Array } => {
      const parsed = ToolWriteFileInputSchema.parse(input);
      return {
        path: parsed.path ?? '',
        content: parsed.content ?? parsed.data ?? '',
      };
    };
    const deleteFileInput = (input: unknown): { path: string; recursive: boolean } => {
      if (typeof input === 'string') return { path: input, recursive: false };
      const parsed = ToolDeleteFileInputSchema.parse(input);
      return { path: parsed.path ?? '', recursive: parsed.recursive === true };
    };
    return {
      name: options.name ?? namespace,
      kind,
      capabilities: this.capabilities(),
      isAvailable: async () => true,
      connect: async () => this.ready(),
      disconnect: async () => undefined,
      tools: {
        exec: { execute: (command: string, opts?: NimbusExecOptions) => this.exec(command, opts) },
        runCode: { execute: (code: string, opts?: Parameters<NimbusSandbox['runCode']>[1]) => this.runCode(code, opts) },
        readFile: { execute: (input: unknown) => this.files.read(callPath(input)) },
        writeFile: { execute: (input: unknown) => {
          const parsed = writeFileInput(input);
          return this.files.write(parsed.path, parsed.content);
        } },
        listFiles: { execute: (input: unknown = this.root) => this.files.list(callPath(input) || this.root) },
        readdir: { execute: (input: unknown = this.root) => this.files.list(callPath(input) || this.root) },
        deleteFile: { execute: (input: unknown) => {
          const parsed = deleteFileInput(input);
          return this.files.delete(parsed.path, { recursive: parsed.recursive });
        } },
        exists: { execute: (input: unknown) => this.files.exists(callPath(input)) },
        startProcess: { execute: (command: string, opts?: NimbusExecOptions) => this.startProcess(command, opts) },
        killProcess: { execute: (input: number | { pid: number }) => this.processes.kill(typeof input === 'number' ? input : input.pid) },
        writeProcessInput: { execute: (input: { pid: number; data: string }) => this.processes.write(input.pid, input.data) },
        endProcessInput: { execute: (input: number | { pid: number }) => this.processes.endInput(typeof input === 'number' ? input : input.pid) },
        resizeProcess: { execute: (input: { pid: number; columns: number; rows: number }) => this.processes.resize(input.pid, { columns: input.columns, rows: input.rows }) },
        signalProcess: { execute: (input: { pid: number; signal: string }) => this.processes.signal(input.pid, input.signal) },
        logs: { execute: (input: number | { pid: number; lines?: number; bytes?: number }) =>
          this.processes.logs(typeof input === 'number' ? input : input.pid, typeof input === 'number' ? {} : input) },
        exposePort: { execute: (input: number | { port: number }) => this.ports.expose(typeof input === 'number' ? input : input.port) },
        unexposePort: { execute: (input: number | { port: number }) => this.ports.unexpose(typeof input === 'number' ? input : input.port) },
        listPorts: { execute: () => this.ports.list() },
        exposeApp: { execute: (input: NimbusAppTarget | { target: NimbusAppTarget; visibility?: 'scoped' | 'public'; name?: string }) =>
          typeof input === 'object' && input !== null && 'target' in input
            ? this.apps.expose(input.target, { visibility: input.visibility, name: input.name })
            : this.apps.expose(input as NimbusAppTarget) },
        listApps: { execute: () => this.apps.list() },
        installRuntime: { execute: (spec: RuntimeSpec) => this.runtimes.install(spec) },
        listRuntimes: { execute: () => this.runtimes.list() },
      },
    };
  }

  capabilities(): string[] {
    const hasRuntime = (name: string) => !runtimePolicyError(this.profile.runtimes, name, 'use', this.profileName);
    const caps = [
      'javascript',
      'typescript',
      'shell',
      'npm',
      'git',
      'fs_owned',
      'net_outbound',
      'net_inbound',
      'process_spawn',
      'process_long',
      'process_attached_stdio',
      'terminal_resize',
      'ansi_output',
    ];
    if (hasRuntime('python')) caps.push('python');
    if (hasRuntime('ruby')) caps.push('ruby');
    if (hasRuntime('clang')) caps.push('wasi', 'clang_wasi');
    return caps;
  }

  private execOptions(options: NimbusExecOptions): SessionExecOptions {
    const shellId = options.shellId ?? this.options.shellId;
    const normalized: SessionExecOptions = { ...options, ...(shellId === undefined ? {} : { shellId }) };
    // Signals are local capabilities; a detach crosses the wire by invocation id.
    delete normalized.detach;
    if (typeof normalized.cwd === 'string') {
      // The session shell only understands absolute paths; a relative cwd
      // forwarded verbatim used to reach it anyway — `pwd` echoed the
      // literal string and every write beneath it landed ENOENT. Resolve
      // against the sandbox root here, at the SDK boundary.
      normalized.cwd = resolveSandboxCwd(this.root, normalized.cwd);
    }
    if (normalized.shellId) {
      // A named shell owns its cwd, so defaulting one here would reset it on
      // every call. The sandbox root is only where a NEW shell starts.
      normalized.shellRoot = this.root;
    } else {
      normalized.cwd ??= this.root;
    }
    return normalized;
  }

  private assertRuntimeAllowed(spec: RuntimeSpec, action: NimbusRuntimeAction): void {
    const failure = runtimePolicyError(this.profile.runtimes, spec, action, this.profileName);
    if (failure) throw new Error(failure.message);
  }

  /**
   * Browser-facing URL for an exposed port, or undefined when the deployment
   * is not addressable (no `endpoint`, no configured preview base).
   *
   * The URL carries NO credential. On a deployment with auth enforced it is
   * the destination, not the ticket: the session mints a single-use attach
   * token for it at `GET /s/<id>/api/preview-url?port=<n>`, which is what the
   * session shell opens and what an embedder should hand to a browser.
   */
  private portUrl(
    port: number,
    options: { visibility?: 'scoped' | 'public'; capability?: string; name?: string } = {},
  ): string | undefined {
    const hostSuffix = this.config.previewHostSuffix;
    if (hostSuffix && !this.profile.preview?.pathStyle && isPreviewHostSafeSid(this.id)) {
      return previewHostUrl(this.id, { port, ...options }, hostSuffix);
    }
    const door = options.name !== undefined ? `/app/${options.name}/` : `/port/${port}/`;
    const explicit = this.profile.preview?.baseUrl;
    if (explicit) {
      const base = trimTrailingSlashes(explicit.replace('{sessionId}', encodeURIComponent(this.id)));
      return `${base}${door}`;
    }
    const endpoint = this.config.endpoint ? trimTrailingSlashes(this.config.endpoint) : '';
    if (!endpoint) return undefined;
    return `${endpoint}/s/${encodeURIComponent(this.id)}${door}`;
  }

  private async rpc<T>(promise: Promise<T>): Promise<T> {
    const value = await promise;
    disposeRpcResource(value);
    return value;
  }
}

export class NimbusProcessAttachment implements AsyncIterable<NimbusProcessLogChunk> {
  private cursor: number | null = null;

  constructor(
    private readonly sandbox: NimbusSandbox,
    readonly pid: number,
    private readonly options: NimbusProcessAttachOptions = {},
  ) {}

  async write(data: string): Promise<{ ok: boolean; pid: number }> {
    return this.sandbox.processes.write(this.pid, data);
  }

  async endInput(): Promise<{ ok: boolean; pid: number }> {
    return this.sandbox.processes.endInput(this.pid);
  }

  async resize(size: NimbusTerminalSize): Promise<{ ok: boolean; pid: number }> {
    return this.sandbox.processes.resize(this.pid, size);
  }

  async signal(signal: string): Promise<{ ok: boolean; pid: number }> {
    return this.sandbox.processes.signal(this.pid, signal);
  }

  async kill(): Promise<{ ok: boolean; pid: number }> {
    return this.sandbox.processes.kill(this.pid);
  }

  async logs(options: NimbusProcessLogsOptions = {}): Promise<NimbusProcessLogsResult> {
    const result = await this.sandbox.processes.logs(this.pid, options);
    this.cursor = result.cursor;
    return result;
  }

  stream(options: NimbusProcessAttachOptions = {}): AsyncIterable<NimbusProcessLogChunk> {
    const attach = this;
    const pollIntervalMs = boundedPollInterval(options.pollIntervalMs ?? this.options.pollIntervalMs);
    const signal = options.signal ?? this.options.signal;
    const initialLines = options.lines ?? this.options.lines;
    const initialBytes = options.bytes ?? this.options.bytes;

    return {
      async *[Symbol.asyncIterator]() {
        if (signal?.aborted) return;

        let cursor = attach.cursor;
        if (cursor === null) {
          const initial = await attach.logs({
            ...(initialBytes !== undefined ? { bytes: initialBytes } : {}),
            ...(initialBytes === undefined && initialLines !== undefined ? { lines: initialLines } : {}),
          });
          cursor = initial.cursor;
          for (const chunk of initial.chunks) yield chunk;
          if (initial.exit || signal?.aborted) return;
        }

        while (!signal?.aborted) {
          await sleep(pollIntervalMs, signal);
          if (signal?.aborted) return;
          const next = await attach.logs({ cursor });
          cursor = next.cursor;
          for (const chunk of next.chunks) yield chunk;
          if (next.exit) return;
        }
      },
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<NimbusProcessLogChunk> {
    return this.stream()[Symbol.asyncIterator]();
  }
}

function idComponent(value: string, field: string): string {
  const text = String(value);
  if (!isNimbusIdComponent(text)) {
    throw new Error(`Nimbus ${field} must be 1-128 ASCII letters, digits, dot, underscore, or hyphen`);
  }
  return text;
}

function boundedPollInterval(value: number | undefined): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(25, Math.min(5000, Math.floor(Number(value))));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function isNimbusTarget(value: unknown): value is NimbusTarget {
  return !!value && typeof value === 'object' && 'kind' in value;
}

function normalizeBasePath(path: string): string {
  const trimmed = trimSlashes(String(path || '/api/nimbus/v1'));
  return `/${trimmed}`;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/**
 * Resolve an exec `cwd` to the absolute POSIX path the session shell needs.
 * Absolute inputs pass through untouched; relative ones resolve against the
 * sandbox root, collapsing `.`/`..` segments (`rel` → `<root>/rel`,
 * `../x` → the sibling of root). The session filesystem is always POSIX —
 * `node:path` is not portable across every SDK host, so this resolves by
 * segment instead of importing it.
 */
function resolveSandboxCwd(root: string, cwd: string): string {
  if (cwd.startsWith('/')) return cwd;
  const segments: string[] = [];
  for (const seg of `${root}/${cwd}`.split('/')) {
    if (seg === '..') {
      // A '..' at the filesystem root stays at the root, POSIX-style.
      if (segments.length > 0) segments.pop();
    } else if (seg !== '' && seg !== '.') {
      segments.push(seg);
    }
  }
  return '/' + segments.join('/');
}

async function resolveHeaders(input: NimbusHeaders | undefined): Promise<HeadersInit | undefined> {
  if (!input) return undefined;
  return typeof input === 'function' ? await input() : input;
}

