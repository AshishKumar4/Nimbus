import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { z } from 'zod';
import { CRED_SESSION_USER, requireVfsCred, type VfsCred } from '../runtime/os-contracts.js';
import { SqliteFilesystemAuthority } from '../runtime/filesystem-authority.js';
import type { NimbusFilesystemAuthority, NimbusHostFilesystemLease, RuntimeFsBridge, RuntimeFsPath } from '../runtime/os-contracts.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';

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

/**
 * Identity comes from the supervisor binding, never from facet arguments: a
 * process's `pid` is stamped by SupervisorRPC from its own props. A HOST call
 * — no pid — acts as the unprivileged session user unless it names a `cred`,
 * which only a caller already trusted with the filesystem can do: the SDK over
 * the DO binding, an embedder composing the workspace. A pid and a cred
 * together are refused, so a process can never widen its own identity.
 */
export interface SupervisorOpEnvelope {
  readonly op: SupervisorOpName;
  readonly args?: readonly unknown[];
  readonly pid?: number;
  /** A host call's credential. Meaningless — and refused — with a pid. */
  readonly cred?: VfsCred;
  readonly writerId?: string;
  readonly mutationOwner?: string;
  readonly stream?: ReadableStream<Uint8Array>;
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
export type SupervisorOpArg = number | 'pid' | 'writerId' | 'stream' | 'mutationOwner';

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
 * An op absent here is not served, on any host.
 */
export const SUPERVISOR_OPS = [
  'readFile', 'readFileBytes', 'writeFile', 'stat', 'lstat',
  'hasLegacySymlinkUnder', 'utimes', 'chmod', 'access', 'chown', 'setUmask',
  'readdir', 'exists', 'mkdir', 'rmdir', 'rename', 'unlink', 'readlink',
  'symlink', 'fsAcquire', 'fsRevision', 'fsList', 'wsOpen', 'wsPoll',
  'wsSend', 'wsClose', 'fsOpen', 'fsRead', 'fsWrite', 'fsClose',
  'fsReadRange', 'fsReadRangeUncached', 'fsReadBatch', 'fsWriteRange',
  'fsAppend', 'fsAppendAck', 'fsTruncate', 'writeBatch', 'writeBatchStream',
  'putRegistryEntries', 'stdout', 'stderr', 'prefetch', 'registerPort',
  'unregisterPort', 'reportExit', 'routeLoopback', 'transform', 'cpSpawn',
  'cpStdinWrite', 'cpStdinEnd', 'cpReadStdin', 'cpReadOutput',
  'cpDrainOutput', 'cpKill', 'cpWait', 'cpDispatchInline',
  'fsFstat', 'fsDup', 'fsSeek', 'fsSetStatus', 'fsReaddirHandle', 'fsFtruncate', 'fsFchmod', 'fsFchown', 'fsFutimes', 'fsSync', 'fsRealpath', 'fsRemove', 'fsCopyFile', 'fsAcquireExclusiveMutation', 'fsReleaseExclusiveMutation',
  'innerDoFetch', 'fanoutExecute', 'processHostProbe', 'hostProcess',
  'awaitHostedOpen', 'awaitHostedBoot', 'routeHostedHttp', 'cancelHostProcess', 'hmrRelay',
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
}

/**
 * The host-side argument plan per op — how an envelope becomes an _rpc*
 * call. Exactly the ops {@link SUPERVISOR_NATIVE_OPS} does NOT name: a
 * native op is answered by the bridge before the host is consulted, so a
 * route for one could never fire.
 */
export const SUPERVISOR_OP_ROUTES: Readonly<Record<Exclude<SupervisorOpName, NativeOpName>, SupervisorOpRoute>> = {
  setUmask: { method: '_rpcSetUmask', args: [0,'pid'] },
  fsAcquire: { method: '_rpcFsAcquire', args: [0,1,'pid'] },
  fsList: { method: '_rpcFsList', args: [0,1,'pid'] },
  wsOpen: { method: '_rpcWsOpen', args: [0,1,'pid'] },
  wsPoll: { method: '_rpcWsPoll', args: [0,1,'pid'] },
  wsSend: { method: '_rpcWsSend', args: [0,1,2,'pid'] },
  wsClose: { method: '_rpcWsClose', args: [0,1,2,'pid'] },
  fsReadBatch: { method: '_rpcFsReadBatch', args: [0,'pid'] },
  fsWriteRange: { method: '_rpcFsWriteRange', args: [0,1,2,'pid'] },
  fsAppend: { method: '_rpcFsAppend', args: [0,'writerId',1,2,3,'pid'] },
  fsAppendAck: { method: '_rpcFsAppendAck', args: ['writerId',0,1,'pid'] },
  writeBatch: { method: '_rpcWriteBatch', args: [0,'pid'] },
  putRegistryEntries: { method: '_rpcPutRegistryEntries', args: [0] },
  prefetch: { method: '_rpcPrefetch', args: [0,1] },
  registerPort: { method: '_rpcRegisterPort', args: ['pid',0] },
  unregisterPort: { method: '_rpcUnregisterPort', args: [0] },
  reportExit: { method: '_rpcReportExit', args: ['pid',0,1] },
  routeLoopback: { method: '_rpcRouteLoopback', args: [0,1] },
  transform: { method: '_rpcTransform', args: [0,1] },
  cpSpawn: { method: '_rpcCpSpawn', args: [0] },
  cpStdinWrite: { method: '_rpcCpStdinWrite', args: [0,1] },
  cpStdinEnd: { method: '_rpcCpStdinEnd', args: [0] },
  cpReadStdin: { method: '_rpcCpReadStdin', args: [0,1] },
  cpReadOutput: { method: '_rpcCpReadOutput', args: [0,1,2,3] },
  cpDrainOutput: { method: '_rpcCpDrainOutput', args: [0] },
  cpKill: { method: '_rpcCpKill', args: [0,1] },
  cpWait: { method: '_rpcCpWait', args: [0,1] },
  cpDispatchInline: { method: '_rpcCpDispatchInline', args: [0,1] },
  innerDoFetch: { method: '_rpcInnerDoFetch', args: [0] },
  fanoutExecute: { method: '_rpcFanoutExecute', args: [0,1,2] },
  processHostProbe: { method: '_rpcProcessHostProbe', args: [] },
  hostProcess: { method: '_rpcHostProcess', args: [0,1] },
  awaitHostedOpen: { method: '_rpcAwaitHostedOpen', args: [0] },
  awaitHostedBoot: { method: '_rpcAwaitHostedBoot', args: [0] },
  routeHostedHttp: { method: '_rpcRouteHostedHttp', args: [0,1] },
  cancelHostProcess: { method: '_rpcCancelHostProcess', args: [0] },
  hmrRelay: { method: '_rpcHmrRelay', args: [0,1] },
} as const;

/** Every native op reads its filesystem the same way: the envelope's identity. */
const fsFor = (e: SupervisorOpEnvelope, tools: SupervisorOpTools): RuntimeFsBridge => tools.bridge(e.pid, e.cred);

/** A whole-file read, leased for what the file holds. */
async function readWholeFile(e: SupervisorOpEnvelope, t: SupervisorOpTools, path: RuntimeFsPath): Promise<Uint8Array | null> {
  const fs = fsFor(e, t);
  const stat = await fs.stat(path);
  if (!stat) return null;
  return t.readLease(stat.size, () => Promise.resolve(fs.readFile(path)));
}

/** A range read, leased for what the range can return rather than what it asks. */
async function readRange(e: SupervisorOpEnvelope, t: SupervisorOpTools, options: { cached?: boolean }): Promise<Uint8Array | null> {
  const fs = fsFor(e, t);
  const path = stringArg(e, 0), offset = numberArg(e, 1), length = numberArg(e, 2);
  const stat = await fs.stat(path);
  const available = stat ? Math.max(0, Math.min(length, stat.size - offset)) : 0;
  return t.readLease(available, () => Promise.resolve(fs.readRange(path, offset, length, options)));
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
  fsOpen: (e, t) => fsFor(e, t).open(FsPath.parse(e.args?.[0]), OpenOptions.parse(e.args?.[1])),
  fsRead: (e, t) => {
    const length = numberArg(e, 2);
    return t.readLease(length, () => Promise.resolve(fsFor(e, t).read(numberArg(e, 0), nullableNumberArg(e, 1), length)));
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
  fsAcquireExclusiveMutation: (e, t) => fsFor(e, t).acquireExclusiveMutation(FsPath.parse(e.args?.[0]), z.object({ includeMissingAncestors: z.boolean().optional() }).optional().parse(e.args?.[1])),
  fsReleaseExclusiveMutation: (e, t) => fsFor(e, t).releaseExclusiveMutation(stringArg(e, 0)),
  readFileBytes: (e, t) => readWholeFile(e, t, FsPath.parse(e.args?.[0])),
  stat: (e, t) => fsFor(e, t).stat(FsPath.parse(e.args?.[0]), z.object({ followSymlinks: z.boolean().optional() }).optional().parse(e.args?.[1])),
  lstat: (e, t) => fsFor(e, t).stat(stringArg(e, 0), { followSymlinks: false }),
  exists: async (e, t) => (await fsFor(e, t).stat(stringArg(e, 0))) !== null,
  readdir: (e, t) => fsFor(e, t).readdir(FsPath.parse(e.args?.[0])),
  readlink: (e, t) => fsFor(e, t).readlink(FsPath.parse(e.args?.[0])),
  fsReadRange: (e, t) => readRange(e, t, {}),
  // Boot-spec members only: a 34 MiB image read through the LRU would evict the session's hot set.
  fsReadRangeUncached: (e, t) => readRange(e, t, { cached: false }),
  fsRevision: (e, t) => fsFor(e, t).revision(e.args?.[0] === undefined ? undefined : stringArg(e, 0)),
  hasLegacySymlinkUnder: (e, t) => getSymlinkRegistry(t.vfs).hasAtOrBelow(stringArg(e, 0)),
  writeFile: (e, t) => fsFor(e, t).writeFile(FsPath.parse(e.args?.[0]), contentArg(e, 1)),
  mkdir: (e, t) => fsFor(e, t).mkdir(FsPath.parse(e.args?.[0]), z.object({ recursive: z.boolean().optional(), mode: z.number().int().nonnegative().optional() }).default({ recursive: true }).parse(e.args?.[1])),
  rmdir: (e, t) => fsFor(e, t).rmdir(FsPath.parse(e.args?.[0])),
  unlink: (e, t) => fsFor(e, t).unlink(FsPath.parse(e.args?.[0])),
  rename: (e, t) => fsFor(e, t).rename(FsPath.parse(e.args?.[0]), FsPath.parse(e.args?.[1])),
  symlink: (e, t) => fsFor(e, t).symlink(stringArg(e, 0), FsPath.parse(e.args?.[1])),
  access: (e, t) => fsFor(e, t).access(FsPath.parse(e.args?.[0]), numberArg(e, 1)),
  chown: (e, t) => fsFor(e, t).chown(FsPath.parse(e.args?.[0]), numberArg(e, 1), numberArg(e, 2), z.object({ followSymlinks: z.boolean().optional() }).optional().parse(e.args?.[3])),
  chmod: (e, t) => fsFor(e, t).chmod(FsPath.parse(e.args?.[0]), numberArg(e, 1)),
  utimes: (e, t) => fsFor(e, t).utimes(FsPath.parse(e.args?.[0]), numberArg(e, 1), numberArg(e, 2)),
  fsTruncate: (e, t) => fsFor(e, t).truncate(FsPath.parse(e.args?.[0]), numberArg(e, 1)),
  writeBatchStream: (e, t) => {
    if (!e.stream) throw new Error('supervisor op writeBatchStream: no stream');
    return fsFor(e, t).writeStream(e.stream, { mutationOwner: e.mutationOwner });
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
  const authority = deps.filesystem ?? new SqliteFilesystemAuthority(deps.vfs);
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
    dispose: async () => {
      await Promise.all([...hostLeases.values()].map(lease => lease.dispose()));
      hostLeases.clear();
    },
  };
}

/** One dispatch method lets any host serve its workspace to process facets. */
export function createSupervisorOpHandler(
  deps: SupervisorOpDeps,
): (envelope: SupervisorOpEnvelope) => Promise<unknown> {
  const bridgeFor = deps.bridge?.bridge ?? createSupervisorBridgeStore(deps).bridge;
  const tools: SupervisorOpTools = {
    bridge: bridgeFor,
    vfs: deps.vfs,
    cred: (pid, cred) => credFor(deps, pid, cred),
    output: deps.output,
    readLease: deps.readLease ?? ((_bytes, read) => read()),
  };
  const extend = deps.extend ?? {};
  return async (envelope) => {
    if (!envelope || typeof envelope.op !== 'string') {
      throw new Error('supervisor op: envelope names no operation');
    }
    // Priority: the embedder's own handler → the native filesystem op → the
    // canonical route table onto the host's _rpc* methods. An op in none of
    // these is not served by this host.
    const handler = Object.hasOwn(extend, envelope.op) ? extend[envelope.op]
      : Object.hasOwn(NATIVE_BY_OP, envelope.op) ? NATIVE_BY_OP[envelope.op] : undefined;
    if (handler) return handler(envelope, tools);
    const route = Object.hasOwn(ROUTE_BY_OP, envelope.op) ? ROUTE_BY_OP[envelope.op] : undefined;
    if (!route) throw new Error(`supervisor op: '${envelope.op}' is not served by this host`);
    const host = deps.host;
    if (!host) throw new Error(`supervisor op: '${envelope.op}' needs a host that this workspace does not have`);
    const method = host[route.method];
    if (typeof method !== 'function') throw new Error(`supervisor op: missing host method ${route.method}`);
    const args = route.args.map((slot) => typeof slot === 'number' ? envelope.args?.[slot] : envelope[slot]);
    return Reflect.apply(method, host, args);
  };
}
