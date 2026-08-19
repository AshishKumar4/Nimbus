import {
  LEGACY_PUBLIC_DO_SEGMENT,
} from '../_shared/session-router.js';
import { z } from 'zod/v4';
import {
  requireScopes,
  requireSessionPin,
  verifyRequestToken,
  NimbusAuthError,
  isNimbusIdComponent,
  type NimbusAuthEnv,
  type VerifiedNimbusToken,
} from '../auth/index.js';
import { useRpcResource } from '@nimbus-sh/core/_shared/rpc-dispose.js';

export type NimbusRuntimeName =
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
  preinstall?: string[];
  onDemand?: boolean;
  allow?: NimbusRuntimeName[];
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
  /** Deployment's `NIMBUS_PREVIEW_HOST_SUFFIX`. See the SDK's `NimbusConfig`. */
  previewHostSuffix?: string;
  sandboxes?: Record<string, NimbusSandboxProfile>;
}

export interface NimbusRemoteApiConfig {
  /** Enable the remote programmatic sandbox API. */
  enabled?: boolean;
  /** Route prefix. Defaults to `/api/nimbus/v1`. */
  basePath?: string;
  /**
   * Permit unauthenticated remote calls when JWT_SECRET is absent. This is
   * intended only for private development deployments.
   */
  allowLegacy?: boolean;
  /**
   * Required token scopes. Tokens without an explicit `scopes` claim keep the
   * existing full-trust semantics.
   */
  requiredScopes?: string[];
}

export interface NimbusSdkRouterConfig {
  remote?: boolean | NimbusRemoteApiConfig;
  config?: NimbusConfig;
}

interface NimbusSessionRpcStub {
  _rpcReady(options?: { preinstall?: string[] }): Promise<unknown>;
  _rpcBootProbe(): Promise<unknown>;
  _rpcExec(command: string, options?: Record<string, unknown>): Promise<unknown>;
  _rpcStartProcess(command: string, options?: Record<string, unknown>): Promise<unknown>;
  _rpcRunCode(code: string, options?: Record<string, unknown>): Promise<unknown>;
  _rpcReadFile(path: string): Promise<unknown>;
  _rpcReadFileBytes(path: string): Promise<unknown>;
  _rpcWriteFile(path: string, content: string | Uint8Array): Promise<unknown>;
  _rpcStat(path: string): Promise<unknown>;
  _rpcLstat(path: string): Promise<unknown>;
  _rpcReaddir(path: string): Promise<unknown>;
  _rpcRename(from: string, to: string): Promise<unknown>;
  _rpcChmod(path: string, mode: number): Promise<unknown>;
  _rpcFsReadRange(path: string, offset: number, length: number): Promise<unknown>;
  _rpcExists(path: string): Promise<unknown>;
  _rpcMkdir(path: string): Promise<unknown>;
  _rpcDeleteFile(path: string, options?: Record<string, unknown>): Promise<unknown>;
  _rpcInstallRuntime(spec: string, options?: Record<string, unknown>): Promise<unknown>;
  _rpcEnsureRuntimes(specs: string[], options?: Record<string, unknown>): Promise<unknown>;
  _rpcListRuntimes(): Promise<unknown>;
  _rpcListProcesses(): Promise<unknown>;
  _rpcKillProcess(pid: number): Promise<unknown>;
  _rpcWriteProcessInput(pid: number, data: string): Promise<unknown>;
  _rpcEndProcessInput(pid: number): Promise<unknown>;
  _rpcResizeProcess(pid: number, size: { columns: number; rows: number }): Promise<unknown>;
  _rpcSignalProcess(pid: number, signal: string): Promise<unknown>;
  _rpcProcessLogs(pid: number, options?: { cursor?: number; lines?: number; bytes?: number }): Promise<unknown>;
  _rpcListPorts(): Promise<unknown>;
  _rpcExposePort(port: number): Promise<unknown>;
  _rpcUnexposePort(port: number): Promise<unknown>;
  _rpcDestroy(options?: Record<string, unknown>): Promise<unknown>;
}

interface NimbusSessionNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): NimbusSessionRpcStub;
}

