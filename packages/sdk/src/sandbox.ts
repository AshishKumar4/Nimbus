/**
 * @nimbus-sh/sdk/sandbox - programmatic Nimbus sandbox handle.
 */

import {
  buildPreviewHost,
  buildPublicPreviewHost,
  isPreviewHostSafeSid,
  readPreviewHostSuffix,
} from '@nimbus-sh/worker/preview-host';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { z } from 'zod/v4';

export type RuntimeSpec = string;
export type RuntimeName =
  | 'node'
  | 'bun'
  | 'npm'
  | 'git'
  | 'python'
  | 'ruby'
  | 'clang'
  | 'shell'
  | (string & {});

export interface NimbusRuntimePolicy {
  preinstall?: RuntimeSpec[];
  onDemand?: boolean;
  allow?: RuntimeName[];
}

export interface NimbusSandboxProfile {
  root?: string;
  runtimes?: NimbusRuntimePolicy;
  tools?: {
    namespace?: string;
    kind?: string;
  };
  preview?: {
    baseUrl?: string;
    pathStyle?: boolean;
  };
}

export interface NimbusConfig {
  endpoint?: string;
  /**
   * The deployment's `NIMBUS_PREVIEW_HOST_SUFFIX`, enabling the
   * `<port>--<sid>.<suffix>` preview origin. `Nimbus.fromEnv` reads it off
   * the bindings, so in-Worker callers never restate it; remote clients
   * (`Nimbus.connect`) have no bindings and must supply it to get host-form
   * preview URLs.
   */
  previewHostSuffix?: string;
  sandboxes?: Record<string, NimbusSandboxProfile>;
}

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
}

export interface NimbusExecOptions {
  /**
   * Run in a named shell whose cwd and environment persist between calls, the
   * way a terminal tab does. Omitted, the call runs on the session's one shell
   * and remembers nothing — the behaviour every programmatic exec has had.
   */
  shellId?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  /**
   * Identity the command runs as. Omitted, the spawn inherits the session
   * user, which is what every programmatic exec has always run as.
   */
  cred?: VfsCred;
  /**
   * `startProcess` only: what to do when the process exits on its own with
   * a non-zero code. 'never' (default) leaves it stopped; 'on-failure'
   * restarts it under the session's restart budget with backoff. A platform
   * reset re-drives the process either way.
   */
  restart?: NimbusRestartPolicy;
}

export type NimbusRestartPolicy = 'never' | 'on-failure';
export type NimbusAppVisibility = 'scoped' | 'public';

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
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Read `length` bytes at `offset` without materializing the whole file. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  list(path?: string): Promise<{ name: string; type: string }[]>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The trailing wire argument a credentialed file op carries, or nothing. */
function fileWireOptions(cred: VfsCred | undefined): [] | [{ cred: VfsCred }] {
  return cred === undefined ? [] : [{ cred }];
}

/**
 * An application target: a port, a pid, a name, or an owner — every
 * `apps.*` verb takes one. A bare number is a port when something listens
 * on it or a reservation names it, else a pid; a bare string is a name
 * first, then an owner. The object forms are unambiguous.
 */
export type NimbusAppTarget =
  | number
  | string
  | { port: number }
  | { pid: number }
  | { name: string }
  | { owner: string };

export interface NimbusExposedApp {
  /** The application's identity: derived (`auto:…`) for an ordinary process, explicit for a durable worker app. */
  owner: string;
  name: string | null;
  port: number;
  pid: number | null;
  capability: string | null;
  visibility: NimbusAppVisibility;
  /** Browser-facing URL, built the way `ports.url` builds one; undefined when the deployment is not addressable. */
  url: string | undefined;
}

export interface NimbusApp {
  owner: string;
  name: string | null;
  port: number | null;
  pid: number | null;
  status: 'running' | 'starting' | 'stopped' | 'failed';
  visibility: NimbusAppVisibility;
  capability: string | null;
  restart: NimbusRestartPolicy;
  /** With status 'failed': what went wrong, e.g. `listened on 3000, owns 5173`. */
  diagnostic: string | null;
  url: string | undefined;
}

