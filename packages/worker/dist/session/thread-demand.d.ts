/**
 * thread-demand.ts — what may want a session's thread while a one-shot
 * computes there (fabric one-shot-peer.ts SessionDemand), read from the
 * session's own state at the run's start. Each source was measured waiting
 * during a python run in the session against on the peer (2026-10-21,
 * verdict 20261021T153907-db2aae8dc079):
 * 1. a terminal a live peer holds, other than the run's own: a keystroke may
 *    come (a second terminal's echo waited 4.5 s against 0.15 s);
 * 2. a running process other than the run, its ancestors and the shells: a
 *    listening server's request (5.2 s against 0.08 s), another one-shot
 *    (three at once held the thread 6.7-10.6 s against 0.06-0.12 s), a
 *    resident booting;
 * 3. an HTTP request to the session in flight: a file save (4.1 s against
 *    0.22 s). No HTTP route starts a one-shot, so none is the run's own.
 * The run's own terminal is not one: its user waits for the run on either
 * host. A run with none (an exec's) counts every live terminal.
 */
import type { SessionDemand } from '@nimbus-sh/fabric/one-shot-peer.js';
import type { ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import { type AutoResponseHost } from './shell-socket.js';
/** An HTTP request to the session `ctx` began; the answer ends it. */
export declare function requestBegan(ctx: object): () => void;
/** What a session's demand is read from. */
export interface ThreadDemandHost {
    ctx: AutoResponseHost & {
        getWebSockets(): WebSocket[];
    };
    processes: {
        getRunning(): ProcessEntry[];
        get(pid: number): ProcessEntry | undefined;
    };
    /** Whether `pid` is one of the session's shells: its own terminal's, or a named one's. */
    isShell(pid: number): boolean;
}
export declare function threadDemand(host: ThreadDemandHost): SessionDemand;
//# sourceMappingURL=thread-demand.d.ts.map