/**
 * The session's supervisor-op handler — one `createSupervisorOpHandler`
 * built over this session's own SQLite filesystem, process table and `_rpc*`
 * surface, so the same code serves process facets, the facet loopback stubs
 * and the SDK's direct `_rpc*` calls.
 *
 * - The native filesystem ops in core's `ops` table run in-process against
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
} from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { SqliteRuntimeFsBridge } from '@nimbus-sh/core/runtime/sqlite-runtime-fs-bridge.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import {
  FsReadRangeArgsSchema,
  rangeReadBytes,
  withReadAllocation,
} from './rpc.js';
import { dec } from '@nimbus-sh/core/_shared/bytes.js';

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
  _rpcStdout(pid: number, data: Uint8Array): Promise<void>;
  _rpcStderr(pid: number, data: Uint8Array): Promise<void>;
}
export interface SessionSupervisorOps {
  readonly dispatch: (envelope: SupervisorOpEnvelope) => Promise<unknown>;
  readonly bridge: (pid?: number) => SqliteRuntimeFsBridge;
  /** Drop a pid's bridge — a process exit ends its credential's validity. */
  readonly forget: (pid: number) => void;
}

/** The stdout/stderr ops carry bytes; anything else is a caller bug, named. */
function outputBytesArg(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`supervisor op stdout/stderr: expected bytes, got ${typeof value}`);
}

export function buildSessionSupervisorOps(
  host: SessionSupervisorHost,
  store?: SupervisorOpBridgeStore,
): SessionSupervisorOps {
  host.ensureSqliteFs();
  store ??= createSupervisorBridgeStore({ vfs: host.sqliteFs!, processes: host.processes });
  const extend: Partial<Record<SupervisorOpName, SupervisorOpHandler>> = {
    // The native ops whose session bodies carry accounting the bridge
    // alone doesn't know: a read lease sized to what the file can return.
    readFile: async (envelope, tools) => {
      const path = envelope.args?.[0] as string;
      const fs = tools.bridge(envelope.pid, envelope.cred);
      const stat = await fs.stat(path);
      if (!stat) return null;
      return withReadAllocation(stat.size, async () => {
        const bytes = await fs.readFile(path);
        return bytes ? dec.decode(bytes) : null;
      });
    },
    readFileBytes: async (envelope, tools) => {
      const path = envelope.args?.[0] as string;
      const fs = tools.bridge(envelope.pid, envelope.cred);
      const stat = await fs.stat(path);
      if (!stat) return null;
      return withReadAllocation(stat.size, () => fs.readFile(path));
    },
    fsReadRange: async (envelope, tools) => {
      const args = FsReadRangeArgsSchema.parse({
        path: envelope.args?.[0],
        offset: envelope.args?.[1],
        length: envelope.args?.[2],
      });
      const fs = tools.bridge(envelope.pid, envelope.cred);
      return withReadAllocation(
        await rangeReadBytes(fs, args.path, args.offset, args.length),
        () => fs.readRange(args.path, args.offset, args.length),
      );
    },
    fsReadRangeUncached: async (envelope, tools) => {
      const args = FsReadRangeArgsSchema.parse({
        path: envelope.args?.[0],
        offset: envelope.args?.[1],
        length: envelope.args?.[2],
      });
      const fs = tools.bridge(envelope.pid, envelope.cred);
      return withReadAllocation(
        await rangeReadBytes(fs, args.path, args.offset, args.length),
        () => fs.readRange(args.path, args.offset, args.length, { cached: false }),
      );
    },
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
      return tools.vfs.as(tools.cred(pid, envelope.cred)).writeStream(envelope.stream, {
        decodeDrainStartedAt: performance.now(),
        mutationOwner: envelope.mutationOwner,
      });
    },
    // stdout/stderr are session methods, not bridge ops: mirroring,
    // log-append and prior-generation filtering all live in _rpcStdout.
    stdout: (envelope) => host._rpcStdout(envelope.pid ?? 0, outputBytesArg(envelope.args?.[0])),
    stderr: (envelope) => host._rpcStderr(envelope.pid ?? 0, outputBytesArg(envelope.args?.[0])),
  };
  const dispatch = createSupervisorOpHandler({
    vfs: host.sqliteFs!,
    processes: host.processes,
    // The session IS the host — its _rpc* methods are the route table's
    // targets. The index signature exists on the declared surface only.
    host: host as unknown as SupervisorOpHost,
    bridge: store,
    extend,
  });
  return { dispatch, bridge: store.bridge, forget: store.forget };
}
