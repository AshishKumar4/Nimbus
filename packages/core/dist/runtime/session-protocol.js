import { z } from 'zod/v4';
import { ExecOutputSchema } from './exec-stream.js';
export const SessionProcessSchema = z.object({
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
    execId: z.string().optional(),
});
export const SessionPortSchema = z.object({
    port: z.number(),
    pid: z.number(),
    registeredAt: z.number(),
    capability: z.string(),
    execId: z.string().optional(),
});
export const SessionStartResultSchema = z.object({
    command: z.string(),
    pid: z.number(),
    process: SessionProcessSchema,
    ports: z.array(SessionPortSchema),
    startedAt: z.number(),
});
export const SessionFileStatSchema = z.object({
    type: z.string(),
    size: z.number(),
    ctime: z.number().optional(),
    mtime: z.number(),
    mode: z.number(),
});
export const SessionDirectoryEntrySchema = z.object({ name: z.string(), type: z.string() });
export const SessionRuntimeSummarySchema = z.object({
    name: z.string(),
    version: z.string(),
    root: z.string(),
    abi: z.string(),
    bins: z.array(z.string()),
    sizeBytes: z.number(),
    license: z.string(),
});
export const SessionAvailableRuntimeSchema = z.object({
    name: z.string(),
    abi: z.string(),
    defaultVersion: z.string(),
    versions: z.array(z.object({ version: z.string(), sizeBytes: z.number(), license: z.string() })),
});
export const SessionRuntimeInstallSchema = z.object({
    spec: z.string(),
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
});
export const SessionProcessLogChunkSchema = z.object({
    seq: z.number(),
    ts: z.number(),
    stream: z.enum(['stdout', 'stderr']),
    data: z.string(),
    binary: z.boolean().optional(),
});
export const SessionProcessExitSchema = z.object({ code: z.number(), at: z.number(), reason: z.string().optional() });
export const SessionProcessLogsOptionsSchema = z.object({
    cursor: z.number().int().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
}).strict();
export const SessionProcessLogsSchema = z.object({
    pid: z.number(),
    chunks: z.array(SessionProcessLogChunkSchema),
    text: z.string(),
    cursor: z.number(),
    truncated: z.boolean(),
    exit: SessionProcessExitSchema.nullable(),
});
export const SessionVisibilitySchema = z.enum(['scoped', 'public']);
export const SessionRestartPolicySchema = z.enum(['never', 'on-failure']);
export const SessionExposedPortSchema = z.object({
    port: z.number(),
    listening: z.boolean(),
    pid: z.number().nullable(),
    registeredAt: z.number().nullable(),
    capability: z.string().nullable(),
    visibility: SessionVisibilitySchema.optional(),
    owner: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    execId: z.string().optional(),
});
export const SessionExposedAppSchema = z.object({
    owner: z.string(),
    name: z.string().nullable(),
    port: z.number(),
    pid: z.number().nullable(),
    capability: z.string().nullable(),
    visibility: SessionVisibilitySchema,
    url: z.string().nullable(),
    execId: z.string().optional(),
});
export const SessionAppSchema = z.object({
    owner: z.string(),
    name: z.string().nullable(),
    port: z.number().nullable(),
    pid: z.number().nullable(),
    status: z.enum(['running', 'starting', 'stopped', 'failed']),
    visibility: SessionVisibilitySchema,
    capability: z.string().nullable(),
    restart: SessionRestartPolicySchema,
    diagnostic: z.string().nullable(),
    url: z.string().nullable(),
    execId: z.string().optional(),
});
export const SessionDestroyResultSchema = z.object({
    ok: z.literal(true),
    killed: z.number(),
    destroyedAt: z.number(),
    reason: z.string().nullable(),
});
const ProcessControlResultSchema = z.object({ ok: z.boolean(), pid: z.number() });
const RemovedAppSchema = z.object({ owner: z.string(), removed: z.boolean(), port: z.number().nullable() });
const FileBytesSchema = z.instanceof(Uint8Array);
/** JSON answers after the common wire codec; execStream travels as a byte stream. */
const SessionResultSchemas = {
    ready: z.object({ ok: z.literal(true), preinstalled: z.array(z.string()) }),
    bootProbe: z.object({ ok: z.literal(true) }),
    exec: ExecOutputSchema,
    startProcess: SessionStartResultSchema,
    runCode: ExecOutputSchema,
    readFile: z.string().nullable(),
    readFileBytes: FileBytesSchema.nullable(),
    writeFile: z.number(), // The committed filesystem revision, not a byte count.
    stat: SessionFileStatSchema.nullable(),
    lstat: SessionFileStatSchema.nullable(),
    readdir: z.array(SessionDirectoryEntrySchema),
    rename: z.undefined(),
    chmod: z.undefined(),
    readRange: FileBytesSchema.nullable(),
    exists: z.boolean(),
    mkdir: z.undefined(),
    deleteFile: z.undefined(),
    installRuntime: SessionRuntimeInstallSchema,
    ensureRuntimes: z.array(SessionRuntimeInstallSchema),
    listRuntimes: z.object({ installed: z.array(SessionRuntimeSummarySchema), available: z.array(SessionAvailableRuntimeSchema) }),
    listProcesses: z.array(SessionProcessSchema),
    killProcess: ProcessControlResultSchema,
    writeProcessInput: ProcessControlResultSchema,
    endProcessInput: ProcessControlResultSchema,
    resizeProcess: ProcessControlResultSchema,
    signalProcess: ProcessControlResultSchema,
    processLogs: SessionProcessLogsSchema,
    listPorts: z.array(SessionPortSchema),
    exposePort: SessionExposedPortSchema,
    exposeApp: SessionExposedAppSchema,
    listApps: z.array(SessionAppSchema),
    rotateLink: SessionExposedAppSchema,
    removeApp: RemovedAppSchema,
    ensureDurableApp: z.object({ port: z.number(), capability: z.string().nullable(), visibility: SessionVisibilitySchema }),
    removeDurableApp: RemovedAppSchema,
    unexposePort: z.object({ port: z.number(), ok: z.boolean() }),
    destroy: SessionDestroyResultSchema,
};
export const SessionResults = SessionResultSchemas;
export const SessionRequestSchema = z.object({
    profile: z.string().optional(),
    tenant: z.string().optional(),
    subject: z.string().optional(),
    root: z.string().optional(),
    op: z.string().optional(),
    args: z.array(z.unknown()).optional(),
}).passthrough();
export const SessionSuccessSchema = z.object({ ok: z.literal(true), result: z.unknown().optional() }).passthrough();
export const SessionFailureSchema = z.object({
    ok: z.boolean().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    code: z.string().optional(),
}).passthrough();
