import { isPendingChunkError, type SqliteVFS, type WaveMountReach } from '../vfs/sqlite-vfs.js';
import { z } from 'zod';
import { traced, type SpanRecorder } from '@nimbus-sh/platform/tracing.js';
import { WAVE_EPOCH_TTL_MS } from '@nimbus-sh/platform/lost-call.js';
import { CRED_SESSION_USER, requireVfsCred, type VfsCred } from '../runtime/os-contracts.js';
import { ProcessFiles } from '../runtime/process-files.js';
import type { NimbusFilesystemAuthority, NimbusHostFilesystemLease, RuntimeFsBridge, RuntimeFsPath, RuntimeMutationOwner, RuntimeVfsStat } from '../runtime/os-contracts.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import {
  supervisorDeliveredOp,
  supervisorDeliveryAnswer,
  supervisorJoinedReadOp,
  SUPERVISOR_DELIVER_OP,
  type SupervisorDeliveries,
  type SupervisorDelivery,
} from './supervisor-delivery.js';

const FsPath = z.union([
  z.string(),
  z.object({ directory: z.number().int().nonnegative(), path: z.string(), beneath: z.boolean().optional() }),
  z.object({ root: z.string(), path: z.string(), beneath: z.literal(true) }),
]);
const OpenOptions = z.object({
  read: z.boolean().optional(), write: z.boolean().optional(), append: z.boolean().optional(),
  create: z.boolean().optional(), exclusive: z.boolean().optional(), directory: z.boolean().optional(),
  truncate: z.boolean().optional(), followSymlinks: z.boolean().optional(), expectedRevision: z.number().int().nonnegative().optional(),
  mode: z.number().int().nonnegative().max(0o7777).optional(),
});
/** A byte offset into a file: what a ranged write may start at. */
const RangeOffset = z.number().int().nonnegative();
/** What `deliverOnce` carries besides the mutation's args; its op is checked against the delivered set. */
const Delivery = z.object({ op: z.string(), id: z.string().uuid(), hostIncarnation: z.string().uuid() });
/** A read id, minted like a delivery id (SupervisorRPC `_fsRead`). */
const ReadId = z.string().uuid();

/**
 * Identity comes from the supervisor binding, never from facet arguments: a
 * process's `pid` is stamped by SupervisorRPC from its own props. A HOST call
 * — no pid — acts as the unprivileged session user unless it names a `cred`,
 * which only a caller already trusted with the filesystem can do: the SDK over
 * the DO binding, an embedder composing the workspace. A pid and a cred
 * together are refused, so a process can never widen its own identity.
 */
export interface SupervisorOpEnvelope {
  /**
   * The op, or {@link SUPERVISOR_DELIVER_OP} for a mutation delivered exactly
   * once — whose own op then rides in `delivery`, and whose args are these.
   */
  readonly op: SupervisorOpName | typeof SUPERVISOR_DELIVER_OP;
  readonly args?: readonly unknown[];
  readonly pid?: number;
  /** A host call's credential. Meaningless — and refused — with a pid. */
  readonly cred?: VfsCred;
  readonly writerId?: string;
  /**
   * Which run of the process sent it: its writer identity, stamped by the
   * supervisor binding from its props. A process that can stop at a read of
   * stdin is answered for its current run only (worker stop-replay.ts).
   */
  readonly run?: string;
  readonly mutationOwner?: string;
  readonly stream?: ReadableStream<Uint8Array>;
  /** Which mutation a {@link SUPERVISOR_DELIVER_OP} envelope carries. Refused on any other op. */
  readonly delivery?: SupervisorDelivery;
  /**
   * The id every attempt of one read is sent under: a repeat of a read still
   * being served joins it rather than reading again
   * (`SupervisorDeliveries.joinRead`). Only on a joined read op. A host that
   * predates it ignores it and serves each attempt, which a read allows.
   */
  readonly readId?: string;
  /**
   * Which attempt of which write wave a writeBatchStream carries, and the
   * host instance its binding names (platform wave-writer.ts `WaveFence`):
   * the instance refuses an attempt older than one it has seen from the
   * same writer (`SupervisorDeliveries.admitWave`), and any other instance
   * refuses it outright. Only on writeBatchStream.
   */
  readonly waveFence?: SupervisorWaveFence;
}

export interface SupervisorWaveFence {
  readonly writer: string;
  readonly wave: number;
  readonly attempt: number;
  readonly hostIncarnation: string;
}

/**
 * `writeFileStat`'s answer: the write's revision, and the path's lstat after
 * it (null: nothing there). No `stat` when it could not be read; the write
 * is committed either way.
 */
export interface WriteFileStatAnswer {
  revision: number;
  stat?: RuntimeVfsStat | null;
}

export type SupervisorOpHandler = (envelope: SupervisorOpEnvelope, tools: SupervisorOpTools) => unknown;

