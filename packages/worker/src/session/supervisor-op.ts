/**
 * The session's supervisor-op handler — one `createSupervisorOpHandler`
 * built over this session's own SQLite filesystem, process table and `_rpc*`
 * surface, so the same code serves process facets, the facet loopback stubs
 * and the SDK's direct `_rpc*` calls.
 *
 * - The native filesystem ops core's handler defines run in-process against
 *   the shared bridge store — the same cache `supervisorBridge` hands the
 *   handle-based and append RPC bodies.
 * - `readFile`, `readFileBytes`, `fsReadRange`, `fsReadRangeUncached` and
 *   `writeBatchStream` are overridden here, not replaced: they are the ops
 *   that carry this DO's heap accounting (read-allocation leases, the
 *   write-stream's decode-drain timestamp).
 * - Every other named op dispatches through `SUPERVISOR_OP_ROUTES` to the
 *   session's `_rpc*` methods — `host` IS the session — exactly as the
 *   canonical route table maps them.
 */
import {
  createSupervisorOpHandler,
  createSupervisorBridgeStore,
  type SupervisorOpBridgeStore,
  type SupervisorOpEnvelope,
  type SupervisorOpHandler,
  type SupervisorOpHost,
  type SupervisorOpName,
  SUPERVISOR_OP_ROUTES,
} from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { RuntimeFsBridge, NimbusFilesystemAuthority } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SupervisorDeliveries } from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { recordSupervisorAnswer } from '@nimbus-sh/platform/diag-counters.js';
import { withReadAllocation } from './rpc.js';

/**
 * The supervisor surface a session exposes to the handler: the `_rpc*`
 * methods SUPERVISOR_OP_ROUTES can name plus the filesystem and process
 * accessors the overrides read. Deliberately not an index-signature record —
 * a class can't carry one, and the handler only ever reads named routes.
 */
export interface SessionSupervisorHost {
  ensureSqliteFs(): void;
  readonly sqliteFs: SqliteVFS | null;
  readonly processes: SessionProcessSupervisor;
  readonly runtimeWorkspace?: { filesystem: NimbusFilesystemAuthority } | null;
  getFilesystemAuthority?(): NimbusFilesystemAuthority;
  /**
   * This instance's receipts for mutations its processes deliver exactly
   * once, opened with `openSupervisorDeliveries(ctx)` before anything is
   * spawned. Absent, the session serves no delivered mutation.
   */
  readonly supervisorDeliveries?: SupervisorDeliveries;
  _rpcStdout(pid: number, data: Uint8Array, at?: number, run?: number): Promise<void>;
  _rpcStderr(pid: number, data: Uint8Array, at?: number, run?: number): Promise<void>;
  /**
   * `envelope` served, not counted: a call the session makes to itself inside
   * another answer (session/rpc.ts _rpcFsAcquired's read). The host's
   * external `supervisorOp` answers through answerSupervisorOp, which counts.
   */
  serveSupervisorOp(envelope: SupervisorOpEnvelope): Promise<unknown>;
}
export interface SessionSupervisorOps {
  readonly dispatch: (envelope: SupervisorOpEnvelope) => Promise<unknown>;
  readonly bridge: (pid?: number) => RuntimeFsBridge;
  /** Drop a pid's bridge — a process exit ends its credential's validity. */
  readonly forget: (pid: number) => void;
  readonly dispose: () => Promise<void>;
  /** Close a live pid's descriptors for a run that starts in place of another. */
  rewind(pid: number): Promise<void>;
}

/** The stdout/stderr ops carry bytes; anything else is a caller bug, named. */
function outputBytesArg(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`supervisor op stdout/stderr: expected bytes, got ${typeof value}`);
}

/** A chunk's offset in what its run printed, and the run, when the guest sent them. */
function outputPlace(args: SupervisorOpEnvelope['args']): [number, number] | [] {
  const at = args?.[1];
  const run = args?.[2];
  return typeof at === 'number' && typeof run === 'number' ? [at, run] : [];
}

