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
import { registerAllocObserver } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { buildSessionSupervisorOps } from './supervisor-op.js';
export class SessionFilesystem {
    engine;
    host;
    /** The session's namespace and process bindings: one, for the workspace, facets and RPC alike. */
    authority;
    unsubscribe;
    ops = null;
    constructor(engine, host) {
        this.engine = engine;
        this.host = host;
        this.authority = new ProcessFiles(engine, {
            // A delegation's holder that did not answer a recall in time is stopped
            // (SIGKILL): its later writes are refused already (its lease ended), and
            // a process that kept running on a subtree it no longer holds would read
            // a view of it that is no longer true.
            delegationRevoked: ({ pid, root, reason }) => {
                console.warn(`[delegation] pid ${pid} lost /${root}: ${reason}; stopping it`);
                if (!host.facetManager?.kill(pid, 'KILL'))
                    host.processes.kill(pid, 137);
            },
            // A holder that ended still holding a subtree (killed mid-run): what it
            // had decided there and not yet sent is lost, at most what it logged
            // after its last wave. Said in its own output, naming the subtree.
            delegationOrphaned: ({ pid, root }) => {
                console.warn(`[delegation] pid ${pid} ended holding /${root}`);
                host.processes.appendOutput(pid, 'stderr', `[nimbus] process ${pid} ended holding /${root}: changes it made there after its last write wave reached the session are lost\n`);
            },
        });
        // Shrink the disposable LRU while the shared transient-allocation
        // budget is active. Edge-triggered observer callbacks keep nested and
        // concurrent reservations from restoring the cache prematurely.
        this.unsubscribe = registerAllocObserver({
            onAcquire: () => {
                try {
                    engine.shrinkForInstall();
                }
                catch (e) {
                    console.warn('[nimbus/W5] shrinkForInstall threw:', e instanceof Error ? e.message : e);
                }
            },
            onRelease: () => {
                try {
                    engine.restoreAfterInstall();
                }
                catch (e) {
                    console.warn('[nimbus/W5] restoreAfterInstall threw:', e instanceof Error ? e.message : e);
                }
            },
        });
    }
    /**
     * The one supervisor-op handler this session's bindings, loopback stubs and
     * `_rpc*` delegates all dispatch through — native filesystem ops against
     * the shared bridge store, session overrides for the accounting-carrying
     * reads and the output stream, and the canonical route table for the rest.
     * Made on first use.
     */
    supervisorOps() {
        return this.ops ??= buildSessionSupervisorOps(this.host);
    }
    /** Drop a dead pid's supervisor bridge — its credential stops being valid. */
    forget(pid) {
        this.ops?.forget(pid);
    }
    /** Close a live pid's descriptors for a run that starts in place of another. */
    rewind(pid) {
        return this.ops?.rewind(pid) ?? Promise.resolve();
    }
    /** Unsubscribe from the allocation budget and release every host lease the supervisor ops hold. */
    async close() {
        this.unsubscribe();
        await this.ops?.dispose();
    }
}
