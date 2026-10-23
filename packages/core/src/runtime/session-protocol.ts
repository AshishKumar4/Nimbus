import { z } from 'zod/v4';
import type { VfsCred } from './os-contracts.js';
import type { ProcessTerminalSize } from './process-io-protocol.js';
import { ExecOutputSchema } from './exec-stream.js';

/** The process a process starts again, and why (ProcessEntry.restartedFrom). */
export const ProcessRestartSchema = z.discriminatedUnion('cause', [
  z.object({ pid: z.number(), cause: z.literal('session-restart') }),
  z.object({ pid: z.number(), cause: z.literal('exited'), exitCode: z.number() }),
  z.object({ pid: z.number(), cause: z.literal('host-reset') }),
]);
export type ProcessRestart = z.infer<typeof ProcessRestartSchema>;

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
  /** The process it starts again, when it is a restart. */
  restartedFrom: ProcessRestartSchema.optional(),
});
export type SessionProcess = z.infer<typeof SessionProcessSchema>;

/** A session's terminal as a list shows it: its own is `name: null`; a named one's is `/ws?terminal=<name>`. */
export const SessionTerminalSchema = z.object({
  name: z.string().nullable(),
  /** Its shell runs in this incarnation of the session. */
  live: z.boolean(),
  /** A socket has it now. */
  attached: z.boolean(),
  /** The line its shell is running, if it is running one. */
  running: z.string().nullable(),
  cwd: z.string(),
});
export type SessionTerminal = z.infer<typeof SessionTerminalSchema>;

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
  /** The rest of stat(2)'s (times in milliseconds); a session older than these sends none of them. */
  dev: z.number().optional(),
  nlink: z.number().optional(),
  uid: z.number().optional(),
  gid: z.number().optional(),
  atime: z.number().optional(),
});
export type SessionFileStat = z.infer<typeof SessionFileStatSchema>;
/** A filesystem's stat (RuntimeVfsStat), as a session's file calls answer with it. */
export const RuntimeStatSchema = z.object({
  dev: z.number(), ino: z.number(), nlink: z.number(), type: z.enum(['file', 'directory', 'symlink']), size: z.number(),
  ctime: z.number(), atime: z.number(), mtime: z.number(), mode: z.number(), uid: z.number(), gid: z.number(), revision: z.number(),
});
/** Runtime stat uses zero for an unknown inode or revision; the session wire exposes that as absent. */
export function sessionFileStatOf(stat: z.infer<typeof RuntimeStatSchema> | null): SessionFileStat | null {
  if (stat === null) return null;
  const { dev, ino, nlink, type, size, ctime, atime, mtime, mode, uid, gid, revision } = stat;
  return {
    type, size, ctime, mtime, mode, dev, nlink, uid, gid, atime,
    ...(ino === 0 ? {} : { ino }),
    ...(revision === 0 ? {} : { revision }),
  };
}
/** mkdir(2)'s options as a session takes them: none is `mkdir -p`, as files.mkdir has always been. */
export interface SessionMkdirOptions { recursive?: boolean; mode?: number }
/** Whether a link's own times or owner change (lutimes, lchown), not its target's. */
export interface SessionFollowOptions { followSymlinks?: boolean }
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
/** waitpid(2)'s answer: an exit code, or the signal that ended it. */
export const ExitStatusSchema = z.union([
  z.object({ code: z.number(), signal: z.null() }),
  z.object({ code: z.null(), signal: z.string() }),
]);
const RemovedAppSchema = z.object({ owner: z.string(), removed: z.boolean(), port: z.number().nullable() });
/** `id` as a runner's: 1 to 64 of A-Z a-z 0-9 . _ - (a UUID fits); a TypeError otherwise. */
export function parseRunnerId(id: string): string {
  const parsed = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).safeParse(id);
  if (!parsed.success) throw new TypeError(`runner: an id is 1 to 64 of A-Z a-z 0-9 . _ -, got ${JSON.stringify(id)}`);
  return parsed.data;
}
/**
 * What a runner call threw, or why it failed: an Error's name, message,
 * stack and code; another thrown value as `util.inspect` shows it, in
 * `message` alone. A runner's own failure has a code ERR_NIMBUS_RUNNER_*.
 */
