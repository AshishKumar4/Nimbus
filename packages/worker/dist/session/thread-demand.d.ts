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
 *    resident booting. An ancestor that listens on a port is one too: a
 *    server that starts the run still answers requests while it runs;
 * The run's own terminal is not one: its user waits for the run on either
 * host. A run with none (an exec's) counts every live terminal.
 *
 * Not one: an HTTP request in flight. Work that goes on after a handler
 * returns comes from a running process (a preview's response, a log stream)
 * or a socket, counted above; the agent's turn waits for the run it started,
 * as the run's own terminal does. What is left is a handler awaiting
 * storage (a save) as the run starts: it waits at most the run's hold, as a
 * save that comes mid-run does (measured 3.2-4.1 s against 0.22-0.30 s on
 * the peer, the cost this placement accepts for an idle session).
 */
import type { SessionDemand } from '@nimbus-sh/fabric/one-shot-peer.js';
import type { ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import { type AutoResponseHost } from './shell-socket.js';
/** What a session's demand is read from. */
export interface ThreadDemandHost {
    ctx: AutoResponseHost & {
        getWebSockets(): WebSocket[];
    };
    processes: {
        getRunning(): ProcessEntry[];
        get(pid: number): ProcessEntry | undefined;
    };
    /** Whether `pid` listens on a port. */
    listens(pid: number): boolean;
    /** Whether `pid` is one of the session's shells: its own terminal's, or a named one's. */
    isShell(pid: number): boolean;
}
export declare function threadDemand(host: ThreadDemandHost): SessionDemand;
//# sourceMappingURL=thread-demand.d.ts.map