export function buildSessionSupervisorOps(
  host: SessionSupervisorHost,
  store?: SupervisorOpBridgeStore,
  methods?: SupervisorOpHost,
): SessionSupervisorOps {
  host.ensureSqliteFs();
  const vfs = host.sqliteFs;
  if (!vfs) throw new Error('Supervisor filesystem is not initialized');
  store ??= createSupervisorBridgeStore({ vfs, processes: host.processes, filesystem: host.getFilesystemAuthority?.() ?? host.runtimeWorkspace?.filesystem });
  const extend: Partial<Record<SupervisorOpName, SupervisorOpHandler>> = {
    // The write stream's decode-drain timestamp starts when the envelope
    // arrives, not when the DO first reads it — the same contract
    // _rpcWriteBatchStream has always had.
    writeBatchStream: (envelope, tools) => {
      if (!envelope.stream) throw new Error('supervisor op writeBatchStream: no stream');
      // Same contract _rpcWriteBatchStream had: a supplied pid must be a
      // real process pid; only an absent pid is a host call.
      const pid = envelope.pid;
      if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
        throw new Error('filesystem RPC requires a valid process pid');
      }
      return tools.bridge(pid, envelope.cred).writeStream(envelope.stream, {
        decodeDrainStartedAt: performance.now(),
        mutationOwner: envelope.mutationOwner,
      });
    },
    // stdout/stderr are session methods, not bridge ops: mirroring,
    // log-append and prior-generation filtering all live in _rpcStdout.
    stdout: (envelope) => host._rpcStdout(envelope.pid ?? 0, outputBytesArg(envelope.args?.[0]), ...outputPlace(envelope.args)),
    stderr: (envelope) => host._rpcStderr(envelope.pid ?? 0, outputBytesArg(envelope.args?.[0]), ...outputPlace(envelope.args)),
  };
  const dispatch = createSupervisorOpHandler({
    vfs: host.sqliteFs!,
    processes: host.processes,
    // The session IS the host — its _rpc* methods are the route table's
    // targets. The index signature exists on the declared surface only.
    host: methods ?? Object.fromEntries(Object.values(SUPERVISOR_OP_ROUTES).map(({ method }) => [
      method,
      (...args: NonNullable<SupervisorOpEnvelope['args']>) => {
        const handler = Reflect.get(host, method);
        if (typeof handler !== 'function') throw new Error(`supervisor op: missing host method ${method}`);
        return Reflect.apply(handler, host, args);
      },
    ])),
    bridge: store,
    // Every native read holds a lease for the payload it can answer with.
    readLease: withReadAllocation,
    extend,
    deliveries: host.supervisorDeliveries,
  });
  const forget: SessionSupervisorOps['forget'] = (pid) => {
    host.supervisorDeliveries?.forget(pid);
    return store.forget(pid);
  };
  return { dispatch, bridge: store.bridge, forget, rewind: async (pid) => { await store.rewind?.(pid); }, dispose: store.dispose };
}

/**
 * Answer `envelope` to a caller outside the session (NimbusSession's
 * `supervisorOp`, which host stubs call): `serve` answers it, and the file
 * contents and stdin the answer hands a process are counted (diag counters'
 * supervisorAnsweredBytes). Only here: a call the session makes to itself
 * (fsAcquired's read) is part of the answer it is in.
 */
export async function answerSupervisorOp(
  serve: (envelope: SupervisorOpEnvelope) => Promise<unknown>,
  envelope: SupervisorOpEnvelope,
): Promise<unknown> {
  const answer = await serve(envelope);
  recordSupervisorAnswer(handedBytes(envelope.op, envelope.args, answer));
  return answer;
}

/**
 * The file contents and stdin in `answer` to `op`: read where each read op's
 * answer carries them, never by walking it (a stat or a listing hands a
 * process no file's contents).
 */
function handedBytes(op: string, args: SupervisorOpEnvelope['args'], answer: unknown): number {
  switch (op) {
    case 'readFile':
      return typeof answer === 'string' ? answer.length : 0;
    case 'readFileBytes':
    case 'fsRead':
    case 'fsReadRange':
    case 'fsReadRangeUncached':
      return answer instanceof Uint8Array ? answer.byteLength : 0;
    case 'fsReadBatch':
      return Array.isArray(answer) ? answer.reduce((total: number, entry: unknown) => total + bytesAt(entry, 'bytes'), 0) : 0;
    case 'cpReadStdin':
      return bytesAt(answer, 'data');
    case 'fsAcquired': {
      // The read it carries, whose op is its second argument.
      const read = args?.[1];
      if (typeof read !== 'string' || typeof answer !== 'object' || answer === null) return 0;
      return handedBytes(read, undefined, Reflect.get(answer, 'value'));
    }
    default:
      return 0;
  }
}

/** The length of `value`'s `field`, when that is bytes. */
function bytesAt(value: unknown, field: string): number {
  if (typeof value !== 'object' || value === null) return 0;
  const bytes: unknown = Reflect.get(value, field);
  return bytes instanceof Uint8Array ? bytes.byteLength : 0;
}
