import { z } from 'zod/v4';
import type { VfsCred } from './os-contracts.js';
import type { ProcessTerminalSize } from './process-io-protocol.js';
export declare const SessionProcessSchema: z.ZodObject<{
    pid: z.ZodNumber;
    command: z.ZodString;
    argv: z.ZodArray<z.ZodString>;
    cwd: z.ZodString;
    state: z.ZodString;
    exitCode: z.ZodNullable<z.ZodNumber>;
    startTime: z.ZodNumber;
    endTime: z.ZodNullable<z.ZodNumber>;
    longRunning: z.ZodBoolean;
    attachedTty: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    execId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SessionProcess = z.infer<typeof SessionProcessSchema>;
export declare const SessionPortSchema: z.ZodObject<{
    port: z.ZodNumber;
    pid: z.ZodNumber;
    registeredAt: z.ZodNumber;
    capability: z.ZodString;
    execId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SessionPort = z.infer<typeof SessionPortSchema>;
export declare const SessionStartResultSchema: z.ZodObject<{
    command: z.ZodString;
    pid: z.ZodNumber;
    process: z.ZodObject<{
        pid: z.ZodNumber;
        command: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
        cwd: z.ZodString;
        state: z.ZodString;
        exitCode: z.ZodNullable<z.ZodNumber>;
        startTime: z.ZodNumber;
        endTime: z.ZodNullable<z.ZodNumber>;
        longRunning: z.ZodBoolean;
        attachedTty: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    ports: z.ZodArray<z.ZodObject<{
        port: z.ZodNumber;
        pid: z.ZodNumber;
        registeredAt: z.ZodNumber;
        capability: z.ZodString;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    startedAt: z.ZodNumber;
}, z.core.$strip>;
/** A background process is still running; exit/output arrive through process logs. */
export type SessionStartResult = z.infer<typeof SessionStartResultSchema>;
export declare const SessionFileStatSchema: z.ZodObject<{
    type: z.ZodString;
    size: z.ZodNumber;
    ctime: z.ZodOptional<z.ZodNumber>;
    mtime: z.ZodNumber;
    mode: z.ZodNumber;
}, z.core.$strip>;
export type SessionFileStat = z.infer<typeof SessionFileStatSchema>;
export declare const SessionDirectoryEntrySchema: z.ZodObject<{
    name: z.ZodString;
    type: z.ZodString;
}, z.core.$strip>;
export type SessionDirectoryEntry = z.infer<typeof SessionDirectoryEntrySchema>;
export declare const SessionRuntimeSummarySchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodString;
    root: z.ZodString;
    abi: z.ZodString;
    bins: z.ZodArray<z.ZodString>;
    sizeBytes: z.ZodNumber;
    license: z.ZodString;
}, z.core.$strip>;
export type SessionRuntimeSummary = z.infer<typeof SessionRuntimeSummarySchema>;
export declare const SessionAvailableRuntimeSchema: z.ZodObject<{
    name: z.ZodString;
    abi: z.ZodString;
    defaultVersion: z.ZodString;
    versions: z.ZodArray<z.ZodObject<{
        version: z.ZodString;
        sizeBytes: z.ZodNumber;
        license: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type SessionAvailableRuntime = z.infer<typeof SessionAvailableRuntimeSchema>;
export declare const SessionRuntimeInstallSchema: z.ZodObject<{
    spec: z.ZodString;
    exitCode: z.ZodNumber;
    stdout: z.ZodString;
    stderr: z.ZodString;
}, z.core.$strip>;
export type SessionRuntimeInstallResult = z.infer<typeof SessionRuntimeInstallSchema>;
export declare const SessionProcessLogChunkSchema: z.ZodObject<{
    seq: z.ZodNumber;
    ts: z.ZodNumber;
    stream: z.ZodEnum<{
        stdout: "stdout";
        stderr: "stderr";
    }>;
    data: z.ZodString;
    binary: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type SessionProcessLogChunk = z.infer<typeof SessionProcessLogChunkSchema>;
export declare const SessionProcessExitSchema: z.ZodObject<{
    code: z.ZodNumber;
    at: z.ZodNumber;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SessionProcessExit = z.infer<typeof SessionProcessExitSchema>;
export declare const SessionProcessLogsOptionsSchema: z.ZodObject<{
    cursor: z.ZodOptional<z.ZodNumber>;
    lines: z.ZodOptional<z.ZodNumber>;
    bytes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type SessionProcessLogsOptions = z.infer<typeof SessionProcessLogsOptionsSchema>;
export declare const SessionProcessLogsSchema: z.ZodObject<{
    pid: z.ZodNumber;
    chunks: z.ZodArray<z.ZodObject<{
        seq: z.ZodNumber;
        ts: z.ZodNumber;
        stream: z.ZodEnum<{
            stdout: "stdout";
            stderr: "stderr";
        }>;
        data: z.ZodString;
        binary: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    text: z.ZodString;
    cursor: z.ZodNumber;
    truncated: z.ZodBoolean;
    exit: z.ZodNullable<z.ZodObject<{
        code: z.ZodNumber;
        at: z.ZodNumber;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type SessionProcessLogs = z.infer<typeof SessionProcessLogsSchema>;
export declare const SessionVisibilitySchema: z.ZodEnum<{
    scoped: "scoped";
    public: "public";
}>;
export type SessionAppVisibility = z.infer<typeof SessionVisibilitySchema>;
export declare const SessionRestartPolicySchema: z.ZodEnum<{
    never: "never";
    "on-failure": "on-failure";
}>;
export type SessionRestartPolicy = z.infer<typeof SessionRestartPolicySchema>;
export declare const SessionExposedPortSchema: z.ZodObject<{
    port: z.ZodNumber;
    listening: z.ZodBoolean;
    pid: z.ZodNullable<z.ZodNumber>;
    registeredAt: z.ZodNullable<z.ZodNumber>;
    capability: z.ZodNullable<z.ZodString>;
    visibility: z.ZodOptional<z.ZodEnum<{
        scoped: "scoped";
        public: "public";
    }>>;
    owner: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    execId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SessionExposedAppSchema: z.ZodObject<{
    owner: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    port: z.ZodNumber;
    pid: z.ZodNullable<z.ZodNumber>;
    capability: z.ZodNullable<z.ZodString>;
    visibility: z.ZodEnum<{
        scoped: "scoped";
        public: "public";
    }>;
    url: z.ZodNullable<z.ZodString>;
    execId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SessionExposedApp = z.infer<typeof SessionExposedAppSchema>;
export declare const SessionAppSchema: z.ZodObject<{
    owner: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    port: z.ZodNullable<z.ZodNumber>;
    pid: z.ZodNullable<z.ZodNumber>;
    status: z.ZodEnum<{
        running: "running";
        starting: "starting";
        stopped: "stopped";
        failed: "failed";
    }>;
    visibility: z.ZodEnum<{
        scoped: "scoped";
        public: "public";
    }>;
    capability: z.ZodNullable<z.ZodString>;
    restart: z.ZodEnum<{
        never: "never";
        "on-failure": "on-failure";
    }>;
    diagnostic: z.ZodNullable<z.ZodString>;
    url: z.ZodNullable<z.ZodString>;
    execId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SessionApp = z.infer<typeof SessionAppSchema>;
export declare const SessionDestroyResultSchema: z.ZodObject<{
    ok: z.ZodLiteral<true>;
    killed: z.ZodNumber;
    destroyedAt: z.ZodNumber;
    reason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type SessionDestroyResult = z.infer<typeof SessionDestroyResultSchema>;
/** JSON answers after the common wire codec; execStream travels as a byte stream. */
declare const SessionResultSchemas: {
    ready: z.ZodObject<{
        ok: z.ZodLiteral<true>;
        preinstalled: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    bootProbe: z.ZodObject<{
        ok: z.ZodLiteral<true>;
    }, z.core.$strip>;
    exec: z.ZodObject<{
        command: z.ZodString;
        exitCode: z.ZodNumber;
        success: z.ZodBoolean;
        duration: z.ZodNumber;
        timestamp: z.ZodNumber;
        stdout: z.ZodString;
        stderr: z.ZodString;
    }, z.core.$strip>;
    startProcess: z.ZodObject<{
        command: z.ZodString;
        pid: z.ZodNumber;
        process: z.ZodObject<{
            pid: z.ZodNumber;
            command: z.ZodString;
            argv: z.ZodArray<z.ZodString>;
            cwd: z.ZodString;
            state: z.ZodString;
            exitCode: z.ZodNullable<z.ZodNumber>;
            startTime: z.ZodNumber;
            endTime: z.ZodNullable<z.ZodNumber>;
            longRunning: z.ZodBoolean;
            attachedTty: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            execId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        ports: z.ZodArray<z.ZodObject<{
            port: z.ZodNumber;
            pid: z.ZodNumber;
            registeredAt: z.ZodNumber;
            capability: z.ZodString;
            execId: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        startedAt: z.ZodNumber;
    }, z.core.$strip>;
    runCode: z.ZodObject<{
        command: z.ZodString;
        exitCode: z.ZodNumber;
        success: z.ZodBoolean;
        duration: z.ZodNumber;
        timestamp: z.ZodNumber;
        stdout: z.ZodString;
        stderr: z.ZodString;
    }, z.core.$strip>;
    readFile: z.ZodNullable<z.ZodString>;
    readFileBytes: z.ZodNullable<z.ZodType<Uint8Array<ArrayBufferLike>, unknown, z.core.$ZodTypeInternals<Uint8Array<ArrayBufferLike>, unknown>>>;
    writeFile: z.ZodNumber;
    stat: z.ZodNullable<z.ZodObject<{
        type: z.ZodString;
        size: z.ZodNumber;
        ctime: z.ZodOptional<z.ZodNumber>;
        mtime: z.ZodNumber;
        mode: z.ZodNumber;
    }, z.core.$strip>>;
    lstat: z.ZodNullable<z.ZodObject<{
        type: z.ZodString;
        size: z.ZodNumber;
        ctime: z.ZodOptional<z.ZodNumber>;
        mtime: z.ZodNumber;
        mode: z.ZodNumber;
    }, z.core.$strip>>;
    readdir: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodString;
    }, z.core.$strip>>;
    rename: z.ZodUndefined;
    chmod: z.ZodUndefined;
    readRange: z.ZodNullable<z.ZodType<Uint8Array<ArrayBufferLike>, unknown, z.core.$ZodTypeInternals<Uint8Array<ArrayBufferLike>, unknown>>>;
    exists: z.ZodBoolean;
    mkdir: z.ZodUndefined;
    deleteFile: z.ZodUndefined;
    installRuntime: z.ZodObject<{
        spec: z.ZodString;
        exitCode: z.ZodNumber;
        stdout: z.ZodString;
        stderr: z.ZodString;
    }, z.core.$strip>;
    ensureRuntimes: z.ZodArray<z.ZodObject<{
        spec: z.ZodString;
        exitCode: z.ZodNumber;
        stdout: z.ZodString;
        stderr: z.ZodString;
    }, z.core.$strip>>;
    listRuntimes: z.ZodObject<{
        installed: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
            root: z.ZodString;
            abi: z.ZodString;
            bins: z.ZodArray<z.ZodString>;
            sizeBytes: z.ZodNumber;
            license: z.ZodString;
        }, z.core.$strip>>;
        available: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            abi: z.ZodString;
            defaultVersion: z.ZodString;
            versions: z.ZodArray<z.ZodObject<{
                version: z.ZodString;
                sizeBytes: z.ZodNumber;
                license: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    listProcesses: z.ZodArray<z.ZodObject<{
        pid: z.ZodNumber;
        command: z.ZodString;
        argv: z.ZodArray<z.ZodString>;
        cwd: z.ZodString;
        state: z.ZodString;
        exitCode: z.ZodNullable<z.ZodNumber>;
        startTime: z.ZodNumber;
        endTime: z.ZodNullable<z.ZodNumber>;
        longRunning: z.ZodBoolean;
        attachedTty: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    killProcess: z.ZodObject<{
        ok: z.ZodBoolean;
        pid: z.ZodNumber;
    }, z.core.$strip>;
    writeProcessInput: z.ZodObject<{
        ok: z.ZodBoolean;
        pid: z.ZodNumber;
    }, z.core.$strip>;
    endProcessInput: z.ZodObject<{
        ok: z.ZodBoolean;
        pid: z.ZodNumber;
    }, z.core.$strip>;
    resizeProcess: z.ZodObject<{
        ok: z.ZodBoolean;
        pid: z.ZodNumber;
    }, z.core.$strip>;
    signalProcess: z.ZodObject<{
        ok: z.ZodBoolean;
        pid: z.ZodNumber;
    }, z.core.$strip>;
    processLogs: z.ZodObject<{
        pid: z.ZodNumber;
        chunks: z.ZodArray<z.ZodObject<{
            seq: z.ZodNumber;
            ts: z.ZodNumber;
            stream: z.ZodEnum<{
                stdout: "stdout";
                stderr: "stderr";
            }>;
            data: z.ZodString;
            binary: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>>;
        text: z.ZodString;
        cursor: z.ZodNumber;
        truncated: z.ZodBoolean;
        exit: z.ZodNullable<z.ZodObject<{
            code: z.ZodNumber;
            at: z.ZodNumber;
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    listPorts: z.ZodArray<z.ZodObject<{
        port: z.ZodNumber;
        pid: z.ZodNumber;
        registeredAt: z.ZodNumber;
        capability: z.ZodString;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    exposePort: z.ZodObject<{
        port: z.ZodNumber;
        listening: z.ZodBoolean;
        pid: z.ZodNullable<z.ZodNumber>;
        registeredAt: z.ZodNullable<z.ZodNumber>;
        capability: z.ZodNullable<z.ZodString>;
        visibility: z.ZodOptional<z.ZodEnum<{
            scoped: "scoped";
            public: "public";
        }>>;
        owner: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        name: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    exposeApp: z.ZodObject<{
        owner: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        port: z.ZodNumber;
        pid: z.ZodNullable<z.ZodNumber>;
        capability: z.ZodNullable<z.ZodString>;
        visibility: z.ZodEnum<{
            scoped: "scoped";
            public: "public";
        }>;
        url: z.ZodNullable<z.ZodString>;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    listApps: z.ZodArray<z.ZodObject<{
        owner: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        port: z.ZodNullable<z.ZodNumber>;
        pid: z.ZodNullable<z.ZodNumber>;
        status: z.ZodEnum<{
            running: "running";
            starting: "starting";
            stopped: "stopped";
            failed: "failed";
        }>;
        visibility: z.ZodEnum<{
            scoped: "scoped";
            public: "public";
        }>;
        capability: z.ZodNullable<z.ZodString>;
        restart: z.ZodEnum<{
            never: "never";
            "on-failure": "on-failure";
        }>;
        diagnostic: z.ZodNullable<z.ZodString>;
        url: z.ZodNullable<z.ZodString>;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    rotateLink: z.ZodObject<{
        owner: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        port: z.ZodNumber;
        pid: z.ZodNullable<z.ZodNumber>;
        capability: z.ZodNullable<z.ZodString>;
        visibility: z.ZodEnum<{
            scoped: "scoped";
            public: "public";
        }>;
        url: z.ZodNullable<z.ZodString>;
        execId: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    removeApp: z.ZodObject<{
        owner: z.ZodString;
        removed: z.ZodBoolean;
        port: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    ensureDurableApp: z.ZodObject<{
        port: z.ZodNumber;
        capability: z.ZodNullable<z.ZodString>;
        visibility: z.ZodEnum<{
            scoped: "scoped";
            public: "public";
        }>;
    }, z.core.$strip>;
    removeDurableApp: z.ZodObject<{
        owner: z.ZodString;
        removed: z.ZodBoolean;
        port: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    unexposePort: z.ZodObject<{
        port: z.ZodNumber;
        ok: z.ZodBoolean;
    }, z.core.$strip>;
    destroy: z.ZodObject<{
        ok: z.ZodLiteral<true>;
        killed: z.ZodNumber;
        destroyedAt: z.ZodNumber;
        reason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
};
export type SessionJsonOperation = keyof typeof SessionResultSchemas;
export type SessionOperation = SessionJsonOperation | 'execStream';
export type SessionResult<Op extends SessionJsonOperation> = z.infer<(typeof SessionResultSchemas)[Op]>;
export declare const SessionResults: {
    [Op in SessionJsonOperation]: z.ZodType<SessionResult<Op>>;
};
export declare const SessionRequestSchema: z.ZodObject<{
    profile: z.ZodOptional<z.ZodString>;
    tenant: z.ZodOptional<z.ZodString>;
    subject: z.ZodOptional<z.ZodString>;
    root: z.ZodOptional<z.ZodString>;
    op: z.ZodOptional<z.ZodString>;
    args: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
}, z.core.$loose>;
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export declare const SessionSuccessSchema: z.ZodObject<{
    ok: z.ZodLiteral<true>;
    result: z.ZodOptional<z.ZodUnknown>;
}, z.core.$loose>;
export declare const SessionFailureSchema: z.ZodObject<{
    ok: z.ZodOptional<z.ZodBoolean>;
    error: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export interface SessionReadyOptions {
    preinstall?: string[];
}
export interface SessionExecOptions extends SessionReadyOptions {
    /** A named shell keeps cwd/environment; unnamed executions share neither. */
    shellId?: string;
    /** Initial cwd of a named shell with no saved state yet. */
    shellRoot?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
    /** Colocated callers only; remote tokens cannot choose a filesystem identity. */
    cred?: VfsCred;
    /** A caller's tag, inherited by descendant processes and reported by ports/apps. */
    execId?: string;
    /** startProcess only; spontaneous failures follow this restart policy. */
    restart?: SessionRestartPolicy;
}
export interface SessionRunCodeOptions extends SessionExecOptions {
    language?: string;
    install?: 'never' | 'ifMissing';
}
export type SessionTerminalSize = ProcessTerminalSize;
export interface SessionDestroyOptions {
    reason?: string;
}
export interface SessionExposeOptions {
    visibility?: SessionAppVisibility;
    name?: string;
}
export interface SessionDurableAppOptions extends SessionExposeOptions {
    owner: string;
    preferredPort?: number;
}
export interface SessionRuntimeInstallOptions {
    force?: boolean;
}
export type SessionAppTarget = number | string | {
    port: number;
} | {
    pid: number;
} | {
    name: string;
} | {
    owner: string;
};
/** The programmatic wire surface shared by DO, HTTP and hosted-session adapters.
 * File pid slots are preserved for the supervisor wire; SDK callers make no process claim.
 */
export interface SessionRpc {
    _rpcReady(options?: SessionReadyOptions): Promise<SessionResult<'ready'>>;
    _rpcExecStream(command: string, options?: SessionExecOptions): Promise<ReadableStream<Uint8Array>>;
    _rpcStartProcess(command: string, options?: SessionExecOptions): Promise<SessionStartResult>;
    _rpcRunCode(code: string, options?: SessionRunCodeOptions): Promise<SessionResult<'runCode'>>;
    _rpcReadFile(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readFile'>>;
    _rpcReadFileBytes(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readFileBytes'>>;
    _rpcWriteFile(path: string, content: string | Uint8Array, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'writeFile'>>;
    _rpcStat(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'stat'>>;
    _rpcLstat(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'lstat'>>;
    _rpcReaddir(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readdir'>>;
    _rpcRename(from: string, to: string, pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcChmod(path: string, mode: number, pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcFsReadRange(path: string, offset: number, length: number, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readRange'>>;
    _rpcExists(path: string, pid?: undefined, cred?: VfsCred): Promise<boolean>;
    _rpcMkdir(path: string, pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcDeleteFile(path: string, options?: {
        recursive?: boolean;
    }, cred?: VfsCred): Promise<void>;
    _rpcInstallRuntime(spec: string, options?: SessionRuntimeInstallOptions): Promise<SessionResult<'installRuntime'>>;
    _rpcEnsureRuntimes(specs: string[], options?: SessionRuntimeInstallOptions): Promise<SessionResult<'ensureRuntimes'>>;
    _rpcListRuntimes(): Promise<SessionResult<'listRuntimes'>>;
    _rpcListProcesses(): Promise<SessionProcess[]>;
    _rpcKillProcess(pid: number): Promise<SessionResult<'killProcess'>>;
    _rpcWriteProcessInput(pid: number, data: string): Promise<SessionResult<'writeProcessInput'>>;
    _rpcEndProcessInput(pid: number): Promise<SessionResult<'endProcessInput'>>;
    _rpcResizeProcess(pid: number, size: SessionTerminalSize): Promise<SessionResult<'resizeProcess'>>;
    _rpcSignalProcess(pid: number, signal: string): Promise<SessionResult<'signalProcess'>>;
    _rpcProcessLogs(pid: number, options?: SessionProcessLogsOptions): Promise<SessionProcessLogs>;
    _rpcListPorts(): Promise<SessionPort[]>;
    _rpcExposePort(port: number, options?: SessionExposeOptions): Promise<SessionResult<'exposePort'>>;
    _rpcExposeApp(target: SessionAppTarget, options?: SessionExposeOptions): Promise<SessionExposedApp>;
    _rpcListApps(): Promise<SessionApp[]>;
    _rpcRotateLink(target: SessionAppTarget): Promise<SessionExposedApp>;
    _rpcRemoveApp(target: SessionAppTarget): Promise<SessionResult<'removeApp'>>;
    _rpcEnsureDurableApp(input: SessionDurableAppOptions): Promise<SessionResult<'ensureDurableApp'>>;
    _rpcRemoveDurableApp(owner: string): Promise<SessionResult<'removeDurableApp'>>;
    _rpcUnexposePort(port: number): Promise<SessionResult<'unexposePort'>>;
    _rpcDestroy(options?: SessionDestroyOptions): Promise<SessionDestroyResult>;
}
/** Placement diagnostics belong only to the remotely addressable session. */
export interface SessionRouterRpc extends SessionRpc {
    _rpcBootProbe(): Promise<SessionResult<'bootProbe'>>;
}
export {};
//# sourceMappingURL=session-protocol.d.ts.map