export interface NimbusExecResult {
  command: string;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
  duration: number;
  timestamp: number;
}

export interface NimbusTerminalSize {
  columns: number;
  rows: number;
}

export interface NimbusDestroyOptions {
  reason?: string;
}

export interface NimbusDestroyResult {
  ok: true;
  killed: number;
  destroyedAt: number;
  reason: string | null;
}

/**
 * A started background process. It is still running when `startProcess`
 * returns, so there is no exit code or captured output here — poll
 * `processes.logs(pid)` (which carries the exit record once it lands),
 * `processes.list()`, or `processes.attach(pid)`.
 */
export interface NimbusStartResult {
  command: string;
  pid: number;
  process: NimbusProcess;
  ports: NimbusPort[];
  startedAt: number;
}

export interface NimbusProcess {
  pid: number;
  command: string;
  argv: string[];
  cwd: string;
  state: string;
  exitCode: number | null;
  startTime: number;
  endTime: number | null;
  longRunning: boolean;
  attachedTty: boolean;
}

export interface NimbusProcessLogChunk {
  seq: number;
  ts: number;
  stream: 'stdout' | 'stderr';
  data: string;
  binary?: boolean;
}

export interface NimbusProcessExitInfo {
  code: number;
  at: number;
  reason?: string;
}

export interface NimbusProcessLogsOptions {
  cursor?: number;
  lines?: number;
  bytes?: number;
}

export interface NimbusProcessLogsResult {
  pid: number;
  chunks: NimbusProcessLogChunk[];
  text: string;
  cursor: number;
  truncated: boolean;
  exit: NimbusProcessExitInfo | null;
}

export interface NimbusProcessAttachOptions {
  pollIntervalMs?: number;
  lines?: number;
  bytes?: number;
  signal?: AbortSignal;
}

export interface NimbusPort {
  port: number;
  pid: number;
  registeredAt: number;
  /**
   * Bearer token for THIS port on THIS session. Presenting it on the
   * preview route authorises that one port and nothing else, which is what
   * lets an embedder publish a guest's dev server without publishing the
   * session. A new registration on the port retires it.
   */
  capability: string;
}

export interface NimbusFileStat {
  type: 'file' | 'directory' | string;
  size: number;
  ctime?: number;
  mtime: number;
  mode: number;
}

export interface NimbusRuntimeSummary {
  name: string;
  version: string;
  root: string;
  abi: string;
  bins: string[];
  sizeBytes: number;
  license: string;
}

export interface NimbusAvailableRuntime {
  name: string;
  abi: string;
  defaultVersion: string;
  versions: Array<{ version: string; sizeBytes: number; license: string }>;
}