export interface SupervisorOpDeps {
  readonly vfs: SqliteVFS;
  readonly filesystem?: NimbusFilesystemAuthority;
  /** Absent a process table, operations use the unprivileged session user. */
  readonly processes?: SessionProcessSupervisor;
  readonly output?: (stream: 'stdout' | 'stderr', pid: number, data: string) => void | Promise<void>;
  /**
   * The host's `_rpc*` surface for ops beyond the native set — an in-process
   * workspace's dispatch record, or the session itself for
   * `sessionSupervisorOps`. A native op never consults it.
   */
  readonly host?: SupervisorOpHost;
  /**
   * A pid-keyed bridge cache to serve the native ops from. Supplied by the
   * session so `supervisorBridge` hands callers the same bridges the handler
   * uses; in-process workspaces let the handler build its own.
   */
  readonly bridge?: SupervisorOpBridgeStore;
  /**
   * Accounting around a read that answers up to `bytes`: a host under a
   * memory budget holds a lease for the payload while it is produced. Absent,
   * reads are unaccounted, which is an in-process workspace's whole budget.
   */
  readonly readLease?: <T>(bytes: number, read: () => Promise<T>) => Promise<T>;
  readonly extend?: Partial<Record<SupervisorOpName, SupervisorOpHandler>>;
  /**
   * The instance's receipts for mutations delivered exactly once
   * (`openSupervisorDeliveries`). Absent, this host applies nothing once:
   * it serves no {@link SUPERVISOR_DELIVER_OP}, exactly as a host that
   * predates delivery does not, and mints no binding that would send one.
   */
  readonly deliveries?: SupervisorDeliveries;
  /**
   * Observe one logical answer, after transport read attempts have joined or
   * delivered mutations have found their receipt. A repeated pending read
   * observes the SAME answer, never a second program request. Used by the
   * session's replay journal; omitted by hosts without stoppable processes.
   */
  readonly observe?: (envelope: SupervisorOpEnvelope, dispatch: () => Promise<unknown>) => Promise<unknown>;
}

function stringArg(envelope: SupervisorOpEnvelope, index: number): string {
  const value = envelope.args?.[index];
  if (typeof value !== 'string') {
    throw new Error(`supervisor op ${envelope.op}: argument ${index} must be a string`);
  }
  return value;
}

function numberArg(envelope: SupervisorOpEnvelope, index: number): number {
  const value = envelope.args?.[index];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`supervisor op ${envelope.op}: argument ${index} must be a number`);
  }
  return value;
}

function nullableNumberArg(envelope: SupervisorOpEnvelope, index: number): number | null {
  return envelope.args?.[index] === null ? null : numberArg(envelope, index);
}

function bytesArg(envelope: SupervisorOpEnvelope, index: number): Uint8Array {
  const value = envelope.args?.[index];
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`supervisor op ${envelope.op}: argument ${index} must be bytes`);
}

/**
 * A ranged write's bytes, in every shape the routed `_rpcFsWriteRange` took
 * before it was served here: bytes, a buffer, any view of one, an array of
 * byte values, or a serialized Node Buffer's `{ data }`. Anything else is
 * refused, EINVAL, where the routed op wrote nothing and answered success.
 */
function writeRangeBytesArg(envelope: SupervisorOpEnvelope, index: number): Uint8Array {
  const value = envelope.args?.[index];
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === 'object' && value !== null && 'data' in value && Array.isArray(value.data)) return new Uint8Array(value.data);
  throw Object.assign(new Error(`EINVAL: supervisor op ${envelope.op}: argument ${index} must be bytes`), { code: 'EINVAL' });
}

function contentArg(envelope: SupervisorOpEnvelope, index: number): string | Uint8Array {
  const value = envelope.args?.[index];
  if (typeof value === 'string' || value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`supervisor op ${envelope.op}: argument ${index} must be bytes or text`);
}

function credFor(deps: SupervisorOpDeps, pid: number | undefined, cred?: VfsCred): VfsCred {
  if (pid === undefined) {
    // Validated through the one VfsCred validator; a host that names a
    // credential names a well-formed one or gets nothing.
    return cred === undefined ? CRED_SESSION_USER : requireVfsCred(cred, 'supervisor op');
  }
  if (cred !== undefined) {
    throw new Error('supervisor op: a process acts as its own credential; cred cannot ride a pid');
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('supervisor op: filesystem operation requires a valid process pid');
  }
  return deps.processes ? deps.processes.cred(pid) : CRED_SESSION_USER;
}

/**
 * One slot in an op's argument plan: a number takes `envelope.args[n]`, a
 * name takes the envelope's identity field (`pid`, `writerId`, `stream`,
 * `mutationOwner`). The envelope is always the shape — a host never
 * re-parses it.
 */
export type SupervisorOpArg = number | 'pid' | 'writerId' | 'run' | 'stream' | 'mutationOwner';

export interface SupervisorOpRoute {
  /** The host method this op dispatches to. */
  readonly method: string;
  /** Positional plan for the host call — envelope fields, not raw args. */
  readonly args: readonly SupervisorOpArg[];
}

/**
 * The embedder's dispatch surface — the `_rpc*` methods SUPERVISOR_OP_ROUTES
 * names. The session satisfies it with its own class; an in-process
 * workspace supplies its host object.
 */
export interface SupervisorOpHost {
  readonly [method: string]: unknown;
}

