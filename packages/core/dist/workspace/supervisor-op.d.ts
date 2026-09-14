import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
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
export declare const SUPERVISOR_OPS: Readonly<Record<string, SupervisorOpRoute>>;
/** One dispatch method lets any host serve its workspace to process facets. */
export declare function createSupervisorOpHandler(deps: SupervisorOpDeps): (envelope: SupervisorOpEnvelope) => Promise<unknown>;
//# sourceMappingURL=supervisor-op.d.ts.map