export const SessionRunnerErrorSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
  code: z.string().optional(),
});
export type SessionRunnerError = z.infer<typeof SessionRunnerErrorSchema>;
/**
 * One runner call's answer: its value as `util.inspect` shows it (absent
 * when it threw), what it wrote, what it threw, whether it ran in a new
 * runner (`fresh`: nothing an earlier call left is there), and how long the
 * call took in the session, in ms.
 */
export const SessionRunnerResultSchema = z.object({
  value: z.string().optional(),
  stdout: z.string(),
  stderr: z.string(),
  error: SessionRunnerErrorSchema.optional(),
  fresh: z.boolean(),
  ms: z.number(),
});
export type SessionRunnerResult = z.infer<typeof SessionRunnerResultSchema>;
const FileBytesSchema: z.ZodType<Uint8Array> = z.instanceof(Uint8Array);

/** JSON answers after the common wire codec; execStream travels as a byte stream. */
const SessionResultSchemas = {
  ready: z.object({ ok: z.literal(true), preinstalled: z.array(z.string()) }),
  bootProbe: z.object({ ok: z.literal(true) }),
  exec: ExecOutputSchema,
  startProcess: SessionStartResultSchema,
  detachExec: z.object({ detached: z.boolean() }),
  runCode: ExecOutputSchema,
  runnerRun: SessionRunnerResultSchema,
  runnerClose: z.object({ closed: z.boolean() }),
  readFile: z.string().nullable(),
  readFileBytes: FileBytesSchema.nullable(),
  writeFile: z.number(), // The committed filesystem revision, not a byte count.
  stat: SessionFileStatSchema.nullable(),
  lstat: SessionFileStatSchema.nullable(),
  readlink: z.string().nullable(),
  readdir: z.array(SessionDirectoryEntrySchema),
  rename: z.undefined(),
  chmod: z.undefined(),
  unlink: z.undefined(),
  rmdir: z.undefined(),
  appendFile: z.undefined(),
  symlink: z.undefined(),
  realpath: z.string(),
  truncate: z.undefined(),
  utimes: z.undefined(),
  chown: z.undefined(),
  readRange: FileBytesSchema.nullable(),
  exists: z.boolean(),
  mkdir: z.undefined(),
  deleteFile: z.undefined(),
  installRuntime: SessionRuntimeInstallSchema,
  ensureRuntimes: z.array(SessionRuntimeInstallSchema),
  listRuntimes: z.object({ installed: z.array(SessionRuntimeSummarySchema), available: z.array(SessionAvailableRuntimeSchema) }),
  listProcesses: z.array(SessionProcessSchema),
  killProcess: ProcessControlResultSchema,
  listTerminals: z.array(SessionTerminalSchema),
  closeTerminal: z.object({ closed: z.boolean() }),
  writeProcessInput: ProcessControlResultSchema,
  endProcessInput: ProcessControlResultSchema,
  resizeProcess: ProcessControlResultSchema,
  signalProcess: ProcessControlResultSchema,
  waitProgram: z.object({ exit: ExitStatusSchema.nullable() }),
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
export type SessionOperation = SessionJsonOperation | 'execStream' | 'startProgram';
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
  /** A failed system call's, as Node's error carries them: its errno, the call, and the path(s) it named. */
  errno: z.number().optional(),
  syscall: z.string().optional(),
  path: z.string().optional(),
  dest: z.string().optional(),
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
  _rpcDeleteFile(path: string, options?: { recursive?: boolean }, cred?: VfsCred): Promise<void>;
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
