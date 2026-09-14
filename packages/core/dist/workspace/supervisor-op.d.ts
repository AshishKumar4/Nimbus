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
}
/** One dispatch method lets any host serve its workspace to process facets. */
export declare function createSupervisorOpHandler(deps: SupervisorOpDeps): (envelope: SupervisorOpEnvelope) => Promise<unknown>;
//# sourceMappingURL=supervisor-op.d.ts.map