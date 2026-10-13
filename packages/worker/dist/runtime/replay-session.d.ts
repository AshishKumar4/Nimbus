/**
 * The replay side of a process that can stop (stop-replay.ts): one
 * ReplaySession per process, across its runs, owning its journal (what each
 * run was answered), the TLS connections it opened through the session and
 * the live fetches the outbound makes for it. Closing it settles every wait
 * any of them holds. ReplaySessions is the session's set of them, by pid,
 * and answers the supervisor calls that go through a process's journal.
 */
import { ReplayJournal } from './stop-replay-journal.js';
type DivergeHandler = ConstructorParameters<typeof ReplayJournal>[0];
export declare class ReplaySession {
    readonly pid: number;
    readonly journal: ReplayJournal;
    /** Every session's TLS tokens, by the pid that opened each: another process's token is refused at once. */
    private readonly owners;
    private readonly targets;
    private readonly tickets;
    private closed;
    constructor(pid: number, journal: ReplayJournal, 
    /** Every session's TLS tokens, by the pid that opened each: another process's token is refused at once. */
    owners: Map<string, number>);
    /**
     * A TLS connection opened through the session (`open`: where to; the
     * outbound proxies it), and its upgrade asked for (`upgrade`: answered
     * once the outbound has made the TLS session with the server). Opening
     * one is something a second run would do again.
     */
    netTls(run: string | undefined, action: string, token: string, payload: Record<string, unknown> | undefined): Promise<unknown>;
    /**
     * The outbound side of its network (SupervisorRPC.fetch/connect, the
     * globalOutbound of a run that can stop):
     *   effect(what)            a request that is not a read, a plain connection
     *   fetch(key, what)        a read: { replay: response } or { live: ticket }
     *   fetched(ticket, result) what the live read got; answered when the
     *                           program may have it
     *   connect(token)          where a TLS connection goes
     *   awaitUpgrade(token)     resolves when the guest asks for the TLS session
     *   upgraded(token, result) whether the outbound made it
     */
    outbound(run: string | undefined, action: string, payload: Record<string, unknown> | undefined): Promise<unknown>;
    /**
     * The process ended (or its last run that could stop did): its journal
     * closes, its connections' names are forgotten and every wait they hold
     * is answered, and so is every live fetch. Once.
     */
    close(): void;
    private startFetchBody;
    /** The connection `token` names: this process's own, made on first use; another process's token is no such connection. */
    private target;
}
/** The session's replay sessions, by pid: the supervisor calls that go through a process's journal. */
export declare class ReplaySessions {
    private readonly sessions;
    private readonly owners;
    /** A process that can stop starts its replay session; one it had already is closed first. */
    open(pid: number, onDiverge: DivergeHandler): ReplaySession;
    get(pid: number | undefined): ReplaySession | undefined;
    /** `pid`'s replay session ends, if it has one (ReplaySession.close). */
    close(pid: number): void;
    /**
     * A supervisor call from a process, answered through `dispatch`: for one
     * that can stop, through its journal, which counts what it does outside
     * itself and checks what a run after a stop is answered against the run
     * before it.
     */
    call(op: string, args: readonly unknown[] | undefined, pid: number | undefined, run: string | undefined, dispatch: () => Promise<unknown>): Promise<unknown>;
    stdinPrepared(pid: number, run: string | undefined): void;
    cacheResult(pid: number, run: string | undefined, ticket: string, result: {
        value?: unknown;
        failure?: unknown;
        failed?: boolean;
    }): Promise<void>;
    /** The run after a stop reached the read the run before it stopped at. */
    boundary(pid: number, run: string | undefined): Promise<void>;
    netTls(pid: number, run: string | undefined, action: string, token: string, payload: Record<string, unknown> | undefined): Promise<unknown>;
    outbound(pid: number, run: string | undefined, action: string, payload: Record<string, unknown> | undefined): Promise<unknown>;
}
export {};
//# sourceMappingURL=replay-session.d.ts.map