/**
 * The canonical supervisor op set — every operation the supervisor RPC
 * serves, split between exactly two tables: an op is either native (the
 * handler answers it from the bridge) or routed (SUPERVISOR_OP_ROUTES names
 * the host `_rpc*` method), never both. Three consumers key on these names:
 *
 *   - `sessionSupervisorOp` (worker): the DO's host — `extend` overrides for
 *     hosted accounting plus the non-filesystem ops it answers itself.
 *   - `createSupervisorOpHandler`: an in-process workspace — filesystem ops
 *     run against the VFS directly; every other op dispatches to
 *     `deps.host` through SUPERVISOR_OP_ROUTES, the embedder's `_rpc*`
 *     surface.
 *   - `supervisor-host-dispatch`: the test — drives a case per name here,
 *     against the real filesystem for a native op and against a captured
 *     delegate for a routed one.
 *
 * An op absent here is not served, on any host. The one other name an
 * envelope may carry is SUPERVISOR_DELIVER_OP (supervisor-delivery.ts): a
 * wrapper around one of these, which the handler unwraps.
 */
export const SUPERVISOR_OPS = [
  'readFile', 'readFileBytes', 'writeFile', 'writeFileStat', 'stat', 'lstat',
  'hasLegacySymlinkUnder', 'utimes', 'chmod', 'access', 'chown', 'setUmask',
  'readdir', 'exists', 'mkdir', 'rmdir', 'rename', 'unlink', 'readlink', 'fsLinkLeadsTo',
  'symlink', 'fsAcquire', 'fsAcquired', 'fsRevision', 'fsList', 'fsStorageGrant', 'wsOpen', 'wsPoll',
  'wsSend', 'wsClose', 'fsOpen', 'fsRead', 'fsWrite', 'fsClose',
  'fsReadRange', 'fsReadRangeUncached', 'fsReadBatch', 'fsWriteRange',
  'fsAppend', 'fsAppendAck', 'fsTruncate', 'writeBatch', 'writeBatchStream', 'openWaveWriter',
  'putRegistryEntries', 'stdout', 'stderr', 'prefetch', 'registerPort', 'allocatePort',
  'unregisterPort', 'reportExit', 'routeLoopback', 'transform', 'cpSpawn',
  'reportRuntimeCode',
  'cpStdinWrite', 'cpStdinEnd', 'cpReadStdin', 'cpReadOutput',
  'cpDrainOutput', 'cpKill', 'cpWait', 'cpBlocked',
  'fsFstat', 'fsDup', 'fsSeek', 'fsSetStatus', 'fsReaddirHandle', 'fsFtruncate', 'fsFchmod', 'fsFchown', 'fsFutimes', 'fsSync', 'fsRealpath', 'fsRemove', 'fsCopyFile', 'fsCopyTree', 'fsAcquireExclusiveMutation', 'fsReleaseExclusiveMutation',
  'innerDoFetch', 'innerDoCall', 'fanoutExecute', 'processHostProbe', 'hostProcess',
  'awaitHostedOpen', 'awaitHostedBoot', 'routeHostedHttp', 'cancelHostProcess', 'hmrRelay', 'hmrNextEvent',
  'replayBoundary', 'netTls', 'outbound', 'stdinFileRead', 'stdinPrepared',
  'getCachedTarball', 'putCachedTarball', 'getPackument',
  'cacheResult',
] as const;

export type SupervisorOpName = (typeof SUPERVISOR_OPS)[number];

/**
 * What the shared handler hands a host override: the pid-keyed bridge and
 * the deps it was built with, so an override that wraps a filesystem op
 * (read-allocation accounting, stream-drain timing) reuses the same bridge
 * the default handler would have used instead of caching its own.
 */
export interface SupervisorOpTools {
  readonly bridge: (pid?: number, cred?: VfsCred) => RuntimeFsBridge;
  readonly vfs: SqliteVFS;
  readonly cred: (pid?: number, cred?: VfsCred) => VfsCred;
  readonly output?: (stream: 'stdout' | 'stderr', pid: number, data: string) => void | Promise<void>;
  readonly readLease: NonNullable<SupervisorOpDeps['readLease']>;
  /** N17: resolves once `path`'s bytes are hydrated out of a lazy import. */
  readonly hydrated: (path: string) => Promise<void>;
  /** The host instance's delivery store, absent on a host that applies nothing once. */
  readonly deliveries?: SupervisorDeliveries;
}

/**
 * An asynchronous read that meets bytes still being imported (N17) waits for
 * them and reads again; a synchronous caller would have had EIO.
 */
export async function readHydrating<T>(hydrated: (path: string) => Promise<void>, read: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (!isPendingChunkError(error)) throw error;
      await hydrated(error.path);
    }
  }
}

/**
 * The host-side argument plan per op — how an envelope becomes an _rpc*
 * call. Exactly the ops {@link SUPERVISOR_NATIVE_OPS} does NOT name: a
 * native op is answered by the bridge before the host is consulted, so a
 * route for one could never fire.
 */
