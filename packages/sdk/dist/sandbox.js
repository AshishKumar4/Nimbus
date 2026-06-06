/**
 * @nimbus-sh/sdk/sandbox - programmatic Nimbus sandbox handle.
 */
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
        const namespace = this.target.namespace;
        const id = namespace.idFromName(this.doName);
        return namespace.get(id);
    }
    remoteStub() {
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
            _rpcDestroy: (options) => this.remoteRpc('destroy', [options]),
        };
    }
    async remoteRpc(op, args) {
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
    async ready() {
        if (!this.readyPromise) {
            const preinstall = this.profile.runtimes?.preinstall ?? [];
            for (const spec of preinstall)
                this.assertRuntimeAllowed(spec, 'preinstall');
            this.readyPromise = this.stub()._rpcReady({ preinstall }).then(() => undefined);
        }
        return this.readyPromise;
    }
    async exec(command, options = {}) {
        await this.ready();
        return this.stub()._rpcExec(command, this.execOptions(options));
    }
    async startProcess(command, options = {}) {
        await this.ready();
        return this.stub()._rpcStartProcess(command, this.execOptions(options));
    }
    async runCode(code, options = {}) {
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
    async destroy(options = {}) {
        this.readyPromise = null;
        return this.stub()._rpcDestroy(options);
    }
    files = {
        read: async (path) => {
            await this.ready();
            return this.stub()._rpcReadFile(path);
        },
        readBytes: async (path) => {
            await this.ready();
            return this.stub()._rpcReadFileBytes(path);
        },
        write: async (path, content) => {
            await this.ready();
            return this.stub()._rpcWriteFile(path, content);
        },
        stat: async (path) => {
            await this.ready();
            return this.stub()._rpcStat(path);
        },
        list: async (path = this.root) => {
            await this.ready();
            return this.stub()._rpcReaddir(path);
        },
        mkdir: async (path) => {
            await this.ready();
            return this.stub()._rpcMkdir(path);
        },
        exists: async (path) => {
            await this.ready();
            return this.stub()._rpcExists(path);
        },
        delete: async (path, options = {}) => {
            await this.ready();
            return this.stub()._rpcDeleteFile(path, options);
        },
    };
    runtimes = {
        available: async () => {
            await this.ready();
            return (await this.stub()._rpcListRuntimes()).available;
        },
        installed: async () => {
            await this.ready();
            return (await this.stub()._rpcListRuntimes()).installed;
        },
        list: async () => {
            await this.ready();
            return this.stub()._rpcListRuntimes();
        },
        install: async (spec, options = {}) => {
            this.assertRuntimeAllowed(spec, 'onDemand');
            await this.ready();
            return this.stub()._rpcInstallRuntime(spec, options);
        },
        ensure: async (specs, options = {}) => {
            const list = Array.isArray(specs) ? specs : [specs];
            for (const spec of list)
                this.assertRuntimeAllowed(spec, 'onDemand');
            await this.ready();
            return this.stub()._rpcEnsureRuntimes(list, options);
        },
    };
    processes = {
        list: async () => {
            await this.ready();
            return this.stub()._rpcListProcesses();
        },
        kill: async (pid) => {
            await this.ready();
            return this.stub()._rpcKillProcess(pid);
        },
        logs: async (pid, options = {}) => {
            await this.ready();
            return this.stub()._rpcProcessLogs(pid, options);
        },
    };
    ports = {
        list: async () => {
            await this.ready();
            return this.stub()._rpcListPorts();
        },
        expose: async (port) => {
            await this.ready();
            const result = await this.stub()._rpcExposePort(port);
            return { ...result, url: this.portUrl(port) };
        },
        unexpose: async (port) => {
            await this.ready();
            return this.stub()._rpcUnexposePort(port);
        },
        url: (port) => this.portUrl(port),
    };
    tools(options = {}) {
        const namespace = options.namespace ?? this.profile.tools?.namespace ?? 'nimbus';
        const kind = options.kind ?? this.profile.tools?.kind ?? 'nimbus';
        const callPath = (input) => typeof input === 'string' ? input : String(input?.path ?? '');
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
                writeFile: { execute: (input) => this.files.write(callPath(input), input.content ?? input.data ?? '') },
                listFiles: { execute: (input = this.root) => this.files.list(callPath(input) || this.root) },
                readdir: { execute: (input = this.root) => this.files.list(callPath(input) || this.root) },
                deleteFile: { execute: (input) => this.files.delete(callPath(input), { recursive: !!input?.recursive }) },
                exists: { execute: (input) => this.files.exists(callPath(input)) },
                startProcess: { execute: (command, opts) => this.startProcess(command, opts) },
                killProcess: { execute: (input) => this.processes.kill(typeof input === 'number' ? input : input.pid) },
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
        ];
        if (hasRuntime('python'))
            caps.push('python');
        if (hasRuntime('clang'))
            caps.push('native_binary');
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
