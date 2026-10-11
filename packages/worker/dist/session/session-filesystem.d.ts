/**
 * session-filesystem.ts — the session's filesystem as one resource.
 *
 * The SQLite engine, the namespace authority over it, the supervisor ops
 * processes reach it through (whose bridge store holds the host leases), and
 * the engine's subscription to the isolate's allocation budget are made
 * together and closed together. A destroy closes the whole of it: the
 * budget's observer set is isolate-wide, so an engine left subscribed stays
 * reachable, and an authority left behind keeps answering, from the old
 * engine, for the session that replaces it.
 */
import { ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { FacetManager } from '../facets/manager.js';
import { type SessionSupervisorHost, type SessionSupervisorOps } from './supervisor-op.js';
/** The session a filesystem serves: whose processes it stops, and whose supervisor ops it answers. */
export type SessionFilesystemHost = SessionSupervisorHost & {
    readonly processes: SessionProcessSupervisor;
    readonly facetManager?: (Pick<FacetManager, 'journalCall' | 'kill'>) | null;
};
export declare class SessionFilesystem {
    readonly engine: SqliteVFS;
    private readonly host;
    /** The session's namespace and process bindings: one, for the workspace, facets and RPC alike. */
    readonly authority: ProcessFiles;
    private readonly unsubscribe;
    private ops;
    constructor(engine: SqliteVFS, host: SessionFilesystemHost);
    /**
     * The one supervisor-op handler this session's bindings, loopback stubs and
     * `_rpc*` delegates all dispatch through — native filesystem ops against
     * the shared bridge store, session overrides for the accounting-carrying
     * reads and the output stream, and the canonical route table for the rest.
     * Made on first use.
     */
    supervisorOps(): SessionSupervisorOps;
    /** Close a live pid's descriptors for a run that starts in place of another. */
    rewind(pid: number): Promise<void>;
    /** Unsubscribe from the allocation budget and release every host lease the supervisor ops hold. */
    close(): Promise<void>;
}
//# sourceMappingURL=session-filesystem.d.ts.map