interface NimbusSessionStub {
  _rpcReady(options?: { preinstall?: string[] }): Promise<{ ok: true; preinstalled: string[] }>;
  _rpcExec(command: string, options?: Record<string, unknown>): Promise<NimbusExecResult>;
  _rpcStartProcess(command: string, options?: Record<string, unknown>): Promise<NimbusStartResult>;
  _rpcRunCode(code: string, options?: Record<string, unknown>): Promise<NimbusExecResult>;
  // The file methods' third slot is the session's `pid` — a process claim
  // the SDK never makes, so it is always `undefined` here — and the slot
  // after it is the host credential `files.as(cred)` binds to.
  _rpcReadFile(path: string, pid?: undefined, cred?: VfsCred): Promise<string | null>;
  _rpcReadFileBytes(path: string, pid?: undefined, cred?: VfsCred): Promise<Uint8Array | null>;
  _rpcWriteFile(path: string, content: string | Uint8Array, pid?: undefined, cred?: VfsCred): Promise<void>;
  _rpcStat(path: string, pid?: undefined, cred?: VfsCred): Promise<NimbusFileStat | null>;
  _rpcLstat(path: string, pid?: undefined, cred?: VfsCred): Promise<NimbusFileStat | null>;
  _rpcReaddir(path: string, pid?: undefined, cred?: VfsCred): Promise<{ name: string; type: string }[]>;
  _rpcRename(from: string, to: string, pid?: undefined, cred?: VfsCred): Promise<void>;
  _rpcChmod(path: string, mode: number, pid?: undefined, cred?: VfsCred): Promise<void>;
  _rpcFsReadRange(path: string, offset: number, length: number, pid?: undefined, cred?: VfsCred): Promise<Uint8Array | null>;
  _rpcExists(path: string, pid?: undefined, cred?: VfsCred): Promise<boolean>;
  _rpcMkdir(path: string, pid?: undefined, cred?: VfsCred): Promise<void>;
  _rpcDeleteFile(path: string, options?: { recursive?: boolean }, cred?: VfsCred): Promise<void>;
  _rpcInstallRuntime(spec: string, options?: { force?: boolean }): Promise<unknown>;
  _rpcEnsureRuntimes(specs: string[], options?: { force?: boolean }): Promise<unknown>;
  _rpcListRuntimes(): Promise<{ installed: NimbusRuntimeSummary[]; available: NimbusAvailableRuntime[] }>;
  _rpcListProcesses(): Promise<NimbusProcess[]>;
  _rpcKillProcess(pid: number): Promise<{ ok: boolean; pid: number }>;
  _rpcWriteProcessInput(pid: number, data: string): Promise<{ ok: boolean; pid: number }>;
  _rpcEndProcessInput(pid: number): Promise<{ ok: boolean; pid: number }>;
  _rpcResizeProcess(pid: number, size: NimbusTerminalSize): Promise<{ ok: boolean; pid: number }>;
  _rpcSignalProcess(pid: number, signal: string): Promise<{ ok: boolean; pid: number }>;
  _rpcProcessLogs(pid: number, options?: NimbusProcessLogsOptions): Promise<NimbusProcessLogsResult>;
  _rpcListPorts(): Promise<NimbusPort[]>;
  _rpcExposePort(port: number, options?: { visibility?: 'scoped' | 'public'; name?: string }): Promise<{ port: number; listening: boolean; pid: number | null; registeredAt: number | null; capability: string | null; visibility?: 'scoped' | 'public'; owner?: string | null; name?: string | null }>;
  _rpcExposeApp(target: NimbusAppTarget, options?: { visibility?: 'scoped' | 'public'; name?: string }): Promise<Omit<NimbusExposedApp, 'url'> & { url: string | null }>;
  _rpcListApps(): Promise<Array<Omit<NimbusApp, 'url'> & { url: string | null }>>;
  _rpcRotateLink(target: NimbusAppTarget): Promise<Omit<NimbusExposedApp, 'url'> & { url: string | null }>;
  _rpcRemoveApp(target: NimbusAppTarget): Promise<{ owner: string; removed: boolean; port: number | null }>;
  _rpcEnsureDurableApp(input: { owner: string; preferredPort?: number; visibility?: 'scoped' | 'public' }): Promise<{ port: number; capability: string | null; visibility: 'scoped' | 'public' }>;
  _rpcRemoveDurableApp(owner: string): Promise<{ owner: string; removed: boolean; port: number | null }>;
  _rpcUnexposePort(port: number): Promise<{ port: number; ok: boolean }>;
  _rpcDestroy(options?: NimbusDestroyOptions): Promise<NimbusDestroyResult>;
}

interface NimbusSessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): NimbusSessionStub;
}

type NimbusTarget =
  | { kind: 'binding'; namespace: NimbusSessionNamespace }
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

const RemoteRpcSuccessSchema = z.object({
  ok: z.literal(true),
  result: z.unknown().optional(),
}).passthrough();

const RemoteRpcFailureSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
}).passthrough();

const WireBytesSchema = z.object({
  __nimbusWireType: z.literal('bytes'),
  base64: z.string(),
}).passthrough();

