import { z } from 'zod/v4';
import type { VfsCred } from './os-contracts.js';
import type { ProcessTerminalSize } from './process-io-protocol.js';
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
export type SessionProcess = z.infer<typeof SessionProcessSchema>;

export const SessionPortSchema = z.object({
  port: z.number(),
  pid: z.number(),
  registeredAt: z.number(),
  capability: z.string(),
  execId: z.string().optional(),
});
export type SessionPort = z.infer<typeof SessionPortSchema>;

export const SessionStartResultSchema = z.object({
  command: z.string(),
  pid: z.number(),
  process: SessionProcessSchema,
  ports: z.array(SessionPortSchema),
  startedAt: z.number(),
});
/** A background process is still running; exit/output arrive through process logs. */
export type SessionStartResult = z.infer<typeof SessionStartResultSchema>;

export const SessionFileStatSchema = z.object({
  type: z.string(),
  size: z.number(),
  ctime: z.number().optional(),
  mtime: z.number(),
  mode: z.number(),
  /** Optional when the filesystem backend does not report a stable inode or revision. */
  ino: z.number().optional(),
  revision: z.number().optional(),
});
export type SessionFileStat = z.infer<typeof SessionFileStatSchema>;
/** Runtime stat uses zero for unknown metadata; the session wire exposes that as absent. */
export function sessionFileStatOf(stat: SessionFileStat | null): SessionFileStat | null {
  if (stat === null) return null;
  const { ino, revision, ...fields } = stat;
  return { ...fields, ...(ino === undefined || ino === 0 ? {} : { ino }), ...(revision === undefined || revision === 0 ? {} : { revision }) };
}
export const SessionDirectoryEntrySchema = z.object({ name: z.string(), type: z.string() });
export type SessionDirectoryEntry = z.infer<typeof SessionDirectoryEntrySchema>;

export const SessionRuntimeSummarySchema = z.object({
  name: z.string(),
  version: z.string(),
  root: z.string(),
  abi: z.string(),
  bins: z.array(z.string()),
  sizeBytes: z.number(),
  license: z.string(),
});
export type SessionRuntimeSummary = z.infer<typeof SessionRuntimeSummarySchema>;
export const SessionAvailableRuntimeSchema = z.object({
  name: z.string(),
  abi: z.string(),
  defaultVersion: z.string(),
  versions: z.array(z.object({ version: z.string(), sizeBytes: z.number(), license: z.string() })),
});
export type SessionAvailableRuntime = z.infer<typeof SessionAvailableRuntimeSchema>;
export const SessionRuntimeInstallSchema = z.object({
  spec: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});
export type SessionRuntimeInstallResult = z.infer<typeof SessionRuntimeInstallSchema>;

export const SessionProcessLogChunkSchema = z.object({
  seq: z.number(),
  ts: z.number(),
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
  binary: z.boolean().optional(),
});
export type SessionProcessLogChunk = z.infer<typeof SessionProcessLogChunkSchema>;
export const SessionProcessExitSchema = z.object({ code: z.number(), at: z.number(), reason: z.string().optional() });
export type SessionProcessExit = z.infer<typeof SessionProcessExitSchema>;
export const SessionProcessLogsOptionsSchema = z.object({
  cursor: z.number().int().nonnegative().optional(),
  lines: z.number().int().nonnegative().optional(),
  bytes: z.number().int().nonnegative().optional(),
}).strict();
export type SessionProcessLogsOptions = z.infer<typeof SessionProcessLogsOptionsSchema>;
export const SessionProcessLogsSchema = z.object({
  pid: z.number(),
  chunks: z.array(SessionProcessLogChunkSchema),
  text: z.string(),
  cursor: z.number(),
  truncated: z.boolean(),
  exit: SessionProcessExitSchema.nullable(),
});
export type SessionProcessLogs = z.infer<typeof SessionProcessLogsSchema>;

