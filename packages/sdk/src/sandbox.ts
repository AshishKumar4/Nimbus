/**
 * @nimbus-sh/sdk/sandbox - programmatic Nimbus sandbox handle.
 */

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
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
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

export interface NimbusStartResult extends NimbusExecResult {
  pid: number | null;
  process: NimbusProcess | null;
  ports: NimbusPort[];
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
}

export interface NimbusPort {
  port: number;
  pid: number;
  registeredAt: number;
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
  bins: string[];
  sizeBytes: number;
  license: string;
}

export interface NimbusAvailableRuntime {
  name: string;
  defaultVersion: string;
  versions: Array<{ version: string; sizeBytes: number; license: string }>;
}

interface NimbusSessionStub {
  _rpcReady(options?: { preinstall?: string[] }): Promise<{ ok: true; preinstalled: string[] }>;
  _rpcExec(command: string, options?: Record<string, unknown>): Promise<NimbusExecResult>;
  _rpcStartProcess(command: string, options?: Record<string, unknown>): Promise<NimbusStartResult>;
  _rpcRunCode(code: string, options?: Record<string, unknown>): Promise<NimbusExecResult>;
  _rpcReadFile(path: string): Promise<string | null>;
  _rpcReadFileBytes(path: string): Promise<Uint8Array | null>;
  _rpcWriteFile(path: string, content: string | Uint8Array): Promise<void>;
  _rpcStat(path: string): Promise<NimbusFileStat | null>;
  _rpcReaddir(path: string): Promise<{ name: string; type: string }[]>;
  _rpcExists(path: string): Promise<boolean>;
  _rpcMkdir(path: string): Promise<void>;
  _rpcDeleteFile(path: string, options?: { recursive?: boolean }): Promise<void>;
  _rpcInstallRuntime(spec: string, options?: { force?: boolean }): Promise<unknown>;
  _rpcEnsureRuntimes(specs: string[], options?: { force?: boolean }): Promise<unknown>;
  _rpcListRuntimes(): Promise<{ installed: NimbusRuntimeSummary[]; available: NimbusAvailableRuntime[] }>;
  _rpcListProcesses(): Promise<NimbusProcess[]>;
  _rpcKillProcess(pid: number): Promise<{ ok: boolean; pid: number }>;
  _rpcProcessLogs(pid: number, options?: { lines?: number; bytes?: number }): Promise<unknown>;
  _rpcListPorts(): Promise<NimbusPort[]>;
  _rpcExposePort(port: number): Promise<{ port: number; listening: boolean; pid: number | null; registeredAt: number | null }>;
  _rpcUnexposePort(port: number): Promise<{ port: number; ok: boolean }>;
}

