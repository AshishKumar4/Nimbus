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
import type { SessionDemand, ThreadWant } from '@nimbus-sh/fabric/one-shot-peer.js';
import type { ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import { liveTerminals, type AutoResponseHost } from './shell-socket.js';

const inFlight = new WeakMap<object, number>();

/** An HTTP request to the session `ctx` began; the answer ends it. */
export function requestBegan(ctx: object): () => void {
  inFlight.set(ctx, (inFlight.get(ctx) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight.set(ctx, (inFlight.get(ctx) ?? 1) - 1);
  };
}

/** What a session's demand is read from. */
export interface ThreadDemandHost {
  ctx: AutoResponseHost & { getWebSockets(): WebSocket[] };
  processes: { getRunning(): ProcessEntry[]; get(pid: number): ProcessEntry | undefined };
  /** Whether `pid` is one of the session's shells: its own terminal's, or a named one's. */
  isShell(pid: number): boolean;
}

export function threadDemand(host: ThreadDemandHost): SessionDemand {
  return {
    wants(pid: number | undefined): ThreadWant[] {
      const wants: ThreadWant[] = [];
      const own = pid === undefined ? undefined : host.processes.get(pid);
      const terminals = liveTerminals(host.ctx, host.ctx.getWebSockets());
      // The process table names the session's own terminal '' and the socket stamp undefined.
      if (own?.terminal !== undefined) terminals.delete(own.terminal === '' ? undefined : own.terminal);
      if (terminals.size > 0) wants.push('terminal');
      const ancestry = new Set<number>();
      for (let entry = own; entry !== undefined && !ancestry.has(entry.pid); entry = entry.parentPid === undefined ? undefined : host.processes.get(entry.parentPid)) {
        ancestry.add(entry.pid);
      }
      if (host.processes.getRunning().some((entry) => !ancestry.has(entry.pid) && !host.isShell(entry.pid))) wants.push('process');
      if ((inFlight.get(host.ctx) ?? 0) > 0) wants.push('request');
      return wants;
    },
  };
}