export const SessionVisibilitySchema = z.enum(['scoped', 'public']);
export type SessionAppVisibility = z.infer<typeof SessionVisibilitySchema>;
export const SessionRestartPolicySchema = z.enum(['never', 'on-failure']);
export type SessionRestartPolicy = z.infer<typeof SessionRestartPolicySchema>;
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
export type SessionExposedApp = z.infer<typeof SessionExposedAppSchema>;
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
export type SessionApp = z.infer<typeof SessionAppSchema>;
export const SessionDestroyResultSchema = z.object({
  ok: z.literal(true),
  killed: z.number(),
  destroyedAt: z.number(),
  reason: z.string().nullable(),
});
export type SessionDestroyResult = z.infer<typeof SessionDestroyResultSchema>;

const ProcessControlResultSchema = z.object({ ok: z.boolean(), pid: z.number() });
const RemovedAppSchema = z.object({ owner: z.string(), removed: z.boolean(), port: z.number().nullable() });
const FileBytesSchema: z.ZodType<Uint8Array> = z.instanceof(Uint8Array);

/** JSON answers after the common wire codec; execStream travels as a byte stream. */
const SessionResultSchemas = {
  ready: z.object({ ok: z.literal(true), preinstalled: z.array(z.string()) }),
  bootProbe: z.object({ ok: z.literal(true) }),
  exec: ExecOutputSchema,
  startProcess: SessionStartResultSchema,
  detachExec: z.object({ detached: z.boolean() }),
  runCode: ExecOutputSchema,
  readFile: z.string().nullable(),
  readFileBytes: FileBytesSchema.nullable(),
  writeFile: z.number(), // The committed filesystem revision, not a byte count.
  stat: SessionFileStatSchema.nullable(),
  lstat: SessionFileStatSchema.nullable(),
  readlink: z.string().nullable(),
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
export type SessionJsonOperation = keyof typeof SessionResultSchemas;
export type SessionOperation = SessionJsonOperation | 'execStream';
export type SessionResult<Op extends SessionJsonOperation> = z.infer<(typeof SessionResultSchemas)[Op]>;
export const SessionResults: { [Op in SessionJsonOperation]: z.ZodType<SessionResult<Op>> } = SessionResultSchemas;

export const SessionRequestSchema = z.object({
  profile: z.string().optional(),
  tenant: z.string().optional(),
  subject: z.string().optional(),
  root: z.string().optional(),
  op: z.string().optional(),
  args: z.array(z.unknown()).optional(),
}).passthrough();
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export const SessionSuccessSchema = z.object({ ok: z.literal(true), result: z.unknown().optional() }).passthrough();
export const SessionFailureSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
}).passthrough();

export interface SessionReadyOptions { preinstall?: string[] }
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
export interface SessionRunCodeOptions extends SessionExecOptions {
  language?: string;
  install?: 'never' | 'ifMissing';
}
export type SessionTerminalSize = ProcessTerminalSize;
export interface SessionDestroyOptions { reason?: string }
export interface SessionExposeOptions { visibility?: SessionAppVisibility; name?: string }
export interface SessionDurableAppOptions extends SessionExposeOptions { owner: string; preferredPort?: number }
export interface SessionRuntimeInstallOptions { force?: boolean }
export type SessionAppTarget = number | string | { port: number } | { pid: number } | { name: string } | { owner: string };

/** The programmatic wire surface shared by DO, HTTP and hosted-session adapters.
 * File pid slots are preserved for the supervisor wire; SDK callers make no process claim.
 */
export interface SessionRpc {
  _rpcReady(options?: SessionReadyOptions): Promise<SessionResult<'ready'>>;
  _rpcExecStream(command: string, options?: SessionExecOptions): Promise<ReadableStream<Uint8Array>>;
  _rpcStartProcess(command: string, options?: SessionExecOptions): Promise<SessionStartResult>;
  _rpcDetachExec(detachId: string): Promise<SessionResult<'detachExec'>>;
  _rpcRunCode(code: string, options?: SessionRunCodeOptions): Promise<SessionResult<'runCode'>>;
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
  _rpcMkdir(path: string, pid?: undefined, cred?: VfsCred): Promise<void>;
  _rpcDeleteFile(path: string, options?: { recursive?: boolean }, cred?: VfsCred): Promise<void>;
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