export const SUPERVISOR_OP_ROUTES: Readonly<Record<Exclude<SupervisorOpName, NativeOpName>, SupervisorOpRoute>> = {
  setUmask: { method: '_rpcSetUmask', args: [0,'pid'] },
  fsAcquire: { method: '_rpcFsAcquire', args: [0,1,2,'pid'] },
  fsAcquired: { method: '_rpcFsAcquired', args: [0,1,2,'pid'] },
  fsList: { method: '_rpcFsList', args: [0,1,'pid'] },
  fsStorageGrant: { method: '_rpcFsStorageGrant', args: [0,1,2,'pid'] },
  wsOpen: { method: '_rpcWsOpen', args: [0,1,2,3,'pid'] },
  wsPoll: { method: '_rpcWsPoll', args: [0,1,'pid'] },
  wsSend: { method: '_rpcWsSend', args: [0,1,2,'pid'] },
  wsClose: { method: '_rpcWsClose', args: [0,1,2,'pid'] },
  fsReadBatch: { method: '_rpcFsReadBatch', args: [0,'pid'] },
  fsAppend: { method: '_rpcFsAppend', args: [0,'writerId',1,2,3,'pid'] },
  fsAppendAck: { method: '_rpcFsAppendAck', args: ['writerId',0,1,'pid'] },
  writeBatch: { method: '_rpcWriteBatch', args: [0,'pid'] },
  putRegistryEntries: { method: '_rpcPutRegistryEntries', args: [0] },
  prefetch: { method: '_rpcPrefetch', args: [0,1] },
  registerPort: { method: '_rpcRegisterPort', args: ['pid',0] },
  allocatePort: { method: '_rpcAllocatePort', args: ['pid'] },
  unregisterPort: { method: '_rpcUnregisterPort', args: ['pid', 0] },
  reportExit: { method: '_rpcReportExit', args: ['pid',0,1,2,3,4,5] },
  reportRuntimeCode: { method: '_rpcReportRuntimeCode', args: ['pid',0,1,2] },
  routeLoopback: { method: '_rpcRouteLoopback', args: [0,1] },
  transform: { method: '_rpcTransform', args: [0,1] },
  cpSpawn: { method: '_rpcCpSpawn', args: [0] },
  cpStdinWrite: { method: '_rpcCpStdinWrite', args: [0,1] },
  cpStdinEnd: { method: '_rpcCpStdinEnd', args: [0] },
  cpReadStdin: { method: '_rpcCpReadStdin', args: [0,1,2,'pid','writerId'] },
  stdinFileRead: { method: '_rpcStdinFileRead', args: [0,1,2,'pid'] },
  stdinPrepared: { method: '_rpcStdinPrepared', args: ['pid', 'run'] },
  getCachedTarball: { method: '_rpcGetCachedTarball', args: [0, 'pid', 'run'] },
  putCachedTarball: { method: '_rpcPutCachedTarball', args: [0, 1] },
  getPackument: { method: '_rpcGetPackument', args: [0, 1, 'pid', 'run'] },
  cacheResult: { method: '_rpcCacheResult', args: [0, 1, 'pid', 'run'] },
  cpReadOutput: { method: '_rpcCpReadOutput', args: [0,1,2,3,4,'pid'] },
  cpDrainOutput: { method: '_rpcCpDrainOutput', args: [0] },
  cpKill: { method: '_rpcCpKill', args: [0,1] },
  cpWait: { method: '_rpcCpWait', args: [0,1,2,'pid',3] },
  cpBlocked: { method: '_rpcCpBlocked', args: ['pid',0] },
  innerDoFetch: { method: '_rpcInnerDoFetch', args: [0] },
  innerDoCall: { method: '_rpcInnerDoCall', args: [0] },
  fanoutExecute: { method: '_rpcFanoutExecute', args: [0,1,2] },
  processHostProbe: { method: '_rpcProcessHostProbe', args: [] },
  hostProcess: { method: '_rpcHostProcess', args: [0,1] },
  awaitHostedOpen: { method: '_rpcAwaitHostedOpen', args: [0] },
  awaitHostedBoot: { method: '_rpcAwaitHostedBoot', args: [0] },
  routeHostedHttp: { method: '_rpcRouteHostedHttp', args: [0,1] },
  cancelHostProcess: { method: '_rpcCancelHostProcess', args: [0] },
  hmrRelay: { method: '_rpcHmrRelay', args: [0,1] },
  hmrNextEvent: { method: '_rpcHmrNextEvent', args: [0] },
  // A process that can stop at a read of stdin (worker runtime/stop-replay.ts).
  replayBoundary: { method: '_rpcReplayBoundary', args: ['pid', 'run'] },
  netTls: { method: '_rpcNetTls', args: [0, 1, 2, 'pid', 'run'] },
  outbound: { method: '_rpcOutbound', args: [0, 1, 'pid', 'run'] },
} as const;

/** Every native op reads its filesystem the same way: the envelope's identity. */
const fsFor = (e: SupervisorOpEnvelope, tools: SupervisorOpTools): RuntimeFsBridge => tools.bridge(e.pid, e.cred);

/** The exclusive mutation lease the envelope's binding presents, if it holds one (SupervisorRPC props). */
const leaseOf = (e: SupervisorOpEnvelope): RuntimeMutationOwner | undefined =>
  e.mutationOwner === undefined ? undefined : { mutationOwner: e.mutationOwner };

