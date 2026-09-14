import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { CRED_SESSION_USER, type VfsCred } from '../runtime/os-contracts.js';
import { SqliteRuntimeFsBridge } from '../runtime/sqlite-runtime-fs-bridge.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';

/** Identity comes from the supervisor binding, never from facet arguments. */
export interface SupervisorOpEnvelope {
  readonly op: string;
  readonly args?: readonly unknown[];
  readonly pid?: number;
  readonly writerId?: string;
  readonly mutationOwner?: string;
  readonly stream?: ReadableStream<Uint8Array>;
}

export type SupervisorOpHandler = (envelope: SupervisorOpEnvelope) => unknown;

export interface SupervisorOpDeps {
  readonly vfs: SqliteVFS;
  /** Absent a process table, operations use the unprivileged session user. */
  readonly processes?: SessionProcessSupervisor;
  readonly output?: (stream: 'stdout' | 'stderr', pid: number, data: string) => void;
  /** Host handlers override defaults, for example to account for stream drains. */
  readonly extend?: Readonly<Record<string, SupervisorOpHandler>>;
  /**
   * The embedder's `_rpc*` surface. Ops without a native filesystem handler
   * dispatch here through the canonical table — the host carries the
   * implementation, the table carries the shape.
   */
  readonly host?: Record<string, unknown>;
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

function contentArg(envelope: SupervisorOpEnvelope, index: number): string | Uint8Array {
  const value = envelope.args?.[index];
  if (typeof value === 'string' || value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`supervisor op ${envelope.op}: argument ${index} must be bytes or text`);
}

function credFor(deps: SupervisorOpDeps, pid: number | undefined): VfsCred {
  if (pid === undefined) return CRED_SESSION_USER;
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
 * The canonical supervisor op table — every operation the supervisor RPC
 * serves, its host method, and its argument plan. Three consumers read this
 * one source:
 *
 *   - `sessionSupervisorOp` (worker): the DO's host — dispatches each op to
 *     its `_rpc*` method with hosted accounting and lifecycle work.
 *   - `createSupervisorOpHandler`: an in-process workspace — filesystem ops
 *     run against the VFS directly; every other op dispatches to
 *     `deps.host`, the embedder's `_rpc*` surface.
 *   - `supervisor-host-dispatch`: the test — derives every case's delegate
 *     and expected arguments from this table instead of duplicating it.
 *
 * An op absent here is not served, on any host.
 */
export const SUPERVISOR_OPS: Readonly<Record<string, SupervisorOpRoute>> = {
  readFile: { method: '_rpcReadFile', args: [0,'pid'] },
  readFileBytes: { method: '_rpcReadFileBytes', args: [0,'pid'] },
  writeFile: { method: '_rpcWriteFile', args: [0,1,'pid'] },
  stat: { method: '_rpcStat', args: [0,'pid'] },
  lstat: { method: '_rpcLstat', args: [0,'pid'] },
  hasLegacySymlinkUnder: { method: '_rpcHasLegacySymlinkUnder', args: [0,'pid'] },
  utimes: { method: '_rpcUtimes', args: [0,1,2,'pid'] },
  chmod: { method: '_rpcChmod', args: [0,1,'pid'] },
  access: { method: '_rpcAccess', args: [0,1,'pid'] },
  chown: { method: '_rpcChown', args: [0,1,2,'pid',3] },
  setUmask: { method: '_rpcSetUmask', args: [0,'pid'] },
  readdir: { method: '_rpcReaddir', args: [0,'pid'] },
  exists: { method: '_rpcExists', args: [0,'pid'] },
  mkdir: { method: '_rpcMkdir', args: [0,'pid'] },
  rmdir: { method: '_rpcRmdir', args: [0,'pid'] },
  rename: { method: '_rpcRename', args: [0,1,'pid'] },
  unlink: { method: '_rpcUnlink', args: [0,'pid'] },
  readlink: { method: '_rpcReadlink', args: [0,'pid'] },
  symlink: { method: '_rpcSymlink', args: [0,1,'pid'] },
  fsAcquire: { method: '_rpcFsAcquire', args: [0,1,'pid'] },
  fsRevision: { method: '_rpcFsRevision', args: [0,'pid'] },
  fsList: { method: '_rpcFsList', args: [0,1,'pid'] },
  wsOpen: { method: '_rpcWsOpen', args: [0,1,'pid'] },
  wsPoll: { method: '_rpcWsPoll', args: [0,1,'pid'] },
  wsSend: { method: '_rpcWsSend', args: [0,1,2,'pid'] },
  wsClose: { method: '_rpcWsClose', args: [0,1,2,'pid'] },
  fsOpen: { method: '_rpcFsOpen', args: [0,1,'pid'] },
  fsRead: { method: '_rpcFsRead', args: [0,1,2,'pid'] },
  fsWrite: { method: '_rpcFsWrite', args: [0,1,2,'pid'] },
  fsClose: { method: '_rpcFsClose', args: [0,'pid'] },
  fsReadRange: { method: '_rpcFsReadRange', args: [0,1,2,'pid'] },
  fsReadRangeUncached: { method: '_rpcFsReadRangeUncached', args: [0,1,2,'pid'] },
  fsReadBatch: { method: '_rpcFsReadBatch', args: [0,'pid'] },
  fsWriteRange: { method: '_rpcFsWriteRange', args: [0,1,2,'pid'] },
  fsAppend: { method: '_rpcFsAppend', args: [0,'writerId',1,2,3,'pid'] },
  fsAppendAck: { method: '_rpcFsAppendAck', args: ['writerId',0,1,'pid'] },
  fsTruncate: { method: '_rpcFsTruncate', args: [0,1,'pid'] },
  writeBatch: { method: '_rpcWriteBatch', args: [0,'pid'] },
  writeBatchStream: { method: '_rpcWriteBatchStream', args: ['stream','mutationOwner','pid'] },
  putRegistryEntries: { method: '_rpcPutRegistryEntries', args: [0] },
  stdout: { method: '_rpcStdout', args: ['pid',0] },
  stderr: { method: '_rpcStderr', args: ['pid',0] },
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
} as const;

/** One dispatch method lets any host serve its workspace to process facets. */
export function createSupervisorOpHandler(
  deps: SupervisorOpDeps,
): (envelope: SupervisorOpEnvelope) => Promise<unknown> {
  const bridges = new Map<number, SqliteRuntimeFsBridge>();
  const bridgeFor = (pid: number | undefined): SqliteRuntimeFsBridge => {
    const key = pid ?? 0;
    const credentialed = deps.vfs.as(credFor(deps, pid));
    const held = bridges.get(key);
    if (held) {
      held.updateCredential(credentialed);
      return held;
    }
    const built = new SqliteRuntimeFsBridge(credentialed, deps.vfs);
    bridges.set(key, built);
    return built;
  };
  const ops: Readonly<Record<string, SupervisorOpHandler>> = {
    readFile: async (e) => {
      const bytes = await bridgeFor(e.pid).readFile(stringArg(e, 0));
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    readFileBytes: (e) => bridgeFor(e.pid).readFile(stringArg(e, 0)),
    stat: (e) => bridgeFor(e.pid).stat(stringArg(e, 0)),
    lstat: (e) => bridgeFor(e.pid).stat(stringArg(e, 0), { followSymlinks: false }),
    exists: async (e) => (await bridgeFor(e.pid).stat(stringArg(e, 0))) !== null,
    readdir: (e) => bridgeFor(e.pid).readdir(stringArg(e, 0)),
    readlink: (e) => bridgeFor(e.pid).readlink(stringArg(e, 0)),
    fsReadRange: (e) => bridgeFor(e.pid).readRange(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
    fsReadRangeUncached: (e) => bridgeFor(e.pid).readRange(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2), { cached: false }),
    fsRevision: (e) => bridgeFor(e.pid).revision(e.args?.[0] === undefined ? undefined : stringArg(e, 0)),
    hasLegacySymlinkUnder: (e) => getSymlinkRegistry(deps.vfs).hasAtOrBelow(stringArg(e, 0)),
    writeFile: (e) => bridgeFor(e.pid).writeFile(stringArg(e, 0), contentArg(e, 1)),
    mkdir: (e) => bridgeFor(e.pid).mkdir(stringArg(e, 0), { recursive: true }),
    rmdir: (e) => bridgeFor(e.pid).rmdir(stringArg(e, 0)),
    unlink: (e) => bridgeFor(e.pid).unlink(stringArg(e, 0)),
    rename: (e) => bridgeFor(e.pid).rename(stringArg(e, 0), stringArg(e, 1)),
    symlink: (e) => bridgeFor(e.pid).symlink(stringArg(e, 0), stringArg(e, 1)),
    chmod: (e) => bridgeFor(e.pid).chmod(stringArg(e, 0), numberArg(e, 1)),
    utimes: (e) => bridgeFor(e.pid).utimes(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
    fsTruncate: (e) => bridgeFor(e.pid).truncate(stringArg(e, 0), numberArg(e, 1)),
    writeBatchStream: (e) => {
      if (!e.stream) throw new Error('supervisor op writeBatchStream: no stream');
      return deps.vfs.as(credFor(deps, e.pid)).writeStream(e.stream, { mutationOwner: e.mutationOwner });
    },
    stdout: (e) => { deps.output?.('stdout', e.pid ?? 0, stringArg(e, 0)); },
    stderr: (e) => { deps.output?.('stderr', e.pid ?? 0, stringArg(e, 0)); },
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
      : Object.hasOwn(ops, envelope.op) ? ops[envelope.op] : undefined;
    if (handler) return handler(envelope);
    const route = Object.hasOwn(SUPERVISOR_OPS, envelope.op) ? SUPERVISOR_OPS[envelope.op] : undefined;
    if (!route) throw new Error(`supervisor op: '${envelope.op}' is not served by this host`);
    const host = deps.host;
    if (!host) throw new Error(`supervisor op: '${envelope.op}' needs a host that this workspace does not have`);
    const method = host[route.method];
    if (typeof method !== 'function') throw new Error(`supervisor op: missing host method ${route.method}`);
    const args = route.args.map((slot) => typeof slot === 'number' ? envelope.args?.[slot] : envelope[slot]);
    return Reflect.apply(method, host, args);
  };
}
