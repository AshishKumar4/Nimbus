/**
 * The guest half, spliced at module level into a facet runner before the
 * node shims: `const __nimbusStopReplay`, private to the runner module.
 *
 *   ledger(supervisor)   the SUPERVISOR binding, counting calls that do
 *                        something outside the process (default-deny), so the
 *                        read fails where the program can catch it. The
 *                        session counts them too, and is what decides.
 *   begin(launch)        per run: { replay, abort, captured, capturedText,
 *                        nonce, boundary, outbound }.
 *   arm(canStop, whyNot) before the entry: records the run's draws when it can
 *                        stop, replays the stopped run's.
 *   write / acked        each streamed chunk of output on its way out.
 *   readSome / readAll   how many bytes a synchronous read of stdin returns.
 *   block(until, syscall)  a read cannot complete: stops the run, or says why it cannot.
 *   effect(what) / unreplayable(why)  why a stop could not be replayed.
 *   finish() / booted()  at exit, or when a resident is up: a replay that
 *                        never reached the read it stopped at.
 *
 * What it does with the run's nonce in hand uses only what it captured
 * before the program ran: the stop record is serialized here by hand (no
 * JSON, btoa, Error or prototype method the program could have replaced) and
 * handed to ctx.abort as a primitive string.
 */
export declare const STOP_REPLAY_SOURCE: string;
//# sourceMappingURL=stop-replay.d.ts.map