/** A whole-file read, leased for what the file holds. */
async function readWholeFile(e: SupervisorOpEnvelope, t: SupervisorOpTools, path: RuntimeFsPath): Promise<Uint8Array | null> {
  const fs = fsFor(e, t);
  const stat = await fs.stat(path);
  if (!stat) return null;
  return readHydrating(t.hydrated, () => t.readLease(stat.size, () => Promise.resolve(fs.readFile(path))));
}

/** A range read, leased for what the range can return rather than what it asks. */
async function readRange(e: SupervisorOpEnvelope, t: SupervisorOpTools, options: { cached?: boolean }): Promise<Uint8Array | null> {
  const fs = fsFor(e, t);
  const path = stringArg(e, 0), offset = numberArg(e, 1), length = numberArg(e, 2);
  const stat = await fs.stat(path);
  const available = stat ? Math.max(0, Math.min(length, stat.size - offset)) : 0;
  return readHydrating(t.hydrated, () => t.readLease(available, () => Promise.resolve(fs.readRange(path, offset, length, options))));
}

/**
 * The ops `createSupervisorOpHandler` serves natively — one pid-keyed
 * filesystem bridge, plus the output stream. This table is the definition:
 * {@link SUPERVISOR_NATIVE_OPS} is its key set and {@link SUPERVISOR_OP_ROUTES}
 * covers exactly the ops it does not name, so no op is listed twice and a
 * session's `extend` overrides can never cover one by accident.
 */
