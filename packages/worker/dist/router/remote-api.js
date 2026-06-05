import { LEGACY_PUBLIC_DO_SEGMENT, } from '../_shared/session-router.js';
import { requireScopes, requireSessionPin, verifyRequestToken, NimbusAuthError, NimbusTokenMalformedError, isNimbusIdComponent, } from '../auth/index.js';
const DEFAULT_REMOTE_BASE_PATH = '/api/nimbus/v1';
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
        body = decodeWire(await request.json());
    }
    catch (e) {
        return remoteJson({ ok: false, error: `Invalid JSON body: ${e?.message || e}`, code: 'E_BAD_JSON' }, 400);
    }
    const tenantSegment = await resolveRemoteTenantSegment(request, env, remote, match.sandboxId);
    if (tenantSegment instanceof Response)
        return tenantSegment;
    const profileName = body.profile ?? 'default';
    const profile = sdk?.config?.sandboxes?.[profileName]
        ?? sdk?.config?.sandboxes?.default
        ?? {};
    const root = body.root ?? profile.root ?? '/home/user';
    const doName = `${tenantSegment}:${match.sandboxId}`;
    const id = env.NIMBUS_SESSION.idFromName(doName);
    const stub = env.NIMBUS_SESSION.get(id);
    const ctx = {
        env,
        stub,
        body,
        profileName,
        profile,
        root,
    };
    try {
        const result = await dispatchRemoteRpc(ctx);
        return remoteJson({ ok: true, result });
    }
    catch (e) {
        return remoteJson({
            ok: false,
            error: e?.message || String(e),
            code: e?.code || 'E_NIMBUS_REMOTE_RPC',
        }, e?.httpStatus || 500);
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
async function resolveRemoteTenantSegment(request, env, remote, sandboxId) {
    const hasSecret = typeof env?.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
    if (!hasSecret) {
        if (remote.allowLegacy)
            return LEGACY_PUBLIC_DO_SEGMENT;
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
        return verified.doInstanceName;
    }
    catch (e) {
        if (e instanceof NimbusAuthError || e instanceof NimbusTokenMalformedError) {
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
            return ctx.stub._rpcWriteFile(stringArg(args[0], 'path'), args[1]);
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
        case 'processLogs':
            return ctx.stub._rpcProcessLogs(numberArg(args[0], 'pid'), objectArg(args[1]));
        case 'listPorts':
            return ctx.stub._rpcListPorts();
        case 'exposePort':
            return ctx.stub._rpcExposePort(numberArg(args[0], 'port'));
        case 'unexposePort':
            return ctx.stub._rpcUnexposePort(numberArg(args[0], 'port'));
        default:
            throw apiError(`Unknown Nimbus sandbox operation: ${String(op)}`, 'E_REMOTE_OP', 400);
    }
}
function execOptions(ctx, value) {
    const options = objectArg(value);
    return {
        ...options,
        cwd: typeof options.cwd === 'string' ? options.cwd : ctx.root,
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
function apiError(message, code, status) {
    const err = new Error(message);
    err.code = code;
    err.httpStatus = status;
    return err;
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
    if (value
        && typeof value === 'object'
        && value.__nimbusWireType === 'bytes'
        && typeof value.base64 === 'string') {
        return base64ToBytes(value.base64);
    }
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