const UndefinedResultSchema = z.undefined();
const UnknownResultSchema = z.unknown();
/** `_rpcWriteFile` answers with the byte count the VFS wrote. */
const WriteFileResultSchema = z.number();
const StringOrNullSchema = z.string().nullable();
const Uint8ArrayOrNullSchema = z.instanceof(Uint8Array).nullable();
const BooleanResultSchema = z.boolean();

const ReadyResultSchema = z.object({
  ok: z.literal(true),
  preinstalled: z.array(z.string()),
});

const ExecResultSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  duration: z.number(),
  timestamp: z.number(),
});

const ProcessSchema = z.object({
  pid: z.number(),
  command: z.string(),
  argv: z.array(z.string()),
  cwd: z.string(),
  state: z.string(),
  exitCode: z.number().nullable(),
  startTime: z.number(),
  endTime: z.number().nullable(),
  longRunning: z.boolean(),
  attachedTty: z.boolean().optional().default(false),
});

const PortSchema = z.object({
  port: z.number(),
  pid: z.number(),
  registeredAt: z.number(),
  capability: z.string(),
});

const StartResultSchema = z.object({
  command: z.string(),
  pid: z.number(),
  process: ProcessSchema,
  ports: z.array(PortSchema),
  startedAt: z.number(),
});

const FileStatSchema = z.object({
  type: z.string(),
  size: z.number(),
  ctime: z.number().optional(),
  mtime: z.number(),
  mode: z.number(),
});

const DirectoryEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
});

const RuntimeSummarySchema = z.object({
  name: z.string(),
  version: z.string(),
  root: z.string(),
  abi: z.string(),
  bins: z.array(z.string()),
  sizeBytes: z.number(),
  license: z.string(),
});

const AvailableRuntimeSchema = z.object({
  name: z.string(),
  abi: z.string(),
  defaultVersion: z.string(),
  versions: z.array(z.object({
    version: z.string(),
    sizeBytes: z.number(),
    license: z.string(),
  })),
});

const RuntimeListSchema = z.object({
  installed: z.array(RuntimeSummarySchema),
  available: z.array(AvailableRuntimeSchema),
});

const ProcessControlResultSchema = z.object({
  ok: z.boolean(),
  pid: z.number(),
});

const ProcessLogChunkSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
  binary: z.boolean().optional(),
});

const ProcessExitInfoSchema = z.object({
  code: z.number(),
  at: z.number(),
  reason: z.string().optional(),
});

const ProcessLogsResultSchema = z.object({
  pid: z.number(),
  chunks: z.array(ProcessLogChunkSchema),
  text: z.string(),
  cursor: z.number(),
  truncated: z.boolean(),
  exit: ProcessExitInfoSchema.nullable(),
});

const ExposedPortSchema = z.object({
  port: z.number(),
  listening: z.boolean(),
  pid: z.number().nullable(),
  registeredAt: z.number().nullable(),
  capability: z.string().nullable(),
  visibility: z.enum(['scoped', 'public']).optional(),
  owner: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});

const ExposedAppSchema = z.object({
  owner: z.string(),
  name: z.string().nullable(),
  port: z.number(),
  pid: z.number().nullable(),
  capability: z.string().nullable(),
  visibility: z.enum(['scoped', 'public']),
  url: z.string().nullable(),
});

const AppSchema = z.object({
  owner: z.string(),
  name: z.string().nullable(),
  port: z.number().nullable(),
  pid: z.number().nullable(),
  status: z.enum(['running', 'starting', 'stopped', 'failed']),
  visibility: z.enum(['scoped', 'public']),
  capability: z.string().nullable(),
  restart: z.enum(['never', 'on-failure']),
  diagnostic: z.string().nullable(),
  url: z.string().nullable(),
});

const EnsureDurableAppSchema = z.object({
  port: z.number(),
  capability: z.string().nullable(),
  visibility: z.enum(['scoped', 'public']),
});

const RemoveDurableAppSchema = z.object({
  owner: z.string(),
  removed: z.boolean(),
  port: z.number().nullable(),
});

