/**
 * @nimbus-sh/sdk/sandbox - programmatic Nimbus sandbox handle.
 */
import { z } from 'zod/v4';
export class NimbusRemoteError extends Error {
    status;
    code;
    body;
    constructor(message, options) {
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
});
const StartResultSchema = ExecResultSchema.extend({
    pid: z.number().nullable(),
    process: ProcessSchema.nullable(),
    ports: z.array(PortSchema),
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
    config;
    static fromEnv(env, config = {}, options = {}) {
        const bindingName = options.binding ?? 'NIMBUS_SESSION';
        const binding = env[bindingName];
        if (!binding) {
            throw new Error(`Nimbus.fromEnv: env.${bindingName} Durable Object binding is missing`);
        }
        return new Nimbus({ kind: 'binding', namespace: binding }, {
            ...config,
            endpoint: options.endpoint ?? config.endpoint,
        });
    }
    static connect(options) {
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
    target;
    constructor(target, config = {}) {
        this.config = config;
        this.target = isNimbusTarget(target)
            ? target
            : { kind: 'binding', namespace: target };
    }
    sandbox(id, options = {}) {
        return new NimbusSandbox(this.target, String(id), options, this.config);
    }
}
export class NimbusSandbox {
    target;
    options;
    config;
    id;
    profileName;
    profile;
    readyPromise = null;
    constructor(target, id, options, config) {
        this.target = target;
        this.options = options;
        this.config = config;
        this.id = idComponent(id, 'sandbox id');
        this.profileName = options.profile ?? 'default';
        this.profile = config.sandboxes?.[this.profileName] ?? config.sandboxes?.default ?? {};
    }
    get tenantSegment() {
        const tenant = idComponent(this.options.tenant ?? 'default', 'tenant');
        const subject = idComponent(this.options.subject ?? '_', 'subject');
        return `${tenant}:${subject}`;
    }
    get doName() {
        return `${this.tenantSegment}:${this.id}`;
    }
    get root() {
        return this.options.root ?? this.profile.root ?? '/home/user';
    }
    stub() {
        if (this.target.kind === 'remote')
            return this.remoteStub();
        const id = this.target.namespace.idFromName(this.doName);
        return this.target.namespace.get(id);
    }
    remoteStub() {
        return {
            _rpcReady: (options) => this.remoteRpc('ready', [options], ReadyResultSchema),
            _rpcExec: (command, options) => this.remoteRpc('exec', [command, options], ExecResultSchema),
            _rpcStartProcess: (command, options) => this.remoteRpc('startProcess', [command, options], StartResultSchema),
            _rpcRunCode: (code, options) => this.remoteRpc('runCode', [code, options], ExecResultSchema),
            _rpcReadFile: (path) => this.remoteRpc('readFile', [path], StringOrNullSchema),
            _rpcReadFileBytes: (path) => this.remoteRpc('readFileBytes', [path], Uint8ArrayOrNullSchema),
            _rpcWriteFile: (path, content) => this.remoteRpc('writeFile', [path, content], UndefinedResultSchema),
            _rpcStat: (path) => this.remoteRpc('stat', [path], FileStatSchema.nullable()),
            _rpcReaddir: (path) => this.remoteRpc('readdir', [path], z.array(DirectoryEntrySchema)),
            _rpcExists: (path) => this.remoteRpc('exists', [path], BooleanResultSchema),
            _rpcMkdir: (path) => this.remoteRpc('mkdir', [path], UndefinedResultSchema),
            _rpcDeleteFile: (path, options) => this.remoteRpc('deleteFile', [path, options], UndefinedResultSchema),
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
            _rpcExposePort: (port) => this.remoteRpc('exposePort', [port], ExposedPortSchema),
            _rpcUnexposePort: (port) => this.remoteRpc('unexposePort', [port], UnexposedPortSchema),
            _rpcDestroy: (options) => this.remoteRpc('destroy', [options], DestroyResultSchema),
        };
    }
    async remoteRpc(op, args, resultSchema) {
        if (this.target.kind !== 'remote') {
            throw new Error('Nimbus internal error: remoteRpc called on non-remote target');
        }
        const headers = new Headers(await resolveHeaders(this.target.headers));
        headers.set('Accept', 'application/json');
        headers.set('Content-Type', 'application/json');
        if (this.target.token && !headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${this.target.token}`);
        }
        const response = await this.target.fetch(`${this.target.endpoint}${this.target.basePath}/sandboxes/${encodeURIComponent(this.id)}/rpc`, {
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
        });
        const text = await response.text();
        let payload = null;
        if (text) {
            try {
                payload = JSON.parse(text);
            }
            catch {
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
    async ready() {
        if (!this.readyPromise) {
            const preinstall = this.profile.runtimes?.preinstall ?? [];
            for (const spec of preinstall)
                this.assertRuntimeAllowed(spec, 'preinstall');
            this.readyPromise = this.rpc(this.stub()._rpcReady({ preinstall })).then(() => undefined);
        }
        return this.readyPromise;
    }
    async exec(command, options = {}) {
        await this.ready();
        return this.rpc(this.stub()._rpcExec(command, this.execOptions(options)));
    }
    async startProcess(command, options = {}) {
        await this.ready();
        return this.rpc(this.stub()._rpcStartProcess(command, this.execOptions(options)));
    }
    async runCode(code, options = {}) {
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
    async destroy(options = {}) {
        this.readyPromise = null;
        return this.rpc(this.stub()._rpcDestroy(options));
    }
    files = {
        read: async (path) => {
            await this.ready();
            return this.rpc(this.stub()._rpcReadFile(path));
        },
        readBytes: async (path) => {
            await this.ready();
            return this.rpc(this.stub()._rpcReadFileBytes(path));
        },
        write: async (path, content) => {
            await this.ready();
            return this.rpc(this.stub()._rpcWriteFile(path, content));
        },
        stat: async (path) => {
            await this.ready();
            return this.rpc(this.stub()._rpcStat(path));
        },
        list: async (path = this.root) => {
            await this.ready();
            return this.rpc(this.stub()._rpcReaddir(path));
        },
        mkdir: async (path) => {
            await this.ready();
            return this.rpc(this.stub()._rpcMkdir(path));
        },
        exists: async (path) => {
            await this.ready();
            return this.rpc(this.stub()._rpcExists(path));
        },
        delete: async (path, options = {}) => {
            await this.ready();
            return this.rpc(this.stub()._rpcDeleteFile(path, options));
        },
    };
    runtimes = {
        available: async () => {
            await this.ready();
            return (await this.rpc(this.stub()._rpcListRuntimes())).available;
        },
        installed: async () => {
            await this.ready();
            return (await this.rpc(this.stub()._rpcListRuntimes())).installed;
        },
        list: async () => {
            await this.ready();
            return this.rpc(this.stub()._rpcListRuntimes());
        },
        install: async (spec, options = {}) => {
            this.assertRuntimeAllowed(spec, 'onDemand');
            await this.ready();
            return this.rpc(this.stub()._rpcInstallRuntime(spec, options));
        },
        ensure: async (specs, options = {}) => {
            const list = Array.isArray(specs) ? specs : [specs];
            for (const spec of list)
                this.assertRuntimeAllowed(spec, 'onDemand');
            await this.ready();
            return this.rpc(this.stub()._rpcEnsureRuntimes(list, options));
        },
    };
    processes = {
        list: async () => {
            await this.ready();
            return this.rpc(this.stub()._rpcListProcesses());
        },
        kill: async (pid) => {
            await this.ready();
            return this.rpc(this.stub()._rpcKillProcess(pid));
        },
        write: async (pid, data) => {
            await this.ready();
            return this.rpc(this.stub()._rpcWriteProcessInput(pid, data));
        },
        endInput: async (pid) => {
            await this.ready();
            return this.rpc(this.stub()._rpcEndProcessInput(pid));
        },
        resize: async (pid, size) => {
            await this.ready();
            return this.rpc(this.stub()._rpcResizeProcess(pid, size));
        },
        signal: async (pid, signal) => {
            await this.ready();
            return this.rpc(this.stub()._rpcSignalProcess(pid, signal));
        },
        logs: async (pid, options = {}) => {
            await this.ready();
            return this.rpc(this.stub()._rpcProcessLogs(pid, options));
        },
        attach: (pid, options = {}) => {
            return new NimbusProcessAttachment(this, pid, options);
        },
    };
    ports = {
        list: async () => {
            await this.ready();
            return this.rpc(this.stub()._rpcListPorts());
        },
        expose: async (port) => {
            await this.ready();
            const result = await this.rpc(this.stub()._rpcExposePort(port));
            return { ...result, url: this.portUrl(port) };
        },
        unexpose: async (port) => {
            await this.ready();
            return this.rpc(this.stub()._rpcUnexposePort(port));
        },
        url: (port) => this.portUrl(port),
    };
    tools(options = {}) {
        const namespace = options.namespace ?? this.profile.tools?.namespace ?? 'nimbus';
        const kind = options.kind ?? this.profile.tools?.kind ?? 'nimbus';
        const callPath = (input) => {
            if (typeof input === 'string')
                return input;
            return ToolPathInputSchema.parse(input).path ?? '';
        };
        const writeFileInput = (input) => {
            const parsed = ToolWriteFileInputSchema.parse(input);
            return {
                path: parsed.path ?? '',
                content: parsed.content ?? parsed.data ?? '',
            };
        };
        const deleteFileInput = (input) => {
            if (typeof input === 'string')
                return { path: input, recursive: false };
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
                exec: { execute: (command, opts) => this.exec(command, opts) },
                runCode: { execute: (code, opts) => this.runCode(code, opts) },
                readFile: { execute: (input) => this.files.read(callPath(input)) },
                writeFile: { execute: (input) => {
                        const parsed = writeFileInput(input);
                        return this.files.write(parsed.path, parsed.content);
                    } },
                listFiles: { execute: (input = this.root) => this.files.list(callPath(input) || this.root) },
                readdir: { execute: (input = this.root) => this.files.list(callPath(input) || this.root) },
                deleteFile: { execute: (input) => {
                        const parsed = deleteFileInput(input);
                        return this.files.delete(parsed.path, { recursive: parsed.recursive });
                    } },
                exists: { execute: (input) => this.files.exists(callPath(input)) },
                startProcess: { execute: (command, opts) => this.startProcess(command, opts) },
                killProcess: { execute: (input) => this.processes.kill(typeof input === 'number' ? input : input.pid) },
                writeProcessInput: { execute: (input) => this.processes.write(input.pid, input.data) },
                endProcessInput: { execute: (input) => this.processes.endInput(typeof input === 'number' ? input : input.pid) },
                resizeProcess: { execute: (input) => this.processes.resize(input.pid, { columns: input.columns, rows: input.rows }) },
                signalProcess: { execute: (input) => this.processes.signal(input.pid, input.signal) },
                logs: { execute: (input) => this.processes.logs(typeof input === 'number' ? input : input.pid, typeof input === 'number' ? {} : input) },
                exposePort: { execute: (input) => this.ports.expose(typeof input === 'number' ? input : input.port) },
                unexposePort: { execute: (input) => this.ports.unexpose(typeof input === 'number' ? input : input.port) },
                listPorts: { execute: () => this.ports.list() },
                installRuntime: { execute: (spec) => this.runtimes.install(spec) },
                listRuntimes: { execute: () => this.runtimes.list() },
            },
        };
    }
    capabilities() {
        const allow = this.profile.runtimes?.allow;
        const hasRuntime = (name) => !allow || allow.includes(name);
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
        if (hasRuntime('python'))
            caps.push('python');
        if (hasRuntime('ruby'))
            caps.push('ruby');
        if (hasRuntime('clang'))
            caps.push('wasi', 'clang_wasi');
        return caps;
    }
    execOptions(options) {
        return {
            ...options,
            cwd: options.cwd ?? this.root,
        };
    }
    assertRuntimeAllowed(spec, action) {
        const policy = this.profile.runtimes;
        const allow = policy?.allow;
        const name = String(spec).split('@')[0];
        if (allow && !allow.includes(name)) {
            throw new Error(`Nimbus runtime '${name}' is not allowed by sandbox profile '${this.profileName}'`);
        }
        if (action !== 'onDemand' || policy?.onDemand !== false)
            return;
        const preinstalled = new Set((policy.preinstall ?? []).map((s) => String(s).split('@')[0]));
        if (!preinstalled.has(name)) {
            throw new Error(`Nimbus runtime '${name}' is not preinstalled and on-demand runtime installs are disabled by sandbox profile '${this.profileName}'`);
        }
    }
    portUrl(port) {
        const explicit = this.profile.preview?.baseUrl;
        if (explicit) {
            const base = trimTrailingSlashes(explicit.replace('{sessionId}', encodeURIComponent(this.id)));
            return `${base}/port/${port}/`;
        }
        const endpoint = this.config.endpoint ? trimTrailingSlashes(this.config.endpoint) : '';
        if (!endpoint)
            return undefined;
        return `${endpoint}/s/${encodeURIComponent(this.id)}/port/${port}/`;
    }
    async rpc(promise) {
        const value = await promise;
        disposeSdkRpcResult(value);
        return value;
    }
}
export class NimbusProcessAttachment {
    sandbox;
    pid;
    options;
    cursor = null;
    constructor(sandbox, pid, options = {}) {
        this.sandbox = sandbox;
        this.pid = pid;
        this.options = options;
    }
    async write(data) {
        return this.sandbox.processes.write(this.pid, data);
    }
    async endInput() {
        return this.sandbox.processes.endInput(this.pid);
    }
    async resize(size) {
        return this.sandbox.processes.resize(this.pid, size);
    }
    async signal(signal) {
        return this.sandbox.processes.signal(this.pid, signal);
    }
    async kill() {
        return this.sandbox.processes.kill(this.pid);
    }
    async logs(options = {}) {
        const result = await this.sandbox.processes.logs(this.pid, options);
        this.cursor = result.cursor;
        return result;
    }
    stream(options = {}) {
        const attach = this;
        const pollIntervalMs = boundedPollInterval(options.pollIntervalMs ?? this.options.pollIntervalMs);
        const signal = options.signal ?? this.options.signal;
        const initialLines = options.lines ?? this.options.lines;
        const initialBytes = options.bytes ?? this.options.bytes;
        return {
            async *[Symbol.asyncIterator]() {
                if (signal?.aborted)
                    return;
                let cursor = attach.cursor;
                if (cursor === null) {
                    const initial = await attach.logs({
                        ...(initialBytes !== undefined ? { bytes: initialBytes } : {}),
                        ...(initialBytes === undefined && initialLines !== undefined ? { lines: initialLines } : {}),
                    });
                    cursor = initial.cursor;
                    for (const chunk of initial.chunks)
                        yield chunk;
                    if (initial.exit || signal?.aborted)
                        return;
                }
                while (!signal?.aborted) {
                    await sleep(pollIntervalMs, signal);
                    if (signal?.aborted)
                        return;
                    const next = await attach.logs({ cursor });
                    cursor = next.cursor;
                    for (const chunk of next.chunks)
                        yield chunk;
                    if (next.exit)
                        return;
                }
            },
        };
    }
    [Symbol.asyncIterator]() {
        return this.stream()[Symbol.asyncIterator]();
    }
}
function idComponent(value, field) {
    const text = String(value);
    if (!isIdComponent(text)) {
        throw new Error(`Nimbus ${field} must be 1-128 ASCII letters, digits, dot, underscore, or hyphen`);
    }
    return text;
}
function isIdComponent(value) {
    if (value.length < 1 || value.length > 128)
        return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        const isDigit = code >= 48 && code <= 57;
        const isUpper = code >= 65 && code <= 90;
        const isLower = code >= 97 && code <= 122;
        const isPunctuation = code === 45 || code === 46 || code === 95;
        if (!isDigit && !isUpper && !isLower && !isPunctuation)
            return false;
    }
    return true;
}
function boundedPollInterval(value) {
    if (!Number.isFinite(value))
        return 100;
    return Math.max(25, Math.min(5000, Math.floor(Number(value))));
}
function sleep(ms, signal) {
    if (signal?.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = () => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}
function isNimbusTarget(value) {
    return !!value && typeof value === 'object' && 'kind' in value;
}
function normalizeBasePath(path) {
    const trimmed = trimSlashes(String(path || '/api/nimbus/v1'));
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
function trimTrailingSlashes(value) {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/')
        end--;
    return value.slice(0, end);
}
function disposeSdkRpcResult(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return;
    const disposerKey = Symbol.dispose;
    if (!disposerKey)
        return;
    const disposer = Reflect.get(value, disposerKey);
    if (typeof disposer !== 'function')
        return;
    try {
        Reflect.apply(disposer, value, []);
    }
    catch {
        // Disposal only releases Worker RPC bookkeeping. Preserve SDK behavior.
    }
}
async function resolveHeaders(input) {
    if (!input)
        return undefined;
    return typeof input === 'function' ? await input() : input;
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