interface NimbusRemoteEnv extends Partial<NimbusAuthEnv> {
  NIMBUS_SESSION?: NimbusSessionNamespace;
}

interface RemoteContext {
  env: NimbusRemoteEnv;
  stub: NimbusSessionRpcStub;
  body: RemoteRpcBody;
  profileName: string;
  profile: NimbusSandboxProfile;
  root: string;
  verified: VerifiedNimbusToken | null;
}

interface RemoteAuthResult {
  tenantSegment: string;
  verified: VerifiedNimbusToken | null;
}

const DEFAULT_REMOTE_BASE_PATH = '/api/nimbus/v1';

const RemoteRpcBodySchema = z.object({
  profile: z.string().optional(),
  tenant: z.string().optional(),
  subject: z.string().optional(),
  root: z.string().optional(),
  op: z.string().optional(),
  args: z.array(z.unknown()).optional(),
}).passthrough();

type RemoteRpcBody = z.infer<typeof RemoteRpcBodySchema>;

const WireBytesSchema = z.object({
  __nimbusWireType: z.literal('bytes'),
  base64: z.string(),
}).passthrough();

export async function handleNimbusRemoteApi(
  request: Request,
  env: NimbusRemoteEnv,
  sdk: NimbusSdkRouterConfig | undefined,
): Promise<Response | null> {
  const remote = normalizeRemoteConfig(sdk?.remote);
  if (!remote.enabled) return null;

  const url = new URL(request.url);
  const match = matchRemoteRpc(url.pathname, remote.basePath);
  if (!match) return null;

  if (request.method === 'OPTIONS') return corsResponse(null, 204);
  if (request.method !== 'POST') {
    return remoteJson({ ok: false, error: 'Method not allowed', code: 'E_METHOD_NOT_ALLOWED' }, 405);
  }
  if (!env?.NIMBUS_SESSION) {
    return remoteJson({ ok: false, error: 'NIMBUS_SESSION binding is missing', code: 'E_NIMBUS_BINDING_MISSING' }, 500);
  }
  if (!isNimbusIdComponent(match.sandboxId)) {
    return remoteJson({ ok: false, error: 'Invalid sandbox id', code: 'E_SANDBOX_ID' }, 400);
  }

  let body: RemoteRpcBody;
  try {
    body = RemoteRpcBodySchema.parse(decodeWire(await request.json()));
  } catch (e: unknown) {
    return remoteJson({ ok: false, error: `Invalid JSON body: ${errorMessage(e)}`, code: 'E_BAD_JSON' }, 400);
  }

  const remoteAuth = await resolveRemoteAuth(
    request,
    env,
    remote,
    match.sandboxId,
  );
  if (remoteAuth instanceof Response) return remoteAuth;

  const profileName = body.profile ?? 'default';
  const profile = sdk?.config?.sandboxes?.[profileName]
    ?? sdk?.config?.sandboxes?.default
    ?? {};
  const root = body.root ?? profile.root ?? '/home/user';
  const doName = `${remoteAuth.tenantSegment}:${match.sandboxId}`;
  const id = env.NIMBUS_SESSION.idFromName(doName);
  const stub = env.NIMBUS_SESSION.get(id);

  const ctx: RemoteContext = {
    env,
    stub,
    body,
    profileName,
    profile,
    root,
    verified: remoteAuth.verified,
  };

  try {
    // perf(boot): the awaited stub call is a cross-isolate RPC = real I/O,
    // so Date.now() advances across it (workerd otherwise clamps observable
    // time inside an isolate). This yields authoritative DO-side wall time
    // for the operation — the only way to attribute the session
    // create→ready budget, since intra-DO clocks are frozen. Surfaced as
    // `rpcMs` only when the caller sets `diag`, so the normal SDK envelope
    // is unchanged.
    const wantDiag = body.diag === true;
    const t0 = Date.now();
    return await useRpcResource(
      dispatchRemoteRpc(ctx),
      (result) => remoteJson(wantDiag ? { ok: true, result, rpcMs: Date.now() - t0 } : { ok: true, result }),
    );
  } catch (e: unknown) {
    const err = remoteError(e);
    return remoteJson({
      ok: false,
      error: err.message,
      code: err.code,
    }, err.httpStatus);
  }
}