const UnexposedPortSchema = z.object({
  port: z.number(),
  ok: z.boolean(),
});

const DestroyResultSchema = z.object({
  ok: z.literal(true),
  killed: z.number(),
  destroyedAt: z.number(),
  reason: z.string().nullable(),
});

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
    return this.options.root ?? this.profile.root ?? '/home/user';
  }

  private stub(): NimbusSessionStub {
    if (this.target.kind === 'remote') return this.remoteStub();
    const id = this.target.namespace.idFromName(this.doName);
    return this.target.namespace.get(id);
  }

  private remoteStub(): NimbusSessionStub {
    return {
      _rpcReady: (options) => this.remoteRpc('ready', [options], ReadyResultSchema),
      _rpcExec: (command, options) => this.remoteRpc('exec', [command, options], ExecResultSchema),
      _rpcStartProcess: (command, options) => this.remoteRpc('startProcess', [command, options], StartResultSchema),
      _rpcRunCode: (code, options) => this.remoteRpc('runCode', [code, options], ExecResultSchema),
      // A credential rides the wire as a trailing `{ cred }` options object
      // so the payload names it explicitly; the remote dispatcher decides
      // what to do with it (today: refuse, as it refuses `cred` on exec).
      _rpcReadFile: (path, _pid, cred) => this.remoteRpc('readFile', [path, ...fileWireOptions(cred)], StringOrNullSchema),
      _rpcReadFileBytes: (path, _pid, cred) => this.remoteRpc('readFileBytes', [path, ...fileWireOptions(cred)], Uint8ArrayOrNullSchema),
      _rpcWriteFile: async (path, content, _pid, cred) => {
        // The byte count is the wire contract but not part of the public
        // `files.write` surface, so it is validated and dropped. Declaring
        // this `undefined` made every remote write throw after succeeding.
        await this.remoteRpc('writeFile', [path, content, ...fileWireOptions(cred)], WriteFileResultSchema);
      },
      _rpcStat: (path, _pid, cred) => this.remoteRpc('stat', [path, ...fileWireOptions(cred)], FileStatSchema.nullable()),
      _rpcLstat: (path, _pid, cred) => this.remoteRpc('lstat', [path, ...fileWireOptions(cred)], FileStatSchema.nullable()),
      _rpcRename: (from, to, _pid, cred) => this.remoteRpc('rename', [from, to, ...fileWireOptions(cred)], UndefinedResultSchema),
      _rpcChmod: (path, mode, _pid, cred) => this.remoteRpc('chmod', [path, mode, ...fileWireOptions(cred)], UndefinedResultSchema),
      _rpcFsReadRange: (path, offset, length, _pid, cred) =>
        this.remoteRpc('readRange', [path, offset, length, ...fileWireOptions(cred)], Uint8ArrayOrNullSchema),
      _rpcReaddir: (path, _pid, cred) => this.remoteRpc('readdir', [path, ...fileWireOptions(cred)], z.array(DirectoryEntrySchema)),
      _rpcExists: (path, _pid, cred) => this.remoteRpc('exists', [path, ...fileWireOptions(cred)], BooleanResultSchema),
      _rpcMkdir: (path, _pid, cred) => this.remoteRpc('mkdir', [path, ...fileWireOptions(cred)], UndefinedResultSchema),
      _rpcDeleteFile: (path, options, cred) =>
        this.remoteRpc('deleteFile', [path, { ...(options ?? {}), ...(cred !== undefined ? { cred } : {}) }], UndefinedResultSchema),
      _rpcInstallRuntime: (spec, options) => this.remoteRpc('installRuntime', [spec, options], UnknownResultSchema),
      _rpcEnsureRuntimes: (specs, options) => this.remoteRpc('ensureRuntimes', [specs, options], UnknownResultSchema),
      _rpcListRuntimes: () => this.remoteRpc('listRuntimes', [], RuntimeListSchema),
      _rpcListProcesses: () => this.remoteRpc('listProcesses', [], z.array(ProcessSchema)),
      _rpcKillProcess: (pid) => this.remoteRpc('killProcess', [pid], ProcessControlResultSchema),
      _rpcWriteProcessInput: (pid, data) => this.remoteRpc('writeProcessInput', [pid, data], ProcessControlResultSchema),
      _rpcEndProcessInput: (pid) => this.remoteRpc('endProcessInput', [pid], ProcessControlResultSchema),
      _rpcResizeProcess: (pid, size) => this.remoteRpc('resizeProcess', [pid, size], ProcessControlResultSchema),
      _rpcSignalProcess: (pid, signal) => this.remoteRpc('signalProcess', [pid, signal], ProcessControlResultSchema),
      _rpcProcessLogs: (pid, options) => this.remoteRpc('processLogs', [pid, options], ProcessLogsResultSchema),
      _rpcListPorts: () => this.remoteRpc('listPorts', [], z.array(PortSchema)),
      _rpcExposePort: (port, options) => this.remoteRpc('exposePort', [port, options], ExposedPortSchema),
      _rpcEnsureDurableApp: (input) => this.remoteRpc('ensureDurableApp', [input], EnsureDurableAppSchema),
      _rpcRemoveDurableApp: (owner) => this.remoteRpc('removeDurableApp', [{ owner }], RemoveDurableAppSchema),
      _rpcExposeApp: (target, options) => this.remoteRpc('exposeApp', [target, options], ExposedAppSchema),
      _rpcListApps: () => this.remoteRpc('listApps', [], z.array(AppSchema)),
      _rpcRotateLink: (target) => this.remoteRpc('rotateLink', [target], ExposedAppSchema),
      _rpcRemoveApp: (target) => this.remoteRpc('removeApp', [target], RemoveDurableAppSchema),
      _rpcUnexposePort: (port) => this.remoteRpc('unexposePort', [port], UnexposedPortSchema),
      _rpcDestroy: (options) => this.remoteRpc('destroy', [options], DestroyResultSchema),
    };
  }

  private async remoteRpc<T>(op: string, args: unknown[], resultSchema: z.ZodType<T>): Promise<T> {
    if (this.target.kind !== 'remote') {
      throw new Error('Nimbus internal error: remoteRpc called on non-remote target');
    }

    const headers = new Headers(await resolveHeaders(this.target.headers));
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', 'application/json');
    if (this.target.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.target.token}`);
    }

    const response = await this.target.fetch(
      `${this.target.endpoint}${this.target.basePath}/sandboxes/${encodeURIComponent(this.id)}/rpc`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(encodeWire({
          profile: this.profileName,
          tenant: this.options.tenant,
          subject: this.options.subject,
          root: this.root,
          op,
          args,
        })),
      },
    );

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new NimbusRemoteError(`Nimbus remote API returned non-JSON response (${response.status})`, {
          status: response.status,
          body: text,
        });
      }
    }

    const success = RemoteRpcSuccessSchema.safeParse(payload);
    if (!response.ok || !success.success) {
      const failure = RemoteRpcFailureSchema.safeParse(payload);
      const message = failure.success
        ? failure.data.error ?? failure.data.message ?? `Nimbus remote API request failed (${response.status})`
        : `Nimbus remote API request failed (${response.status})`;
      throw new NimbusRemoteError(message, {
        status: response.status,
        code: failure.success ? failure.data.code : undefined,
        body: payload,
      });
    }

    return resultSchema.parse(decodeWire(success.data.result));
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) {
      const preinstall = this.profile.runtimes?.preinstall ?? [];
      for (const spec of preinstall) this.assertRuntimeAllowed(spec, 'preinstall');
      this.readyPromise = this.rpc(this.stub()._rpcReady({ preinstall })).then(() => undefined);
    }
    return this.readyPromise;
  }

  async exec(command: string, options: NimbusExecOptions = {}): Promise<NimbusExecResult> {
    await this.ready();
    return this.rpc(this.stub()._rpcExec(command, this.execOptions(options)));
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
    options: NimbusExecOptions & {
      language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
      install?: 'never' | 'ifMissing';
    } = {},
  ): Promise<NimbusExecResult> {
    const language = options.language ?? 'javascript';
    if (language === 'python' || language === 'ruby') {
      this.assertRuntimeAllowed(language, options.install === 'ifMissing' ? 'onDemand' : 'use');
    }
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
        return this.rpc(this.stub()._rpcWriteFile(path, content, undefined, cred));
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
      list: async (path = this.root): Promise<{ name: string; type: string }[]> => {
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

  private exposedApp(result: Omit<NimbusExposedApp, 'url'> & { url: string | null }): NimbusExposedApp {
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
    const allow = this.profile.runtimes?.allow;
    const hasRuntime = (name: string) => !allow || allow.includes(name);
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

  private execOptions(options: NimbusExecOptions): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...options };
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

  private assertRuntimeAllowed(spec: RuntimeSpec, action: 'preinstall' | 'onDemand' | 'use'): void {
    const policy = this.profile.runtimes;
    const allow = policy?.allow;
    const name = String(spec).split('@')[0] as RuntimeName;
    if (allow && !allow.includes(name)) {
      throw new Error(`Nimbus runtime '${name}' is not allowed by sandbox profile '${this.profileName}'`);
    }
    if (action !== 'onDemand' || policy?.onDemand !== false) return;
    const preinstalled = new Set((policy.preinstall ?? []).map((s) => String(s).split('@')[0]));
    if (!preinstalled.has(name)) {
      throw new Error(
        `Nimbus runtime '${name}' is not preinstalled and on-demand runtime installs are disabled by sandbox profile '${this.profileName}'`,
      );
    }
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
      // The name stands where the port stands when the app has one. The
      // public form names its bearer in the label: a public port with a
      // capability builds the unauthenticated host, anything else keeps the
      // session-attached one.
      const label = options.name ?? port;
      if (options.visibility === 'public' && options.capability !== undefined) {
        return `https://${buildPublicPreviewHost(this.id, label, options.capability, hostSuffix)}/`;
      }
      return `https://${buildPreviewHost(this.id, label, hostSuffix)}/`;
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
    disposeSdkRpcResult(value);
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
  if (!isIdComponent(text)) {
    throw new Error(`Nimbus ${field} must be 1-128 ASCII letters, digits, dot, underscore, or hyphen`);
  }
  return text;
}

