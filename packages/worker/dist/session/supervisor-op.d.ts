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
import { type SupervisorOpBridgeStore, type SupervisorOpEnvelope, type SupervisorOpHost } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { RuntimeFsBridge, NimbusFilesystemAuthority } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SupervisorDeliveries } from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
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
    readonly runtimeWorkspace?: {
        filesystem: NimbusFilesystemAuthority;
    } | null;
    getFilesystemAuthority?(): NimbusFilesystemAuthority;
    /**
     * This instance's receipts for mutations its processes deliver exactly
     * once, opened with `openSupervisorDeliveries(ctx)` before anything is
     * spawned. Absent, the session serves no delivered mutation.
     */
    readonly supervisorDeliveries?: SupervisorDeliveries;
    _rpcStdout(pid: number, data: Uint8Array): Promise<void>;
    _rpcStderr(pid: number, data: Uint8Array): Promise<void>;
}
export interface SessionSupervisorOps {
    readonly dispatch: (envelope: SupervisorOpEnvelope) => Promise<unknown>;
    readonly bridge: (pid?: number) => RuntimeFsBridge;
    /** Drop a pid's bridge — a process exit ends its credential's validity. */
    readonly forget: (pid: number) => void;
    readonly dispose: () => Promise<void>;
}
export declare function buildSessionSupervisorOps(host: SessionSupervisorHost, store?: SupervisorOpBridgeStore, methods?: SupervisorOpHost): SessionSupervisorOps;
/**
 * Answer `envelope` to a caller outside the session (NimbusSession's
 * `supervisorOp`, which host stubs call): `serve` answers it, and the file
 * contents and stdin the answer hands a process are counted (diag counters'
 * supervisorAnsweredBytes). Only here: a call the session makes to itself
 * (fsAcquired's read) is part of the answer it is in.
 */
export declare function answerSupervisorOp(serve: (envelope: SupervisorOpEnvelope) => Promise<unknown>, envelope: SupervisorOpEnvelope): Promise<unknown>;
//# sourceMappingURL=supervisor-op.d.ts.map