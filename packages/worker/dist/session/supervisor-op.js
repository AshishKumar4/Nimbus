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
import { createSupervisorOpHandler, createSupervisorBridgeStore, SUPERVISOR_OP_ROUTES, } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { withReadAllocation } from './rpc.js';
/** The stdout/stderr ops carry bytes; anything else is a caller bug, named. */
function outputBytesArg(value) {
    if (value instanceof Uint8Array)
        return value;
    throw new Error(`supervisor op stdout/stderr: expected bytes, got ${typeof value}`);
}
export function buildSessionSupervisorOps(host, store, methods) {
    host.ensureSqliteFs();
    const vfs = host.sqliteFs;
    if (!vfs)
        throw new Error('Supervisor filesystem is not initialized');
    store ??= createSupervisorBridgeStore({ vfs, processes: host.processes, filesystem: host.getFilesystemAuthority?.() ?? host.runtimeWorkspace?.filesystem });
    const extend = {
        // The write stream's decode-drain timestamp starts when the envelope
        // arrives, not when the DO first reads it — the same contract
        // _rpcWriteBatchStream has always had.
        writeBatchStream: (envelope, tools) => {
            if (!envelope.stream)
                throw new Error('supervisor op writeBatchStream: no stream');
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
        stdout: (envelope) => host._rpcStdout(envelope.pid ?? 0, outputBytesArg(envelope.args?.[0])),
        stderr: (envelope) => host._rpcStderr(envelope.pid ?? 0, outputBytesArg(envelope.args?.[0])),
    };
    const dispatch = createSupervisorOpHandler({
        vfs: host.sqliteFs,
        processes: host.processes,
        // The session IS the host — its _rpc* methods are the route table's
        // targets. The index signature exists on the declared surface only.
        host: methods ?? Object.fromEntries(Object.values(SUPERVISOR_OP_ROUTES).map(({ method }) => [
            method,
            (...args) => {
                const handler = Reflect.get(host, method);
                if (typeof handler !== 'function')
                    throw new Error(`supervisor op: missing host method ${method}`);
                return Reflect.apply(handler, host, args);
            },
        ])),
        bridge: store,
        // Every native read holds a lease for the payload it can answer with.
        readLease: withReadAllocation,
        extend,
    });
    return { dispatch, bridge: store.bridge, forget: store.forget, dispose: store.dispose };
}
