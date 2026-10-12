/**
 * The replay side of a process that can stop (stop-replay.ts): one
 * ReplaySession per process, across its runs, owning its journal (what each
 * run was answered), the TLS connections it opened through the session and
 * the live fetches the outbound makes for it. Closing it settles every wait
 * any of them holds. ReplaySessions is the session's set of them, by pid,
 * and answers the supervisor calls that go through a process's journal.
 */
import { ReplayJournal } from './stop-replay-journal.js';
import { REPLAY_FETCH_MAX_BYTES } from './stop-replay-contracts.js';
const TOKEN = /^[0-9a-f]{32}$/;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export class ReplaySession {
    pid;
    journal;
    owners;
    targets = new Map();
    tickets = new Map();
    closed = false;
    constructor(pid, journal, 
    /** Every session's TLS tokens, by the pid that opened each: another process's token is refused at once. */
    owners) {
        this.pid = pid;
        this.journal = journal;
        this.owners = owners;
    }
    /**
     * A TLS connection opened through the session (`open`: where to; the
     * outbound proxies it), and its upgrade asked for (`upgrade`: answered
     * once the outbound has made the TLS session with the server). Opening
     * one is something a second run would do again.
     */
    async netTls(run, action, token, payload) {
        if (!this.journal.admits(run) || !TOKEN.test(token))
            throw new Error('netTls: no such process or connection');
        if (action === 'open') {
            const host = String(payload?.host ?? ''), port = Number(payload?.port);
            if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535)
                throw new Error('netTls: bad target');
            const refused = await this.journal.beforeEffect(`tls.connect ${host}:${port}`);
            if (refused)
                throw refused;
            const target = this.target(token);
            target.host = host;
            target.port = port;
            target.register(true);
            return true;
        }
        if (action === 'upgrade') {
            const target = this.target(token);
            const servername = typeof payload?.servername === 'string' ? payload.servername : undefined;
            target.ask(servername === undefined ? {} : { servername });
            return await target.answered;
        }
        throw new Error(`netTls: unknown action ${action}`);
    }
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
    async outbound(run, action, payload) {
        const journal = this.journal;
        if (!journal.admits(run))
            throw new Error('outbound: this run of the process has stopped');
        switch (action) {
            case 'effect': {
                const refused = await journal.beforeEffect(String(payload?.what ?? 'a request'));
                if (refused)
                    throw refused;
                // The run cannot be replayed now: the outbound need not ask again.
                return { unrecorded: true };
            }
            case 'fetch': {
                // Nothing is recorded for a run that cannot be replayed (D1).
                if (!journal.recording)
                    return { unrecorded: true };
                const key = String(payload?.key ?? '');
                const what = String(payload?.what ?? 'a request');
                let plan;
                const planned = new Promise((resolve) => { plan = resolve; });
                const ticket = crypto.randomUUID();
                let deliver;
                const fetched = new Promise((resolve) => { deliver = resolve; });
                let replayed = false;
                let response;
                const done = journal.answer('fetchHeader ' + key, what + ' headers', async (expected) => {
                    if (expected?.response) {
                        replayed = true;
                        response = expected.response;
                        const { status, statusText, headers, hasBody } = response;
                        return { status, statusText, headers, hasBody };
                    }
                    plan({ live: ticket });
                    const result = await fetched;
                    if ('error' in result) {
                        // A pre-headers platform rejection has not crossed as a
                        // Response. Keep the live error, but never replay an incomplete
                        // failure shape (the body-error protocol below records one).
                        journal.disqualify(`${what} failed before its headers (${result.error})`);
                        throw new Error(result.error);
                    }
                    response = { ...result, body: new Uint8Array(0) };
                    return result;
                }, () => response);
                const live = { run, key, what, deliver, done };
                this.tickets.set(ticket, live);
                done.then(() => {
                    live.response = response;
                    if (replayed) {
                        if (response?.hasBody)
                            this.startFetchBody(ticket, live);
                        else
                            this.tickets.delete(ticket);
                        plan({ replay: response, ticket });
                    }
                }, (error) => { this.tickets.delete(ticket); plan({ error: errorMessage(error) }); });
                return await planned;
            }
            case 'fetched': {
                const ticket = String(payload?.ticket ?? '');
                const live = this.tickets.get(ticket);
                if (!live || live.run !== run)
                    throw new Error('outbound: no such request');
                const result = payload?.result;
                live.deliver(result);
                try {
                    await live.done;
                }
                catch (error) {
                    this.tickets.delete(ticket);
                    throw error;
                }
                if (!('error' in result) && result.hasBody)
                    this.startFetchBody(ticket, live);
                else
                    this.tickets.delete(ticket);
                return true;
            }
            case 'fetchBody': {
                const ticket = String(payload?.ticket ?? '');
                const live = this.tickets.get(ticket);
                if (!live || live.run !== run || !live.body)
                    throw new Error('outbound: no such response body');
                this.tickets.delete(ticket);
                live.body.deliver(payload?.result);
                await live.body.done;
                journal.bodyFinished(ticket);
                return true;
            }
            case 'connect': {
                const token = String(payload?.token ?? '');
                if (!TOKEN.test(token)) {
                    // A plain connection (not one the TLS shim opened): proxied, and
                    // something a second run would do again.
                    const refused = await journal.beforeEffect(`connect ${token}`);
                    if (refused)
                        throw refused;
                    return { plain: true, unrecorded: true };
                }
                const target = this.target(token);
                const registered = await Promise.race([target.registered, new Promise((r) => setTimeout(() => r(false), 10_000))]);
                if (!registered)
                    throw new Error('outbound: no connection was opened under this name');
                return { host: target.host, port: target.port };
            }
            case 'awaitUpgrade': {
                const target = this.target(String(payload?.token ?? ''));
                return await target.asked;
            }
            case 'upgraded': {
                const target = this.target(String(payload?.token ?? ''));
                const result = payload?.result;
                target.answer(result && result.ok ? { ok: true } : { ok: false, error: String(result?.error ?? 'the TLS session could not be made') });
                return true;
            }
            default:
                throw new Error(`outbound: unknown action ${action}`);
        }
    }
    /**
     * The process ended (or its last run that could stop did): its journal
     * closes, its connections' names are forgotten and every wait they hold
     * is answered, and so is every live fetch. Once.
     */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.journal.close();
        for (const [token, target] of this.targets) {
            target.register(false);
            target.ask(null);
            target.answer({ ok: false, error: 'the process ended' });
            if (this.owners.get(token) === this.pid)
                this.owners.delete(token);
        }
        this.targets.clear();
        for (const live of this.tickets.values()) {
            live.deliver({ error: 'the process ended' });
            live.body?.deliver({ error: 'the process ended' });
        }
        this.tickets.clear();
    }
    startFetchBody(ticket, live) {
        if (live.body)
            return;
        const journal = this.journal;
        journal.bodyStarted(ticket, live.what);
        let deliver;
        const pending = new Promise((resolve) => { deliver = resolve; });
        const done = journal.answer('fetchBody ' + live.key, live.what + ' body', async () => {
            const result = await pending;
            if ('tooLarge' in result)
                journal.disqualify(`received a response larger than ${REPLAY_FETCH_MAX_BYTES / 1048576} MiB (${live.what})`);
            else if (live.response) {
                if ('error' in result) {
                    live.response.bodyError = result.error;
                    live.response.bodyFailure = result.failure;
                }
                if ('body' in result) {
                    live.response.body = result.body;
                    live.response.chunks = result.chunks;
                    journal.bodyBytes(result.body.byteLength);
                }
            }
            return result;
        });
        // The ticket owns the pending answer even if its client is aborted.
        done.catch(() => { });
        live.body = { deliver, done };
    }
    /** The connection `token` names: this process's own, made on first use; another process's token is no such connection. */
    target(token) {
        const owner = this.owners.get(token);
        if (owner !== undefined && owner !== this.pid)
            throw new Error('no such connection');
        let target = this.targets.get(token);
        if (target === undefined) {
            if (this.closed)
                throw new Error('no such connection');
            let register, ask, answer;
            const registered = new Promise((resolve) => { register = resolve; });
            const asked = new Promise((resolve) => { ask = resolve; });
            const answered = new Promise((resolve) => { answer = resolve; });
            target = { host: '', port: 0, registered, register, asked, ask, answered, answer };
            this.targets.set(token, target);
            this.owners.set(token, this.pid);
        }
        return target;
    }
}
/** The session's replay sessions, by pid: the supervisor calls that go through a process's journal. */
export class ReplaySessions {
    sessions = new Map();
    owners = new Map();
    /** A process that can stop starts its replay session; one it had already is closed first. */
    open(pid, onDiverge) {
        this.close(pid);
        const session = new ReplaySession(pid, new ReplayJournal(onDiverge), this.owners);
        this.sessions.set(pid, session);
        return session;
    }
    get(pid) {
        return pid === undefined ? undefined : this.sessions.get(pid);
    }
    /** `pid`'s replay session ends, if it has one (ReplaySession.close). */
    close(pid) {
        const session = this.sessions.get(pid);
        if (!session)
            return;
        this.sessions.delete(pid);
        session.close();
    }
    /**
     * A supervisor call from a process, answered through `dispatch`: for one
     * that can stop, through its journal, which counts what it does outside
     * itself and checks what a run after a stop is answered against the run
     * before it.
     */
    call(op, args, pid, run, dispatch) {
        const journal = pid === undefined ? undefined : this.sessions.get(pid)?.journal;
        // A call that names no run is the session's own on the process's behalf
        // (the stat a `< file` relaunch makes), not something a run was told.
        if (!journal || run === undefined || op === 'replayBoundary' || op === 'netTls' || op === 'outbound')
            return dispatch();
        if (op === 'getCachedTarball' || op === 'getPackument')
            return journal.externalRead(op, args, run);
        return journal.handle(op, args, run, dispatch);
    }
    stdinPrepared(pid, run) { this.sessions.get(pid)?.journal.prepared(run); }
    async cacheResult(pid, run, ticket, result) {
        const session = this.sessions.get(pid);
        if (!session)
            throw new Error('no such cache observation');
        await session.journal.externalResult(ticket, result, run);
    }
    /** The run after a stop reached the read the run before it stopped at. */
    async boundary(pid, run) {
        await this.sessions.get(pid)?.journal.boundary(run);
    }
    netTls(pid, run, action, token, payload) {
        const session = this.sessions.get(pid);
        return session ? session.netTls(run, action, token, payload) : Promise.reject(new Error('netTls: no such process or connection'));
    }
    outbound(pid, run, action, payload) {
        const session = this.sessions.get(pid);
        return session ? session.outbound(run, action, payload) : Promise.reject(new Error('outbound: this run of the process has stopped'));
    }
}