const NATIVE_OPS = {
  readFile: async (e, t) => {
    const bytes = await readWholeFile(e, t, stringArg(e, 0));
    return bytes === null ? null : new TextDecoder().decode(bytes);
  },
  // A process's descriptors are O_SYNC here: each write is answered with what
  // the store did (SqliteVFS holds none of its appends), so a refusal is that
  // write's, and a delivered write's receipt records its outcome.
  fsOpen: (e, t) => fsFor(e, t).open(FsPath.parse(e.args?.[0]), { ...OpenOptions.parse(e.args?.[1]), sync: true }),
  fsRead: (e, t) => {
    const length = numberArg(e, 2);
    return readHydrating(t.hydrated, () => t.readLease(length, () => Promise.resolve(fsFor(e, t).read(numberArg(e, 0), nullableNumberArg(e, 1), length))));
  },
  fsWrite: (e, t) => fsFor(e, t).write(numberArg(e, 0), nullableNumberArg(e, 1), bytesArg(e, 2)),
  fsClose: (e, t) => fsFor(e, t).close(numberArg(e, 0)),
  fsFstat: (e, t) => fsFor(e, t).fstat(numberArg(e, 0)),
  fsDup: (e, t) => fsFor(e, t).dup(numberArg(e, 0)),
  fsSeek: (e, t) => fsFor(e, t).seek(numberArg(e, 0), numberArg(e, 1), z.enum(['set', 'current', 'end']).parse(e.args?.[2])),
  fsSetStatus: (e, t) => fsFor(e, t).setStatus(numberArg(e, 0), z.object({ append: z.boolean().optional() }).parse(e.args?.[1])),
  fsReaddirHandle: (e, t) => fsFor(e, t).readdirHandle(numberArg(e, 0)),
  fsFtruncate: (e, t) => fsFor(e, t).ftruncate(numberArg(e, 0), numberArg(e, 1)),
  fsFchmod: (e, t) => fsFor(e, t).fchmod(numberArg(e, 0), numberArg(e, 1)),
  fsFchown: (e, t) => fsFor(e, t).fchown(numberArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
  fsFutimes: (e, t) => fsFor(e, t).futimes(numberArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
  fsSync: (e, t) => fsFor(e, t).fsync(e.args?.[0] === undefined ? undefined : numberArg(e, 0)),
  fsRealpath: (e, t) => fsFor(e, t).realpath(FsPath.parse(e.args?.[0])),
  fsRemove: (e, t) => fsFor(e, t).remove(FsPath.parse(e.args?.[0]), z.object({ recursive: z.boolean().optional(), force: z.boolean().optional() }).optional().parse(e.args?.[1])),
  fsCopyFile: (e, t) => fsFor(e, t).copyFile(FsPath.parse(e.args?.[0]), FsPath.parse(e.args?.[1])),
  fsCopyTree: (e, t) => fsFor(e, t).copyTree(FsPath.parse(e.args?.[0]), FsPath.parse(e.args?.[1]), z.object({ preserve: z.boolean().optional() }).optional().parse(e.args?.[2])),
  fsAcquireExclusiveMutation: (e, t) => fsFor(e, t).acquireExclusiveMutation(FsPath.parse(e.args?.[0]), z.object({ includeMissingAncestors: z.boolean().optional() }).optional().parse(e.args?.[1])),
  fsReleaseExclusiveMutation: (e, t) => fsFor(e, t).releaseExclusiveMutation(stringArg(e, 0)),
  readFileBytes: (e, t) => readWholeFile(e, t, FsPath.parse(e.args?.[0])),
  stat: (e, t) => fsFor(e, t).stat(FsPath.parse(e.args?.[0]), z.object({ followSymlinks: z.boolean().optional() }).optional().parse(e.args?.[1])),
  lstat: (e, t) => fsFor(e, t).stat(stringArg(e, 0), { followSymlinks: false }),
  exists: async (e, t) => (await fsFor(e, t).stat(stringArg(e, 0))) !== null,
  readdir: (e, t) => fsFor(e, t).readdir(FsPath.parse(e.args?.[0])),
  readlink: (e, t) => fsFor(e, t).readlink(FsPath.parse(e.args?.[0])),
  fsLinkLeadsTo: (e, t) => fsFor(e, t).linkLeadsTo(stringArg(e, 0), stringArg(e, 1)),
  fsReadRange: (e, t) => readRange(e, t, {}),
  // Boot-spec members only: a 34 MiB image read through the LRU would evict the session's hot set.
  fsReadRangeUncached: (e, t) => readRange(e, t, { cached: false }),
  fsRevision: (e, t) => fsFor(e, t).revision(e.args?.[0] === undefined ? undefined : stringArg(e, 0)),
  // The registry is keyed by storage key: a confined process's /tmp/x is its own.
  hasLegacySymlinkUnder: (e, t) => getSymlinkRegistry(t.vfs).hasAtOrBelow(t.vfs.as(t.cred(e.pid, e.cred)).storageKey(stringArg(e, 0))),
  writeFile: (e, t) => fsFor(e, t).writeFile(FsPath.parse(e.args?.[0]), contentArg(e, 1)),
  // writeFile, answering with the path's own stat as the write left it: a
  // process keeps that stat for its sync view, and asked for it in a second
  // call before (node-shims _writeFileAsync). The write is committed before
  // the stat is read, so a stat that fails (a mount's metadata read) leaves
  // the answer without one, never the write failed.
  writeFileStat: async (e, t): Promise<WriteFileStatAnswer> => {
    const fs = fsFor(e, t);
    const path = FsPath.parse(e.args?.[0]);
    const revision = await fs.writeFile(path, contentArg(e, 1));
    try {
      return { revision, stat: (await fs.stat(path, { followSymlinks: false })) ?? null };
    } catch {
      return { revision };
    }
  },
  mkdir: (e, t) => fsFor(e, t).mkdir(FsPath.parse(e.args?.[0]), z.object({ recursive: z.boolean().optional(), mode: z.number().int().nonnegative().optional() }).default({ recursive: true }).parse(e.args?.[1])),
  rmdir: (e, t) => fsFor(e, t).rmdir(FsPath.parse(e.args?.[0])),
  unlink: (e, t) => fsFor(e, t).unlink(FsPath.parse(e.args?.[0])),
  rename: (e, t) => fsFor(e, t).rename(FsPath.parse(e.args?.[0]), FsPath.parse(e.args?.[1]), leaseOf(e)),
  symlink: (e, t) => fsFor(e, t).symlink(stringArg(e, 0), FsPath.parse(e.args?.[1])),
  access: (e, t) => fsFor(e, t).access(FsPath.parse(e.args?.[0]), numberArg(e, 1)),
  chown: (e, t) => fsFor(e, t).chown(FsPath.parse(e.args?.[0]), numberArg(e, 1), numberArg(e, 2), z.object({ followSymlinks: z.boolean().optional() }).optional().parse(e.args?.[3])),
  chmod: (e, t) => fsFor(e, t).chmod(FsPath.parse(e.args?.[0]), numberArg(e, 1)),
  utimes: (e, t) => fsFor(e, t).utimes(FsPath.parse(e.args?.[0]), numberArg(e, 1), numberArg(e, 2)),
  fsTruncate: (e, t) => fsFor(e, t).truncate(FsPath.parse(e.args?.[0]), numberArg(e, 1), leaseOf(e)),
  fsWriteRange: (e, t) => fsFor(e, t).writeRange(FsPath.parse(e.args?.[0]), RangeOffset.parse(e.args?.[1]), writeRangeBytesArg(e, 2), leaseOf(e)),
  // The decode-drain clock starts when the envelope arrives, not when the
  // store first reads it. A fenced wave commits only while its writer's
  // epoch is open on this instance and no newer attempt of it was admitted
  // (SupervisorDeliveries.admitWave); any other instance refuses it.
  writeBatchStream: (e, t) => {
    const decodeDrainStartedAt = performance.now();
    if (!e.stream) throw new Error('supervisor op writeBatchStream: no stream');
    const fence = e.waveFence;
    let admit: (() => void) | undefined;
    let mountReach: WaveMountReach | undefined;
    if (fence !== undefined) {
      if (t.deliveries === undefined || fence.hostIncarnation !== t.deliveries.incarnation || e.pid === undefined) {
        throw Object.assign(
          new Error('ESTALE: writeBatchStream was sent through a binding another instance of this host minted'),
          { code: 'ESTALE' },
        );
      }
      t.bridge(e.pid, e.cred);
      const admission = t.deliveries.admitWave(e.pid, fence.writer, fence.wave, fence.attempt);
      admit = admission.check;
      mountReach = admission.reach;
    }
    return fsFor(e, t).writeStream(e.stream, { decodeDrainStartedAt, mutationOwner: e.mutationOwner, admit, mountReach });
  },
  // A write-wave epoch for the live process that asks, on this instance:
  // the only writer identity a fenced writeBatchStream is admitted under.
  // Repeating it is harmless: an unused epoch admits nothing and expires.
  openWaveWriter: (e, t) => {
    if (t.deliveries === undefined) throw new Error("supervisor op: 'openWaveWriter' is not served by this host");
    if (e.pid === undefined) throw new Error('supervisor op: openWaveWriter names no process');
    t.bridge(e.pid, e.cred);
    return { writer: t.deliveries.openWaveWriter(e.pid, WAVE_EPOCH_TTL_MS), hostIncarnation: t.deliveries.incarnation };
  },
  stdout: (e, t) => t.output?.('stdout', e.pid ?? 0, stringArg(e, 0)),
  stderr: (e, t) => t.output?.('stderr', e.pid ?? 0, stringArg(e, 0)),
} satisfies Partial<Record<SupervisorOpName, SupervisorOpHandler>>;

/** The ops {@link NATIVE_OPS} defines — the route table covers the rest. */
export type NativeOpName = keyof typeof NATIVE_OPS;

export const SUPERVISOR_NATIVE_OPS: ReadonlySet<string> = new Set(Object.keys(NATIVE_OPS));

/** The same two tables, keyed by the raw op string an envelope carries. */
const NATIVE_BY_OP: Readonly<Record<string, SupervisorOpHandler | undefined>> = NATIVE_OPS;
const ROUTE_BY_OP: Readonly<Record<string, SupervisorOpRoute | undefined>> = SUPERVISOR_OP_ROUTES;

/** The pid-keyed bridge cache behind the native filesystem ops. */
export interface SupervisorOpBridgeStore {
  /**
   * The bridge for a pid (cached per pid; the host's under key 0), or — for
   * a host call naming a `cred` — a bridge bound to that credential and to
   * nothing else. Never cached: the host's shared bridge has its credential
   * swapped on every use, and two credentialed host calls interleaving
   * across an await would otherwise read as each other.
   */
  readonly bridge: (pid?: number, cred?: VfsCred) => RuntimeFsBridge;
  /** Drop a pid's bridge — a process exit ends its credential's validity. */
  readonly forget: (pid: number) => Promise<void>;
  /** Close a live pid's descriptors for a run that starts in place of another (NimbusFilesystemAuthority.rewindProcess). */
  readonly rewind?: (pid: number) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * Exported so the session's `supervisorBridge` — used by RPC bodies the
 * envelope delegates back to (fsOpen, fsAppend, writeBatch, …) — is the
 * same cache the handler's native ops serve from, never a second one.
 */
export function createSupervisorBridgeStore(
  deps: Pick<SupervisorOpDeps, 'vfs' | 'processes' | 'filesystem'>,
): SupervisorOpBridgeStore {
  const authority = deps.filesystem ?? new ProcessFiles(deps.vfs);
  const hostLeases = new Map<string, NimbusHostFilesystemLease>();
  return {
    bridge: (pid, cred) => {
      const identity = credFor(deps, pid, cred);
      if (pid !== undefined) return authority.bind({ pid, cred: identity });
      const key = JSON.stringify(identity);
      let lease = hostLeases.get(key);
      if (!lease) { lease = authority.openHost(identity); hostLeases.set(key, lease); }
      return lease.fs;
    },
    forget: (pid) => authority.releaseProcess(pid),
    rewind: async (pid) => { await authority.rewindProcess?.(pid); },
    dispose: async () => {
      await Promise.all([...hostLeases.values()].map(lease => lease.dispose()));
      hostLeases.clear();
    },
  };
}

/** One dispatch method lets any host serve its workspace to process facets. */
/** One envelope in, its result out: what a host forwards `supervisorOp` to. */
export type SupervisorOpDispatch = (envelope: SupervisorOpEnvelope) => Promise<unknown>;

export function createSupervisorOpHandler(
  deps: SupervisorOpDeps,
): SupervisorOpDispatch {
  const bridgeFor = deps.bridge?.bridge ?? createSupervisorBridgeStore(deps).bridge;
  const tools: SupervisorOpTools = {
    bridge: bridgeFor,
    vfs: deps.vfs,
    cred: (pid, cred) => credFor(deps, pid, cred),
    output: deps.output,
    readLease: deps.readLease ?? ((_bytes, read) => read()),
    hydrated: (path) => (deps.filesystem instanceof ProcessFiles ? deps.filesystem.hydrated(path) : Promise.resolve()),
    deliveries: deps.deliveries,
  };
  const extend = deps.extend ?? {};
  const perform = (op: SupervisorOpName, envelope: SupervisorOpEnvelope): unknown => {
    // Priority: the embedder's own handler → the native filesystem op → the
    // canonical route table onto the host's _rpc* methods. An op in none of
    // these is not served by this host.
    const handler = Object.hasOwn(extend, op) ? extend[op]
      : Object.hasOwn(NATIVE_BY_OP, op) ? NATIVE_BY_OP[op] : undefined;
    if (handler) return handler(envelope, tools);
    const route = Object.hasOwn(ROUTE_BY_OP, op) ? ROUTE_BY_OP[op] : undefined;
    if (!route) throw new Error(`supervisor op: '${op}' is not served by this host`);
    const host = deps.host;
    if (!host) {
      throw new Error(
        `supervisor op: '${op}' is a host op, and this handler is a bare workspace's. `
          + 'Forward supervisorOp(envelope) to composeHostedRuntime(...).supervisorOp on every '
          + 'instance of the host namespace, the siblings Nimbus opens by name included '
          + '(fanout peers, process hosts).',
      );
    }
    const method = host[route.method];
    if (typeof method !== 'function') throw new Error(`supervisor op: missing host method ${route.method}`);
    const args = route.args.map((slot) => typeof slot === 'number' ? envelope.args?.[slot] : envelope[slot]);
    return Reflect.apply(method, host, args);
  };
  const serve = (op: SupervisorOpName, envelope: SupervisorOpEnvelope): unknown => deps.observe
    ? deps.observe(envelope, async () => perform(op, envelope)) : perform(op, envelope);
  /**
   * A mutation delivered exactly once (supervisor-delivery.ts), checked in
   * the order that makes a repeat safe: the delivery was minted for THIS
   * instance — a restarted one refuses its predecessor's, permanently, since
   * it holds none of its receipts or descriptors — then the process is live
   * and is who it says, before any receipt answers for it, and only then the
   * receipt, or the mutation.
   */
  const deliver = (envelope: SupervisorOpEnvelope, span: SpanRecorder) => {
    const deliveries = deps.deliveries;
    // Exactly what a host that predates delivery answers: the op is not served.
    if (!deliveries) throw new Error(`supervisor op: '${SUPERVISOR_DELIVER_OP}' is not served by this host`);
    const delivery = Delivery.safeParse(envelope.delivery);
    const op = delivery.success ? supervisorDeliveredOp(delivery.data.op) : undefined;
    if (!delivery.success || op === undefined) {
      throw new Error(`supervisor op: '${SUPERVISOR_DELIVER_OP}' names no mutation it can deliver once`);
    }
    span.set({
      'nimbus.op': op,
      'nimbus.operation_id': delivery.data.id,
      'nimbus.host_incarnation': delivery.data.hostIncarnation,
    });
    if (delivery.data.hostIncarnation !== deliveries.incarnation) {
      throw Object.assign(
        new Error(`ESTALE: ${op} was sent through a binding another instance of this host minted`),
        { code: 'ESTALE' },
      );
    }
    const pid = envelope.pid;
    if (pid === undefined) throw new Error(`supervisor op: a delivered ${op} names no process`);
    // The process's own bridge, which is what refuses a pid that does not
    // exist or has been released (ESTALE), and a cred riding a pid.
    tools.bridge(pid, envelope.cred);
    span.set({ 'nimbus.pid': pid });
    const { receipt, answer } = deliveries.deliver(
      pid, delivery.data.id, op, () => supervisorDeliveryAnswer(serve(op, { ...envelope, op, delivery: undefined })),
    );
    span.set({ 'nimbus.receipt': receipt });
    return answer;
  };
  /**
   * A read sent under a read id: joined to the same read still being served,
   * or served, and served plainly by a host that keeps no store.
   */
  const read = (op: SupervisorOpName, envelope: SupervisorOpEnvelope, span: SpanRecorder): ReturnType<SupervisorOpDispatch> => {
    const joined = supervisorJoinedReadOp(op);
    if (joined === undefined) throw new Error(`supervisor op: '${op}' is not a read, so it cannot carry a read id`);
    const readId = ReadId.safeParse(envelope.readId);
    if (!readId.success) throw new Error(`supervisor op: '${op}' carries a read id that is not one`);
    const plain = { ...envelope, readId: undefined };
    span.set({ 'nimbus.op': op, 'nimbus.read_id': readId.data });
    const pid = envelope.pid;
    const deliveries = deps.deliveries;
    if (deliveries === undefined || pid === undefined) return (async () => serve(op, plain))();
    const { joined: repeat, answer } = deliveries.joinRead(
      pid,
      readId.data,
      joined,
      // A repeat is answered only for the live process that sent the read.
      () => { tools.bridge(pid, envelope.cred); },
      async () => serve(op, plain),
      envelope.run,
    );
    span.set({ 'nimbus.read.joined': repeat });
    return answer;
  };
  /**
   * The session's side of a call the sender repeats is traced
   * (`nimbus.session.deliver` / `nimbus.session.read`), under the RPC span of
   * the attempt that brought it: which process, which operation under which
   * id, and what its receipt or join made of this attempt. A refusal is
   * recorded on the span as the exception the sender receives.
   */
  return async (envelope) => {
    if (!envelope || typeof envelope.op !== 'string') {
      throw new Error('supervisor op: envelope names no operation');
    }
    const op = envelope.op;
    if (op === SUPERVISOR_DELIVER_OP) return traced('nimbus.session.deliver', {}, (span) => deliver(envelope, span));
    // Only the delivering op dedupes; anywhere else a delivery would be a promise nobody keeps.
    if (envelope.delivery !== undefined) throw new Error(`supervisor op: '${op}' cannot carry a delivery`);
    if (envelope.readId !== undefined) return traced('nimbus.session.read', {}, (span) => read(op, envelope, span));
    return serve(op, envelope);
  };
}
