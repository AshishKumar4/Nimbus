import { z } from 'zod/v4';
import type { VfsCred } from './os-contracts.js';
import type { ProcessTerminalSize } from './process-io-protocol.js';
/** The process a process starts again, and why (ProcessEntry.restartedFrom). */
export declare const ProcessRestartSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    pid: z.ZodNumber;
    cause: z.ZodLiteral<"session-restart">;
}, z.core.$strip>, z.ZodObject<{
    pid: z.ZodNumber;
    cause: z.ZodLiteral<"exited">;
    exitCode: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    pid: z.ZodNumber;
    cause: z.ZodLiteral<"host-reset">;
}, z.core.$strip>], "cause">;
export type ProcessRestart = z.infer<typeof ProcessRestartSchema>;
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
    restartedFrom: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
        pid: z.ZodNumber;
        cause: z.ZodLiteral<"session-restart">;
    }, z.core.$strip>, z.ZodObject<{
        pid: z.ZodNumber;
        cause: z.ZodLiteral<"exited">;
        exitCode: z.ZodNumber;
    }, z.core.$strip>, z.ZodObject<{
        pid: z.ZodNumber;
        cause: z.ZodLiteral<"host-reset">;
    }, z.core.$strip>], "cause">>;
}, z.core.$strip>;
export type SessionProcess = z.infer<typeof SessionProcessSchema>;
/** A session's terminal as a list shows it: its own is `name: null`; a named one's is `/ws?terminal=<name>`. */
export declare const SessionTerminalSchema: z.ZodObject<{
    name: z.ZodNullable<z.ZodString>;
    live: z.ZodBoolean;
    attached: z.ZodBoolean;
    running: z.ZodNullable<z.ZodString>;
    cwd: z.ZodString;
}, z.core.$strip>;
export type SessionTerminal = z.infer<typeof SessionTerminalSchema>;
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
        restartedFrom: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            pid: z.ZodNumber;
            cause: z.ZodLiteral<"session-restart">;
        }, z.core.$strip>, z.ZodObject<{
            pid: z.ZodNumber;
            cause: z.ZodLiteral<"exited">;
            exitCode: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            pid: z.ZodNumber;
            cause: z.ZodLiteral<"host-reset">;
        }, z.core.$strip>], "cause">>;
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
    ino: z.ZodOptional<z.ZodNumber>;
    revision: z.ZodOptional<z.ZodNumber>;
    dev: z.ZodOptional<z.ZodNumber>;
    nlink: z.ZodOptional<z.ZodNumber>;
    uid: z.ZodOptional<z.ZodNumber>;
    gid: z.ZodOptional<z.ZodNumber>;
    atime: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type SessionFileStat = z.infer<typeof SessionFileStatSchema>;