type NimbusSessionNamespace = DurableObjectNamespace<any>;

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
    const namespace = this.target.namespace as any;
    const id = namespace.idFromName(this.doName);
    return namespace.get(id) as NimbusSessionStub;
  }

  private remoteStub(): NimbusSessionStub {
    return {
      _rpcReady: (options) => this.remoteRpc('ready', [options]),
      _rpcExec: (command, options) => this.remoteRpc('exec', [command, options]),
      _rpcStartProcess: (command, options) => this.remoteRpc('startProcess', [command, options]),
      _rpcRunCode: (code, options) => this.remoteRpc('runCode', [code, options]),
      _rpcReadFile: (path) => this.remoteRpc('readFile', [path]),
      _rpcReadFileBytes: (path) => this.remoteRpc('readFileBytes', [path]),
      _rpcWriteFile: (path, content) => this.remoteRpc('writeFile', [path, content]),
      _rpcStat: (path) => this.remoteRpc('stat', [path]),
      _rpcReaddir: (path) => this.remoteRpc('readdir', [path]),
      _rpcExists: (path) => this.remoteRpc('exists', [path]),
      _rpcMkdir: (path) => this.remoteRpc('mkdir', [path]),
      _rpcDeleteFile: (path, options) => this.remoteRpc('deleteFile', [path, options]),
      _rpcInstallRuntime: (spec, options) => this.remoteRpc('installRuntime', [spec, options]),
      _rpcEnsureRuntimes: (specs, options) => this.remoteRpc('ensureRuntimes', [specs, options]),
      _rpcListRuntimes: () => this.remoteRpc('listRuntimes', []),
      _rpcListProcesses: () => this.remoteRpc('listProcesses', []),
      _rpcKillProcess: (pid) => this.remoteRpc('killProcess', [pid]),
      _rpcProcessLogs: (pid, options) => this.remoteRpc('processLogs', [pid, options]),
      _rpcListPorts: () => this.remoteRpc('listPorts', []),
      _rpcExposePort: (port) => this.remoteRpc('exposePort', [port]),
      _rpcUnexposePort: (port) => this.remoteRpc('unexposePort', [port]),
    };
  }

  private async remoteRpc(op: string, args: unknown[]): Promise<any> {
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
    let payload: any = null;
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

    if (!response.ok || payload?.ok !== true) {
      const message = payload?.error ?? payload?.message ?? `Nimbus remote API request failed (${response.status})`;
      throw new NimbusRemoteError(message, {
        status: response.status,
        code: payload?.code,
        body: payload,
      });
    }

    return decodeWire(payload.result);
  }

  async ready(): Promise<void> {
    if (!this.readyPromise) {
      const preinstall = this.profile.runtimes?.preinstall ?? [];
      for (const spec of preinstall) this.assertRuntimeAllowed(spec, 'preinstall');
      this.readyPromise = this.stub()._rpcReady({ preinstall }).then(() => undefined);
    }
    return this.readyPromise;
  }

  async exec(command: string, options: NimbusExecOptions = {}): Promise<NimbusExecResult> {
    await this.ready();
    return this.stub()._rpcExec(command, this.execOptions(options));
  }

  async startProcess(command: string, options: NimbusExecOptions = {}): Promise<NimbusStartResult> {
    await this.ready();
    return this.stub()._rpcStartProcess(command, this.execOptions(options));
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
    return this.stub()._rpcRunCode(code, {
      ...this.execOptions(options),
      language,
      install: options.install ?? 'never',
    });
  }

  files = {
    read: async (path: string): Promise<string | null> => {
      await this.ready();
      return this.stub()._rpcReadFile(path);
    },
    readBytes: async (path: string): Promise<Uint8Array | null> => {
      await this.ready();
      return this.stub()._rpcReadFileBytes(path);
    },
    write: async (path: string, content: string | Uint8Array): Promise<void> => {
      await this.ready();
      return this.stub()._rpcWriteFile(path, content);
    },
    stat: async (path: string): Promise<NimbusFileStat | null> => {
      await this.ready();
      return this.stub()._rpcStat(path);
    },
    list: async (path = this.root): Promise<{ name: string; type: string }[]> => {
      await this.ready();
      return this.stub()._rpcReaddir(path);
    },
    mkdir: async (path: string): Promise<void> => {
      await this.ready();
      return this.stub()._rpcMkdir(path);
    },
    exists: async (path: string): Promise<boolean> => {
      await this.ready();
      return this.stub()._rpcExists(path);
    },
    delete: async (path: string, options: { recursive?: boolean } = {}): Promise<void> => {
      await this.ready();
      return this.stub()._rpcDeleteFile(path, options);
    },
  };

  runtimes = {
    available: async (): Promise<NimbusAvailableRuntime[]> => {
      await this.ready();
      return (await this.stub()._rpcListRuntimes()).available;
    },
    installed: async (): Promise<NimbusRuntimeSummary[]> => {
      await this.ready();
      return (await this.stub()._rpcListRuntimes()).installed;
    },
    list: async () => {
      await this.ready();
      return this.stub()._rpcListRuntimes();
    },
    install: async (spec: RuntimeSpec, options: { force?: boolean } = {}) => {
      this.assertRuntimeAllowed(spec, 'onDemand');
      await this.ready();
      return this.stub()._rpcInstallRuntime(spec, options);
    },
    ensure: async (specs: RuntimeSpec | RuntimeSpec[], options: { force?: boolean } = {}) => {
      const list = Array.isArray(specs) ? specs : [specs];
      for (const spec of list) this.assertRuntimeAllowed(spec, 'onDemand');
      await this.ready();
      return this.stub()._rpcEnsureRuntimes(list, options);
    },
  };

  processes = {
    list: async (): Promise<NimbusProcess[]> => {
      await this.ready();
      return this.stub()._rpcListProcesses();
    },
    kill: async (pid: number) => {
      await this.ready();
      return this.stub()._rpcKillProcess(pid);
    },
    logs: async (pid: number, options: { lines?: number; bytes?: number } = {}) => {
      await this.ready();
      return this.stub()._rpcProcessLogs(pid, options);
    },
  };

  ports = {
    list: async (): Promise<NimbusPort[]> => {
      await this.ready();
      return this.stub()._rpcListPorts();
    },
    expose: async (port: number) => {
      await this.ready();
      const result = await this.stub()._rpcExposePort(port);
      return { ...result, url: this.portUrl(port) };
    },
    unexpose: async (port: number) => {
      await this.ready();
      return this.stub()._rpcUnexposePort(port);
    },
    url: (port: number): string | undefined => this.portUrl(port),
  };

  tools(options: { namespace?: string; kind?: string; name?: string } = {}) {
    const namespace = options.namespace ?? this.profile.tools?.namespace ?? 'nimbus';
    const kind = options.kind ?? this.profile.tools?.kind ?? 'nimbus';
    const callPath = (input: unknown): string =>
      typeof input === 'string' ? input : String((input as any)?.path ?? '');
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
        writeFile: { execute: (input: any) => this.files.write(callPath(input), input.content ?? input.data ?? '') },
        listFiles: { execute: (input: unknown = this.root) => this.files.list(callPath(input) || this.root) },
        readdir: { execute: (input: unknown = this.root) => this.files.list(callPath(input) || this.root) },
        deleteFile: { execute: (input: any) => this.files.delete(callPath(input), { recursive: !!input?.recursive }) },
        exists: { execute: (input: unknown) => this.files.exists(callPath(input)) },
        startProcess: { execute: (command: string, opts?: NimbusExecOptions) => this.startProcess(command, opts) },
        killProcess: { execute: (input: number | { pid: number }) => this.processes.kill(typeof input === 'number' ? input : input.pid) },
        logs: { execute: (input: number | { pid: number; lines?: number; bytes?: number }) =>
          this.processes.logs(typeof input === 'number' ? input : input.pid, typeof input === 'number' ? {} : input) },
        exposePort: { execute: (input: number | { port: number }) => this.ports.expose(typeof input === 'number' ? input : input.port) },
        unexposePort: { execute: (input: number | { port: number }) => this.ports.unexpose(typeof input === 'number' ? input : input.port) },
        listPorts: { execute: () => this.ports.list() },
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
    ];
    if (hasRuntime('python')) caps.push('python');
    if (hasRuntime('clang')) caps.push('native_binary');
    return caps;
  }

  private execOptions(options: NimbusExecOptions): Record<string, unknown> {
    return {
      ...options,
      cwd: options.cwd ?? this.root,
    };
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

  private portUrl(port: number): string | undefined {
    const explicit = this.profile.preview?.baseUrl;
    if (explicit) {
      const base = trimTrailingSlashes(explicit.replace('{sessionId}', encodeURIComponent(this.id)));
      return `${base}/port/${port}/`;
    }
    const endpoint = this.config.endpoint ? trimTrailingSlashes(this.config.endpoint) : '';
    if (!endpoint) return undefined;
    return `${endpoint}/s/${encodeURIComponent(this.id)}/port/${port}/`;
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

function decodeWire(value: unknown): any {
  if (
    value
    && typeof value === 'object'
    && (value as any).__nimbusWireType === 'bytes'
    && typeof (value as any).base64 === 'string'
  ) {
    return base64ToBytes((value as any).base64);
  }
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