function isIdComponent(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isPunctuation = code === 45 || code === 46 || code === 95;
    if (!isDigit && !isUpper && !isLower && !isPunctuation) return false;
  }
  return true;
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

type DisposableSymbolConstructor = SymbolConstructor & { readonly dispose?: symbol };

function disposeSdkRpcResult(value: unknown): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  const disposerKey = (Symbol as DisposableSymbolConstructor).dispose;
  if (!disposerKey) return;
  const disposer = Reflect.get(value, disposerKey);
  if (typeof disposer !== 'function') return;
  try {
    Reflect.apply(disposer, value, []);
  } catch {
    // Disposal only releases Worker RPC bookkeeping. Preserve SDK behavior.
  }
}

async function resolveHeaders(input: NimbusHeaders | undefined): Promise<HeadersInit | undefined> {
  if (!input) return undefined;
  return typeof input === 'function' ? await input() : input;
}

function encodeWire(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      __nimbusWireType: 'bytes',
      base64: bytesToBase64(value),
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      __nimbusWireType: 'bytes',
      base64: bytesToBase64(new Uint8Array(value)),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      __nimbusWireType: 'bytes',
      base64: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
    };
  }
  if (Array.isArray(value)) return value.map(encodeWire);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = encodeWire(item);
    }
    return out;
  }
  return value;
}

function decodeWire(value: unknown): unknown {
  const bytes = WireBytesSchema.safeParse(value);
  if (bytes.success) return base64ToBytes(bytes.data.base64);
  if (Array.isArray(value)) return value.map(decodeWire);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = decodeWire(item);
    }
    return out;
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