/** A filesystem's stat (RuntimeVfsStat), as a session's file calls answer with it. */
export declare const RuntimeStatSchema: z.ZodObject<{
    dev: z.ZodNumber;
    ino: z.ZodNumber;
    nlink: z.ZodNumber;
    type: z.ZodEnum<{
        directory: "directory";
        file: "file";
        symlink: "symlink";
    }>;
    size: z.ZodNumber;
    ctime: z.ZodNumber;
    atime: z.ZodNumber;
    mtime: z.ZodNumber;
    mode: z.ZodNumber;
    uid: z.ZodNumber;
    gid: z.ZodNumber;
    revision: z.ZodNumber;
}, z.core.$strip>;
/** Runtime stat uses zero for an unknown inode or revision; the session wire exposes that as absent. */
export declare function sessionFileStatOf(stat: z.infer<typeof RuntimeStatSchema> | null): SessionFileStat | null;
/** mkdir(2)'s options as a session takes them: none is `mkdir -p`, as files.mkdir has always been. */
export interface SessionMkdirOptions {
    recursive?: boolean;
    mode?: number;
}
/** Whether a link's own times or owner change (lutimes, lchown), not its target's. */
export interface SessionFollowOptions {
    followSymlinks?: boolean;
}
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
        stderr: "stderr";
        stdout: "stdout";
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
            stderr: "stderr";
            stdout: "stdout";
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
    public: "public";
    scoped: "scoped";
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
        public: "public";
        scoped: "scoped";
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
        public: "public";
        scoped: "scoped";
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
        failed: "failed";
        running: "running";
        starting: "starting";
        stopped: "stopped";
    }>;
    visibility: z.ZodEnum<{
        public: "public";
        scoped: "scoped";
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
/** waitpid(2)'s answer: an exit code, or the signal that ended it. */
export declare const ExitStatusSchema: z.ZodUnion<readonly [z.ZodObject<{
    code: z.ZodNumber;
    signal: z.ZodNull;
}, z.core.$strip>, z.ZodObject<{
    code: z.ZodNull;
    signal: z.ZodString;
}, z.core.$strip>]>;
/** `id` as a runner's: 1 to 64 of A-Z a-z 0-9 . _ - (a UUID fits); a TypeError otherwise. */
export declare function parseRunnerId(id: string): string;
/**
 * What a runner call threw, or why it failed: an Error's name, message,
 * stack and code; another thrown value as `util.inspect` shows it, in
 * `message` alone. A runner's own failure has a code ERR_NIMBUS_RUNNER_*.
 */
export declare const SessionRunnerErrorSchema: z.ZodObject<{
    message: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    stack: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type SessionRunnerError = z.infer<typeof SessionRunnerErrorSchema>;
/**
 * One runner call's answer: its value as `util.inspect` shows it (absent
 * when it threw), what it wrote, what it threw, whether it ran in a new
 * runner (`fresh`: nothing an earlier call left is there), and how long the
 * call took in the session, in ms.
 */
export declare const SessionRunnerResultSchema: z.ZodObject<{
    value: z.ZodOptional<z.ZodString>;
    stdout: z.ZodString;
    stderr: z.ZodString;
    error: z.ZodOptional<z.ZodObject<{
        message: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        stack: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    fresh: z.ZodBoolean;
    ms: z.ZodNumber;
}, z.core.$strip>;
export type SessionRunnerResult = z.infer<typeof SessionRunnerResultSchema>;
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
            restartedFrom: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                pid: z.ZodNumber;
                cause: z.ZodLiteral<"session-restart">;
            }, z.core.$strip>, z.ZodObject<{
                pid: z.ZodNumber;
                cause: z.ZodLiteral<"exited">;
                exitCode: z.ZodNumber;
            }, z.core.$strip>, z.ZodObject<{
                pid: z.ZodNumber;
                cause: z.ZodLiteral<"host-reset">;
            }, z.core.$strip>], "cause">>;
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
    detachExec: z.ZodObject<{
        detached: z.ZodBoolean;
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
    runnerRun: z.ZodObject<{
        value: z.ZodOptional<z.ZodString>;
        stdout: z.ZodString;
        stderr: z.ZodString;
        error: z.ZodOptional<z.ZodObject<{
            message: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            stack: z.ZodOptional<z.ZodString>;
            code: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        fresh: z.ZodBoolean;
        ms: z.ZodNumber;
    }, z.core.$strip>;
    runnerClose: z.ZodObject<{
        closed: z.ZodBoolean;
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
        ino: z.ZodOptional<z.ZodNumber>;
        revision: z.ZodOptional<z.ZodNumber>;
        dev: z.ZodOptional<z.ZodNumber>;
        nlink: z.ZodOptional<z.ZodNumber>;
        uid: z.ZodOptional<z.ZodNumber>;
        gid: z.ZodOptional<z.ZodNumber>;
        atime: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    lstat: z.ZodNullable<z.ZodObject<{
        type: z.ZodString;
        size: z.ZodNumber;
        ctime: z.ZodOptional<z.ZodNumber>;
        mtime: z.ZodNumber;
        mode: z.ZodNumber;
        ino: z.ZodOptional<z.ZodNumber>;
        revision: z.ZodOptional<z.ZodNumber>;
        dev: z.ZodOptional<z.ZodNumber>;
        nlink: z.ZodOptional<z.ZodNumber>;
        uid: z.ZodOptional<z.ZodNumber>;
        gid: z.ZodOptional<z.ZodNumber>;
        atime: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    readlink: z.ZodNullable<z.ZodString>;
    readdir: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodString;
    }, z.core.$strip>>;
    rename: z.ZodUndefined;
    chmod: z.ZodUndefined;
    unlink: z.ZodUndefined;
    rmdir: z.ZodUndefined;
    appendFile: z.ZodUndefined;
    symlink: z.ZodUndefined;
    realpath: z.ZodString;
    truncate: z.ZodUndefined;
    utimes: z.ZodUndefined;
    chown: z.ZodUndefined;
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
        restartedFrom: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
            pid: z.ZodNumber;
            cause: z.ZodLiteral<"session-restart">;
        }, z.core.$strip>, z.ZodObject<{
            pid: z.ZodNumber;
            cause: z.ZodLiteral<"exited">;
            exitCode: z.ZodNumber;
        }, z.core.$strip>, z.ZodObject<{
            pid: z.ZodNumber;
            cause: z.ZodLiteral<"host-reset">;
        }, z.core.$strip>], "cause">>;
    }, z.core.$strip>>;
    killProcess: z.ZodObject<{
        ok: z.ZodBoolean;
        pid: z.ZodNumber;
    }, z.core.$strip>;
    listTerminals: z.ZodArray<z.ZodObject<{
        name: z.ZodNullable<z.ZodString>;
        live: z.ZodBoolean;
        attached: z.ZodBoolean;
        running: z.ZodNullable<z.ZodString>;
        cwd: z.ZodString;
    }, z.core.$strip>>;
    closeTerminal: z.ZodObject<{
        closed: z.ZodBoolean;
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
    waitProgram: z.ZodObject<{
        exit: z.ZodNullable<z.ZodUnion<readonly [z.ZodObject<{
            code: z.ZodNumber;
            signal: z.ZodNull;
        }, z.core.$strip>, z.ZodObject<{
            code: z.ZodNull;
            signal: z.ZodString;
        }, z.core.$strip>]>>;
    }, z.core.$strip>;
    processLogs: z.ZodObject<{
        pid: z.ZodNumber;
        chunks: z.ZodArray<z.ZodObject<{
            seq: z.ZodNumber;
            ts: z.ZodNumber;
            stream: z.ZodEnum<{
                stderr: "stderr";
                stdout: "stdout";
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
            public: "public";
            scoped: "scoped";
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
            public: "public";
            scoped: "scoped";
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
            failed: "failed";
            running: "running";
            starting: "starting";
            stopped: "stopped";
        }>;
        visibility: z.ZodEnum<{
            public: "public";
            scoped: "scoped";
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
            public: "public";
            scoped: "scoped";
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
            public: "public";
            scoped: "scoped";
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
export type SessionOperation = SessionJsonOperation | 'execStream' | 'startProgram';
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
    errno: z.ZodOptional<z.ZodNumber>;
    syscall: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
    dest: z.ZodOptional<z.ZodString>;
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
    /** Invocation identity for _rpcDetachExec, separate from inherited execId attribution. */
    detachId?: string;
    /** Colocated only: release a named shell without killing the command; its stream and exit remain live. */
    detach?: AbortSignal;
    /** startProcess only; spontaneous failures follow this restart policy. */
    restart?: SessionRestartPolicy;
}
/** startProgram's: its cwd (absolute), its environment (else the session's exported one), and its input. */
export interface SessionStartProgramOptions {
    cwd?: string;
    env?: Record<string, string>;
    /**
     * Its stdin's bytes, to their end (colocated callers); `written`: left
     * open for writeProcessInput calls until endProcessInput (across HTTP);
     * none: ended at once.
     */
    stdin?: ReadableStream<Uint8Array> | 'written';
}
export interface SessionRunCodeOptions extends SessionExecOptions {
    language?: string;
    install?: 'never' | 'ifMissing';
}
/** A runner's (sandbox.runner): where it runs and as whom, fixed for its life. */
export interface SessionRunnerOptions {
    /** Absolute: where `require` and relative paths resolve. Default: the session shell's, at the runner's first call. */
    cwd?: string;
    /** Its process's environment. Default: the session's exported one, at the runner's first call. */
    env?: Record<string, string>;
    /** Colocated callers only, as exec's. */
    cred?: VfsCred;
    /** A caller's tag for the runner's process (SessionExecOptions.execId). */
    execId?: string;
}
/** One runner call's limits. */
export interface SessionRunnerRunOptions {
    /** Wall time the call may take, in ms; none by default. Past it the runner is ended (ERR_NIMBUS_RUNNER_TIMEOUT). */
    timeoutMs?: number;
    /** CPU time the call may use, in ms. Past it the platform ends the runner (ERR_NIMBUS_RUNNER_CPU_LIMIT). */
    cpuMs?: number;
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
    /** A program started by its argv (NimbusWorkspace.startProgram), as an encoded program stream (program-stream.ts). */
    _rpcStartProgram(argv: string[], options?: SessionStartProgramOptions): Promise<ReadableStream<Uint8Array>>;
    _rpcDetachExec(detachId: string): Promise<SessionResult<'detachExec'>>;
    _rpcRunCode(code: string, options?: SessionRunCodeOptions): Promise<SessionResult<'runCode'>>;
    /**
     * Run `code` in runner `id` as a line of the node REPL. The runner is made
     * with `runner` at its first call, and made again after it was lost; a
     * later call that names other options is refused.
     */
    _rpcRunnerRun(id: string, code: string, runner?: SessionRunnerOptions, options?: SessionRunnerRunOptions): Promise<SessionResult<'runnerRun'>>;
    /** End runner `id`: whether there was one. */
    _rpcRunnerClose(id: string): Promise<SessionResult<'runnerClose'>>;
    _rpcReadFile(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readFile'>>;
    _rpcReadFileBytes(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readFileBytes'>>;
    _rpcWriteFile(path: string, content: string | Uint8Array, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'writeFile'>>;
    _rpcStat(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'stat'>>;
    _rpcLstat(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'lstat'>>;
    _rpcReadlink(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readlink'>>;
    _rpcReaddir(path: string, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readdir'>>;
    _rpcRename(from: string, to: string, pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcChmod(path: string, mode: number, pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcFsReadRange(path: string, offset: number, length: number, pid?: undefined, cred?: VfsCred): Promise<SessionResult<'readRange'>>;
    _rpcExists(path: string, pid?: undefined, cred?: VfsCred): Promise<boolean>;
    _rpcMkdir(path: string, pid?: undefined, cred?: VfsCred, options?: SessionMkdirOptions): Promise<void>;
    _rpcDeleteFile(path: string, options?: {
        recursive?: boolean;
    }, cred?: VfsCred): Promise<void>;
    /** unlink(2): EISDIR for a directory. */
    _rpcUnlink(path: string, pid?: undefined, cred?: VfsCred): Promise<void>;
    /** rmdir(2): ENOTDIR for a non-directory, ENOTEMPTY for one with entries. */
    _rpcRmdir(path: string, pid?: undefined, cred?: VfsCred): Promise<void>;
    /** Written at the file's end, as O_APPEND writes; the file is made when absent. */
    _rpcAppendFile(path: string, content: string | Uint8Array, pid?: undefined, cred?: VfsCred): Promise<void>;
    /** symlink(2): a link at `path` whose text is `target`, as given. */
    _rpcSymlink(target: string, path: string, pid?: undefined, cred?: VfsCred): Promise<void>;
    /** realpath(3): the path with every link followed. */
    _rpcRealpath(path: string, pid?: undefined, cred?: VfsCred): Promise<string>;
    /** truncate(2): cut to `size`, or extended with zeros. */
    _rpcTruncate(path: string, size: number, pid?: undefined, cred?: VfsCred): Promise<void>;
    /** utimensat(2), times in milliseconds. */
    _rpcUtimes(path: string, atime: number, mtime: number, pid?: undefined, cred?: VfsCred, options?: SessionFollowOptions): Promise<void>;
    /** chown(2): a null side keeps the file's. */
    _rpcChown(path: string, uid: number | null, gid: number | null, pid?: undefined, cred?: VfsCred, options?: SessionFollowOptions): Promise<void>;
    _rpcInstallRuntime(spec: string, options?: SessionRuntimeInstallOptions): Promise<SessionResult<'installRuntime'>>;
    _rpcEnsureRuntimes(specs: string[], options?: SessionRuntimeInstallOptions): Promise<SessionResult<'ensureRuntimes'>>;
    _rpcListRuntimes(): Promise<SessionResult<'listRuntimes'>>;
    _rpcListProcesses(): Promise<SessionProcess[]>;
    _rpcKillProcess(pid: number): Promise<SessionResult<'killProcess'>>;
    _rpcListTerminals(): Promise<SessionTerminal[]>;
    _rpcCloseTerminal(name: string): Promise<SessionResult<'closeTerminal'>>;
    /** Text is queued as a terminal's keys; bytes are a pipe's, the call waiting for room. */
    _rpcWriteProcessInput(pid: number, data: string | Uint8Array): Promise<SessionResult<'writeProcessInput'>>;
    _rpcEndProcessInput(pid: number): Promise<SessionResult<'endProcessInput'>>;
    _rpcResizeProcess(pid: number, size: SessionTerminalSize): Promise<SessionResult<'resizeProcess'>>;
    _rpcSignalProcess(pid: number, signal: string): Promise<SessionResult<'signalProcess'>>;
    /** A started program's exit once it comes, or null once `waitMs` pass: its end apart from its output. */
    _rpcWaitProgram(pid: number, waitMs?: number): Promise<SessionResult<'waitProgram'>>;
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
    /** A byte write whose answer (the remote API's JSON envelope) is a stream's body: cancelling it withdraws what still waits for room. */
    _rpcWriteProcessInputStream(pid: number, data: Uint8Array): Promise<ReadableStream<Uint8Array>>;
}
export {};
//# sourceMappingURL=session-protocol.d.ts.map