function normalizeRemoteConfig(remote: boolean | NimbusRemoteApiConfig | undefined): Required<NimbusRemoteApiConfig> {
  const value = typeof remote === 'object' ? remote : {};
  return {
    enabled: remote === true || value.enabled === true,
    basePath: normalizeBasePath(value.basePath ?? DEFAULT_REMOTE_BASE_PATH),
    allowLegacy: value.allowLegacy === true,
    requiredScopes: value.requiredScopes ?? ['sandbox:use'],
  };
}

function matchRemoteRpc(pathname: string, basePath: string): { sandboxId: string } | null {
  const prefix = `${basePath}/sandboxes/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith('/rpc')) return null;
  const raw = pathname.slice(prefix.length, -'/rpc'.length);
  if (!raw || raw.includes('/')) return null;
  try {
    return { sandboxId: decodeURIComponent(raw) };
  } catch {
    return null;
  }
}

async function resolveRemoteAuth(
  request: Request,
  env: NimbusRemoteEnv,
  remote: Required<NimbusRemoteApiConfig>,
  sandboxId: string,
): Promise<RemoteAuthResult | Response> {
  if (!hasJwtSecret(env)) {
    if (remote.allowLegacy) {
      return {
        tenantSegment: LEGACY_PUBLIC_DO_SEGMENT,
        verified: null,
      };
    }
    return remoteJson({
      ok: false,
      error: 'Remote Nimbus sandbox API requires JWT_SECRET',
      code: 'E_AUTH_CONFIG_MISSING',
    }, 500);
  }

  try {
    const verified = await verifyRequestToken(request, env);
    requireScopes(verified!, remote.requiredScopes);
    requireSessionPin(verified!, sandboxId);
    return {
      tenantSegment: verified!.doInstanceName,
      verified,
    };
  } catch (e) {
    if (e instanceof NimbusAuthError) {
      return remoteJson({ ok: false, error: e.message, code: e.code }, e.httpStatus);
    }
    console.error('[nimbus] remote API auth error:', e);
    return remoteJson({ ok: false, error: 'Internal auth error', code: 'E_AUTH_UNKNOWN' }, 500);
  }
}

async function dispatchRemoteRpc(ctx: RemoteContext): Promise<unknown> {
  const op = ctx.body.op;
  const args = Array.isArray(ctx.body.args) ? ctx.body.args : [];
  switch (op) {
    case 'ready': {
      const options = objectArg(args[0]);
      const preinstall = configuredPreinstall(ctx.profile, options.preinstall);
      for (const spec of preinstall) assertRuntimeAllowed(ctx, spec, 'preinstall');
      return ctx.stub._rpcReady({ preinstall });
    }
    // perf(boot): cold DO-placement + constructor probe. First access to a
    // fresh sandbox id runs the DO constructor but this op does NOT run
    // initSession — combined with `rpcMs` it isolates the platform DO
    // placement floor from the initSession build cost.
    case 'bootProbe':
      return ctx.stub._rpcBootProbe();
    case 'exec':
      return ctx.stub._rpcExec(stringArg(args[0], 'command'), execOptions(ctx, args[1]));
    case 'startProcess':
      return ctx.stub._rpcStartProcess(stringArg(args[0], 'command'), execOptions(ctx, args[1]));
    case 'runCode': {
      const options = execOptions(ctx, args[1]);
      const language = typeof options.language === 'string' ? options.language : 'javascript';
      assertRuntimeForLanguage(ctx, language, options.install);
      return ctx.stub._rpcRunCode(stringArg(args[0], 'code'), options);
    }
    case 'readFile':
      return ctx.stub._rpcReadFile(stringArg(args[0], 'path'));
    case 'readFileBytes':
      return ctx.stub._rpcReadFileBytes(stringArg(args[0], 'path'));
    case 'writeFile':
      return ctx.stub._rpcWriteFile(stringArg(args[0], 'path'), fileContentArg(args[1]));
    case 'stat':
      return ctx.stub._rpcStat(stringArg(args[0], 'path'));
    case 'lstat':
      return ctx.stub._rpcLstat(stringArg(args[0], 'path'));
    case 'rename':
      return ctx.stub._rpcRename(stringArg(args[0], 'from'), stringArg(args[1], 'to'));
    case 'chmod':
      return ctx.stub._rpcChmod(stringArg(args[0], 'path'), numberArg(args[1], 'mode'));
    case 'readRange':
      return ctx.stub._rpcFsReadRange(
        stringArg(args[0], 'path'),
        numberArg(args[1], 'offset'),
        numberArg(args[2], 'length'),
      );
    case 'readdir':
      return ctx.stub._rpcReaddir(stringArg(args[0], 'path'));
    case 'exists':
      return ctx.stub._rpcExists(stringArg(args[0], 'path'));
    case 'mkdir':
      return ctx.stub._rpcMkdir(stringArg(args[0], 'path'));
    case 'deleteFile':
      return ctx.stub._rpcDeleteFile(stringArg(args[0], 'path'), objectArg(args[1]));
    case 'installRuntime': {
      const spec = stringArg(args[0], 'spec');
      assertRuntimeAllowed(ctx, spec, 'onDemand');
      return ctx.stub._rpcInstallRuntime(spec, objectArg(args[1]));
    }
    case 'ensureRuntimes': {
      const specs = arrayArg(args[0], 'specs').map((s) => String(s));
      for (const spec of specs) assertRuntimeAllowed(ctx, spec, 'onDemand');
      return ctx.stub._rpcEnsureRuntimes(specs, objectArg(args[1]));
    }
    case 'listRuntimes':
      return ctx.stub._rpcListRuntimes();
    case 'listProcesses':
      return ctx.stub._rpcListProcesses();
    case 'killProcess':
      return ctx.stub._rpcKillProcess(numberArg(args[0], 'pid'));
    case 'writeProcessInput':
      return ctx.stub._rpcWriteProcessInput(numberArg(args[0], 'pid'), stringArg(args[1], 'data'));
    case 'endProcessInput':
      return ctx.stub._rpcEndProcessInput(numberArg(args[0], 'pid'));
    case 'resizeProcess': {
      const size = objectArg(args[1]);
      return ctx.stub._rpcResizeProcess(numberArg(args[0], 'pid'), {
        columns: numberArg(size.columns, 'columns'),
        rows: numberArg(size.rows, 'rows'),
      });
    }
    case 'signalProcess':
      return ctx.stub._rpcSignalProcess(numberArg(args[0], 'pid'), stringArg(args[1], 'signal'));
    case 'processLogs':
      return ctx.stub._rpcProcessLogs(numberArg(args[0], 'pid'), processLogOptions(args[1]));
    case 'listPorts':
      return ctx.stub._rpcListPorts();
    case 'exposePort':
      return ctx.stub._rpcExposePort(numberArg(args[0], 'port'));
    case 'unexposePort':
      return ctx.stub._rpcUnexposePort(numberArg(args[0], 'port'));
    case 'destroy':
      requireAnyScope(ctx, ['session:destroy', 'session:admin']);
      return ctx.stub._rpcDestroy(objectArg(args[0]));
    default:
      throw apiError(`Unknown Nimbus sandbox operation: ${String(op)}`, 'E_REMOTE_OP', 400);
  }
}

function requireAnyScope(ctx: RemoteContext, scopes: readonly string[]): void {
  const explicit = ctx.verified?.claims.scopes;
  if (explicit === undefined) return;
  if (scopes.some((scope) => explicit.includes(scope))) return;
  throw apiError(
    `Nimbus token missing required scope: ${scopes.join(' or ')}`,
    'E_SCOPE_MISSING',
    403,
  );
}

function execOptions(ctx: RemoteContext, value: unknown): Record<string, unknown> {
  const options = objectArg(value);
  // The remote boundary authenticates a SESSION, not a user inside it, so a
  // token holder does not get to name the uid its command runs as. Refused
  // rather than dropped: silently running as somebody other than the caller
  // asked for is worse than an error. A colocated embedder holds the DO stub
  // and is trusted with `cred` the same way it is trusted with kernel writes.
  if (options.cred !== undefined) {
    throw apiError('cred is not accepted over the remote API', 'E_ARG_SHAPE', 400);
  }
  return {
    ...options,
    cwd: typeof options.cwd === 'string' ? options.cwd : ctx.root,
  };
}

function processLogOptions(value: unknown): { cursor?: number; lines?: number; bytes?: number } {
  const options = objectArg(value);
  return {
    ...(options.cursor === undefined ? {} : { cursor: numberArg(options.cursor, 'cursor') }),
    ...(options.lines === undefined ? {} : { lines: numberArg(options.lines, 'lines') }),
    ...(options.bytes === undefined ? {} : { bytes: numberArg(options.bytes, 'bytes') }),
  };
}

function configuredPreinstall(profile: NimbusSandboxProfile, requested: unknown): string[] {
  if (Array.isArray(profile.runtimes?.preinstall)) return profile.runtimes!.preinstall!;
  return Array.isArray(requested) ? requested.map((s) => String(s)) : [];
}

function assertRuntimeForLanguage(
  ctx: RemoteContext,
  language: string,
  install: unknown,
): void {
  if (language === 'python' || language === 'ruby') {
    assertRuntimeAllowed(ctx, language, install === 'ifMissing' ? 'onDemand' : 'use');
  } else if (language === 'shell') {
    assertRuntimeAllowed(ctx, 'shell', 'use');
  } else if (language === 'javascript' || language === 'typescript') {
    assertRuntimeAllowed(ctx, 'node', 'use');
  }
}

function assertRuntimeAllowed(
  ctx: RemoteContext,
  spec: string,
  action: 'preinstall' | 'onDemand' | 'use',
): void {
  const policy = ctx.profile.runtimes;
  const name = runtimeName(spec);
  if (policy?.allow && !policy.allow.includes(name)) {
    throw apiError(
      `Nimbus runtime '${name}' is not allowed by sandbox profile '${ctx.profileName}'`,
      'E_RUNTIME_NOT_ALLOWED',
      403,
    );
  }
  if (action !== 'onDemand' || policy?.onDemand !== false) return;
  const preinstalled = new Set((policy.preinstall ?? []).map(runtimeName));
  if (!preinstalled.has(name)) {
    throw apiError(
      `Nimbus runtime '${name}' is not preinstalled and on-demand runtime installs are disabled by sandbox profile '${ctx.profileName}'`,
      'E_RUNTIME_ON_DEMAND_DISABLED',
      403,
    );
  }
}

function runtimeName(spec: string): NimbusRuntimeName {
  return String(spec).split('@')[0] as NimbusRuntimeName;
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayArg(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw apiError(`${name} must be an array`, 'E_ARG_SHAPE', 400);
  return value;
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw apiError(`${name} must be a string`, 'E_ARG_SHAPE', 400);
  return value;
}

function numberArg(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw apiError(`${name} must be a number`, 'E_ARG_SHAPE', 400);
  return number;
}

function fileContentArg(value: unknown): string | Uint8Array {
  if (typeof value === 'string' || value instanceof Uint8Array) return value;
  throw apiError('content must be a string or Uint8Array', 'E_ARG_SHAPE', 400);
}

interface ApiError extends Error {
  code: string;
  httpStatus: number;
}

function apiError(message: string, code: string, status: number): ApiError {
  const err = new Error(message) as ApiError;
  err.code = code;
  err.httpStatus = status;
  return err;
}

function isApiError(value: unknown): value is ApiError {
  return value instanceof Error
    && typeof Reflect.get(value, 'code') === 'string'
    && typeof Reflect.get(value, 'httpStatus') === 'number';
}

function remoteError(value: unknown): ApiError {
  if (isApiError(value)) return value;
  return apiError(errorMessage(value), 'E_NIMBUS_REMOTE_RPC', 500);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function hasJwtSecret(env: NimbusRemoteEnv): env is NimbusRemoteEnv & NimbusAuthEnv {
  return typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
}

function normalizeBasePath(path: string): string {
  const trimmed = trimSlashes(String(path || DEFAULT_REMOTE_BASE_PATH));
  return `/${trimmed}`;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function remoteJson(value: unknown, status = 200): Response {
  return corsResponse(JSON.stringify(encodeWire(value)), status, {
    'Content-Type': 'application/json',
  });
}

function corsResponse(body: BodyInit | null, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
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
