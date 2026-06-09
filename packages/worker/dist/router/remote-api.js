import { LEGACY_PUBLIC_DO_SEGMENT, } from '../_shared/session-router.js';
import { z } from 'zod/v4';
import { requireScopes, requireSessionPin, verifyRequestToken, NimbusAuthError, isNimbusIdComponent, } from '../auth/index.js';
import { useRpcResource } from '../_shared/rpc-dispose.js';
const DEFAULT_REMOTE_BASE_PATH = '/api/nimbus/v1';
const RemoteRpcBodySchema = z.object({
    profile: z.string().optional(),
    tenant: z.string().optional(),
    subject: z.string().optional(),
    root: z.string().optional(),
    op: z.string().optional(),
    args: z.array(z.unknown()).optional(),
}).passthrough();
const WireBytesSchema = z.object({
    __nimbusWireType: z.literal('bytes'),
    base64: z.string(),
}).passthrough();
export async function handleNimbusRemoteApi(request, env, sdk) {
    const remote = normalizeRemoteConfig(sdk?.remote);
    if (!remote.enabled)
        return null;
    const url = new URL(request.url);
    const match = matchRemoteRpc(url.pathname, remote.basePath);
    if (!match)
        return null;
    if (request.method === 'OPTIONS')
        return corsResponse(null, 204);
    if (request.method !== 'POST') {
        return remoteJson({ ok: false, error: 'Method not allowed', code: 'E_METHOD_NOT_ALLOWED' }, 405);
    }
    if (!env?.NIMBUS_SESSION) {
        return remoteJson({ ok: false, error: 'NIMBUS_SESSION binding is missing', code: 'E_NIMBUS_BINDING_MISSING' }, 500);
    }
    if (!isNimbusIdComponent(match.sandboxId)) {
        return remoteJson({ ok: false, error: 'Invalid sandbox id', code: 'E_SANDBOX_ID' }, 400);
    }
    let body;
    try {
        body = RemoteRpcBodySchema.parse(decodeWire(await request.json()));
    }
    catch (e) {
        return remoteJson({ ok: false, error: `Invalid JSON body: ${errorMessage(e)}`, code: 'E_BAD_JSON' }, 400);
    }
    const remoteAuth = await resolveRemoteAuth(request, env, remote, match.sandboxId);
    if (remoteAuth instanceof Response)
        return remoteAuth;
    const profileName = body.profile ?? 'default';
    const profile = sdk?.config?.sandboxes?.[profileName]
        ?? sdk?.config?.sandboxes?.default
        ?? {};
    const root = body.root ?? profile.root ?? '/home/user';
    const doName = `${remoteAuth.tenantSegment}:${match.sandboxId}`;
    const id = env.NIMBUS_SESSION.idFromName(doName);
    const stub = env.NIMBUS_SESSION.get(id);
    const ctx = {
        env,
        stub,
        body,
        profileName,
        profile,
        root,
        verified: remoteAuth.verified,
    };
    try {
        return await useRpcResource(dispatchRemoteRpc(ctx), (result) => remoteJson({ ok: true, result }));
    }
    catch (e) {
        const err = remoteError(e);
        return remoteJson({
            ok: false,
            error: err.message,
            code: err.code,
        }, err.httpStatus);
    }
}
function normalizeRemoteConfig(remote) {
    const value = typeof remote === 'object' ? remote : {};
    return {
        enabled: remote === true || value.enabled === true,
        basePath: normalizeBasePath(value.basePath ?? DEFAULT_REMOTE_BASE_PATH),
        allowLegacy: value.allowLegacy === true,
        requiredScopes: value.requiredScopes ?? ['sandbox:use'],
    };
}
function matchRemoteRpc(pathname, basePath) {
    const prefix = `${basePath}/sandboxes/`;
    if (!pathname.startsWith(prefix) || !pathname.endsWith('/rpc'))
        return null;
    const raw = pathname.slice(prefix.length, -'/rpc'.length);
    if (!raw || raw.includes('/'))
        return null;
    try {
        return { sandboxId: decodeURIComponent(raw) };
    }
    catch {
        return null;
    }
}
async function resolveRemoteAuth(request, env, remote, sandboxId) {
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
        requireScopes(verified, remote.requiredScopes);
        requireSessionPin(verified, sandboxId);
        return {
            tenantSegment: verified.doInstanceName,
            verified,
        };
    }
    catch (e) {
        if (e instanceof NimbusAuthError) {
            return remoteJson({ ok: false, error: e.message, code: e.code }, e.httpStatus);
        }
        console.error('[nimbus] remote API auth error:', e);
        return remoteJson({ ok: false, error: 'Internal auth error', code: 'E_AUTH_UNKNOWN' }, 500);
    }
}
async function dispatchRemoteRpc(ctx) {
    const op = ctx.body.op;
    const args = Array.isArray(ctx.body.args) ? ctx.body.args : [];
    switch (op) {
        case 'ready': {
            const options = objectArg(args[0]);
            const preinstall = configuredPreinstall(ctx.profile, options.preinstall);
            for (const spec of preinstall)
                assertRuntimeAllowed(ctx, spec, 'preinstall');
            return ctx.stub._rpcReady({ preinstall });
        }
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
            for (const spec of specs)
                assertRuntimeAllowed(ctx, spec, 'onDemand');
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
function requireAnyScope(ctx, scopes) {
    const explicit = ctx.verified?.claims.scopes;
    if (explicit === undefined)
        return;
    if (scopes.some((scope) => explicit.includes(scope)))
        return;
    throw apiError(`Nimbus token missing required scope: ${scopes.join(' or ')}`, 'E_SCOPE_MISSING', 403);
}
function execOptions(ctx, value) {
    const options = objectArg(value);
    return {
        ...options,
        cwd: typeof options.cwd === 'string' ? options.cwd : ctx.root,
    };
}
function processLogOptions(value) {
    const options = objectArg(value);
    return {
        ...(options.cursor === undefined ? {} : { cursor: numberArg(options.cursor, 'cursor') }),
        ...(options.lines === undefined ? {} : { lines: numberArg(options.lines, 'lines') }),
        ...(options.bytes === undefined ? {} : { bytes: numberArg(options.bytes, 'bytes') }),
    };
}
function configuredPreinstall(profile, requested) {
    if (Array.isArray(profile.runtimes?.preinstall))
        return profile.runtimes.preinstall;
    return Array.isArray(requested) ? requested.map((s) => String(s)) : [];
}
function assertRuntimeForLanguage(ctx, language, install) {
    if (language === 'python' || language === 'ruby') {
        assertRuntimeAllowed(ctx, language, install === 'ifMissing' ? 'onDemand' : 'use');
    }
    else if (language === 'shell') {
        assertRuntimeAllowed(ctx, 'shell', 'use');
    }
    else if (language === 'javascript' || language === 'typescript') {
        assertRuntimeAllowed(ctx, 'node', 'use');
    }
}
function assertRuntimeAllowed(ctx, spec, action) {
    const policy = ctx.profile.runtimes;
    const name = runtimeName(spec);
    if (policy?.allow && !policy.allow.includes(name)) {
        throw apiError(`Nimbus runtime '${name}' is not allowed by sandbox profile '${ctx.profileName}'`, 'E_RUNTIME_NOT_ALLOWED', 403);
    }
    if (action !== 'onDemand' || policy?.onDemand !== false)
        return;
    const preinstalled = new Set((policy.preinstall ?? []).map(runtimeName));
    if (!preinstalled.has(name)) {
        throw apiError(`Nimbus runtime '${name}' is not preinstalled and on-demand runtime installs are disabled by sandbox profile '${ctx.profileName}'`, 'E_RUNTIME_ON_DEMAND_DISABLED', 403);
    }
}
function runtimeName(spec) {
    return String(spec).split('@')[0];
}
function objectArg(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function arrayArg(value, name) {
    if (!Array.isArray(value))
        throw apiError(`${name} must be an array`, 'E_ARG_SHAPE', 400);
    return value;
}
function stringArg(value, name) {
    if (typeof value !== 'string')
        throw apiError(`${name} must be a string`, 'E_ARG_SHAPE', 400);
    return value;
}
function numberArg(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number))
        throw apiError(`${name} must be a number`, 'E_ARG_SHAPE', 400);
    return number;
}
function fileContentArg(value) {
    if (typeof value === 'string' || value instanceof Uint8Array)
        return value;
    throw apiError('content must be a string or Uint8Array', 'E_ARG_SHAPE', 400);
}
function apiError(message, code, status) {
    const err = new Error(message);
    err.code = code;
    err.httpStatus = status;
    return err;
}
function isApiError(value) {
    return value instanceof Error
        && typeof Reflect.get(value, 'code') === 'string'
        && typeof Reflect.get(value, 'httpStatus') === 'number';
}
function remoteError(value) {
    if (isApiError(value))
        return value;
    return apiError(errorMessage(value), 'E_NIMBUS_REMOTE_RPC', 500);
}
function errorMessage(value) {
    return value instanceof Error ? value.message : String(value);
}
function hasJwtSecret(env) {
    return typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
}
function normalizeBasePath(path) {
    const trimmed = trimSlashes(String(path || DEFAULT_REMOTE_BASE_PATH));
    return `/${trimmed}`;
}
function trimSlashes(value) {
    let start = 0;
    let end = value.length;
    while (start < end && value[start] === '/')
        start++;
    while (end > start && value[end - 1] === '/')
        end--;
    return value.slice(start, end);
}
function remoteJson(value, status = 200) {
    return corsResponse(JSON.stringify(encodeWire(value)), status, {
        'Content-Type': 'application/json',
    });
}
function corsResponse(body, status, headers = {}) {
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
function encodeWire(value) {
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
        const view = value;
        return {
            __nimbusWireType: 'bytes',
            base64: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
        };
    }
    if (Array.isArray(value))
        return value.map(encodeWire);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (item !== undefined)
                out[key] = encodeWire(item);
        }
        return out;
    }
    return value;
}
function decodeWire(value) {
    const bytes = WireBytesSchema.safeParse(value);
    if (bytes.success)
        return base64ToBytes(bytes.data.base64);
    if (Array.isArray(value))
        return value.map(decodeWire);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = decodeWire(item);
        }
        return out;
    }
    return value;
}
function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
