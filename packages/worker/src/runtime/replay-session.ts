/**
 * The replay side of a process that can stop (stop-replay.ts): one
 * ReplaySession per process, across its runs, owning its journal (what each
 * run was answered), the TLS connections it opened through the session and
 * the live fetches the outbound makes for it. Closing it settles every wait
 * any of them holds. ReplaySessions is the session's set of them, by pid,
 * and answers the supervisor calls that go through a process's journal.
 */
import { ReplayJournal, type RecordedResponse } from './stop-replay-journal.js';
import { REPLAY_FETCH_MAX_BYTES, type RecordedBody } from './stop-replay-contracts.js';

type DivergeHandler = ConstructorParameters<typeof ReplayJournal>[0];
type Delivered = Omit<RecordedResponse, 'body'> | { error: string };

/** A TLS connection a process opened through the session, by the token its socket names: where to, and the upgrade rendezvous between the guest asking and the outbound doing it. */
interface NetTarget {
  host: string;
  port: number;
  /** True once the guest opened it; false once the process ended first. */
  registered: Promise<boolean>;
  register: (opened: boolean) => void;
  /** What the program asked of its TLS session; null once the process has ended. */
  asked: Promise<{ servername?: string } | null>;
  ask: (request: { servername?: string } | null) => void;
  answered: Promise<{ ok: boolean; error?: string }>;
  answer: (result: { ok: boolean; error?: string }) => void;
}

/** A live fetch the outbound is making for a journaled answer: its result, by ticket. */
interface FetchTicket {
  run?: string;
  key: string;
  what: string;
  deliver: (value: Delivered) => void;
  done: Promise<unknown>;
  response?: RecordedResponse;
  body?: { deliver: (value: RecordedBody) => void; done: Promise<unknown> };
}

const TOKEN = /^[0-9a-f]{32}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReplaySession {
  private readonly targets = new Map<string, NetTarget>();
  private readonly tickets = new Map<string, FetchTicket>();
  private closed = false;

  constructor(
    readonly pid: number,
    readonly journal: ReplayJournal,
    /** Every session's TLS tokens, by the pid that opened each: another process's token is refused at once. */
    private readonly owners: Map<string, number>,
  ) {}

  /**
   * A supervisor call from one of its runs, answered through `dispatch`
   * through its journal, which counts what it does outside itself and
   * checks what a run after a stop is answered against the run before it.
   */
  call(op: string, args: readonly unknown[] | undefined, run: string | undefined, dispatch: () => Promise<unknown>): Promise<unknown> {
    // A call that names no run is the session's own on the process's behalf
    // (the stat a `< file` relaunch makes), not something a run was told.
    if (run === undefined || op === 'replayBoundary' || op === 'netTls' || op === 'outbound') return dispatch();
    if (op === 'getCachedTarball' || op === 'getPackument') return this.journal.externalRead(op, args, run);
    return this.journal.handle(op, args, run, dispatch);
  }

  /**
   * A TLS connection opened through the session (`open`: where to; the
   * outbound proxies it), and its upgrade asked for (`upgrade`: answered
   * once the outbound has made the TLS session with the server). Opening
   * one is something a second run would do again.
   */
  async netTls(run: string | undefined, action: string, token: string, payload: Record<string, unknown> | undefined): Promise<unknown> {
    if (!this.journal.admits(run) || !TOKEN.test(token)) throw new Error('netTls: no such process or connection');
    if (action === 'open') {
      const host = String(payload?.host ?? ''), port = Number(payload?.port);
      if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('netTls: bad target');
      const refused = await this.journal.beforeEffect(`tls.connect ${host}:${port}`);
      if (refused) throw refused;
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
  async outbound(run: string | undefined, action: string, payload: Record<string, unknown> | undefined): Promise<unknown> {
    const journal = this.journal;
    if (!journal.admits(run)) throw new Error('outbound: this run of the process has stopped');
    switch (action) {
      case 'effect': {
        const refused = await journal.beforeEffect(String(payload?.what ?? 'a request'));
        if (refused) throw refused;
        // The run cannot be replayed now: the outbound need not ask again.
        return { unrecorded: true };
      }
      case 'fetch': {
        // Nothing is recorded for a run that cannot be replayed (D1).
        if (!journal.recording) return { unrecorded: true };
        const key = String(payload?.key ?? '');
        const what = String(payload?.what ?? 'a request');
        let plan!: (value: unknown) => void;
        const planned = new Promise((resolve) => { plan = resolve; });
        const ticket = crypto.randomUUID();
        let deliver!: (value: Delivered) => void;
        const fetched = new Promise<Delivered>((resolve) => { deliver = resolve; });
        let replayed = false;
        let response: RecordedResponse | undefined;
        const done = journal.answer('fetchHeader ' + key, what + ' headers', async (expected) => {
          if (expected?.response) {
            replayed = true; response = expected.response;
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
        const live: FetchTicket = { run, key, what, deliver, done };
        this.tickets.set(ticket, live);
        done.then(() => {
          live.response = response;
          if (replayed) {
            if (response?.hasBody) this.startFetchBody(ticket, live);
            else this.tickets.delete(ticket);
            plan({ replay: response, ticket });
          }
        }, (error) => { this.tickets.delete(ticket); plan({ error: errorMessage(error) }); });
        return await planned;
      }
      case 'fetched': {
        const ticket = String(payload?.ticket ?? '');
        const live = this.tickets.get(ticket);
        if (!live || live.run !== run) throw new Error('outbound: no such request');
        const result = payload?.result as Delivered;
        live.deliver(result);
        try { await live.done; } catch (error) { this.tickets.delete(ticket); throw error; }
        if (!('error' in result) && result.hasBody) this.startFetchBody(ticket, live);
        else this.tickets.delete(ticket);
        return true;
      }
      case 'fetchBody': {
        const ticket = String(payload?.ticket ?? '');
        const live = this.tickets.get(ticket);
        if (!live || live.run !== run || !live.body) throw new Error('outbound: no such response body');
        this.tickets.delete(ticket);
        live.body.deliver(payload?.result as RecordedBody);
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
          if (refused) throw refused;
          return { plain: true, unrecorded: true };
        }
        const target = this.target(token);
        const registered = await Promise.race([target.registered, new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
        if (!registered) throw new Error('outbound: no connection was opened under this name');
        return { host: target.host, port: target.port };
      }
      case 'awaitUpgrade': {
        const target = this.target(String(payload?.token ?? ''));
        return await target.asked;
      }
      case 'upgraded': {
        const target = this.target(String(payload?.token ?? ''));
        const result = payload?.result as { ok: boolean; error?: string } | undefined;
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
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.journal.close();
    for (const [token, target] of this.targets) {
      target.register(false);
      target.ask(null);
      target.answer({ ok: false, error: 'the process ended' });
      if (this.owners.get(token) === this.pid) this.owners.delete(token);
    }
    this.targets.clear();
    for (const live of this.tickets.values()) {
      live.deliver({ error: 'the process ended' });
      live.body?.deliver({ error: 'the process ended' });
    }
    this.tickets.clear();
  }

  private startFetchBody(ticket: string, live: FetchTicket): void {
    if (live.body) return;
    const journal = this.journal;
    journal.bodyStarted(ticket, live.what);
    let deliver!: (value: RecordedBody) => void;
    const pending = new Promise<RecordedBody>((resolve) => { deliver = resolve; });
    const done = journal.answer('fetchBody ' + live.key, live.what + ' body', async () => {
      const result = await pending;
      if ('tooLarge' in result) journal.disqualify(`received a response larger than ${REPLAY_FETCH_MAX_BYTES / 1048576} MiB (${live.what})`);
      else if (live.response) {
        if ('error' in result) { live.response.bodyError = result.error; live.response.bodyFailure = result.failure; }
        if ('body' in result) {
          live.response.body = result.body;
          live.response.chunks = result.chunks;
          journal.bodyBytes(result.body.byteLength);
        }
      }
      return result;
    });
    // The ticket owns the pending answer even if its client is aborted.
    done.catch(() => {});
    live.body = { deliver, done };
  }

  /** The connection `token` names: this process's own, made on first use; another process's token is no such connection. */
  private target(token: string): NetTarget {
    const owner = this.owners.get(token);
    if (owner !== undefined && owner !== this.pid) throw new Error('no such connection');
    let target = this.targets.get(token);
    if (target === undefined) {
      if (this.closed) throw new Error('no such connection');
      let register!: (opened: boolean) => void, ask!: (request: { servername?: string } | null) => void, answer!: (result: { ok: boolean; error?: string }) => void;
      const registered = new Promise<boolean>((resolve) => { register = resolve; });
      const asked = new Promise<{ servername?: string } | null>((resolve) => { ask = resolve; });
      const answered = new Promise<{ ok: boolean; error?: string }>((resolve) => { answer = resolve; });
      target = { host: '', port: 0, registered, register, asked, ask, answered, answer };
      this.targets.set(token, target);
      this.owners.set(token, this.pid);
    }
    return target;
  }
}

/** The session's replay sessions, by pid: the supervisor calls that go through a process's journal. */
export class ReplaySessions {
  private readonly sessions = new Map<number, ReplaySession>();
  private readonly owners = new Map<string, number>();

  /** A process that can stop starts its replay session; one it had already is closed first. */
  open(pid: number, onDiverge: DivergeHandler): ReplaySession {
    this.close(pid);
    const session = new ReplaySession(pid, new ReplayJournal(onDiverge), this.owners);
    this.sessions.set(pid, session);
    return session;
  }

  get(pid: number | undefined): ReplaySession | undefined {
    return pid === undefined ? undefined : this.sessions.get(pid);
  }

  /** `pid`'s replay session ends, if it has one (ReplaySession.close). */
  close(pid: number): void {
    const session = this.sessions.get(pid);
    if (!session) return;
    this.sessions.delete(pid);
    session.close();
  }

  /** A supervisor call from a process, answered through `dispatch`: for one that can stop, through its journal. */
  call(op: string, args: readonly unknown[] | undefined, pid: number | undefined, run: string | undefined, dispatch: () => Promise<unknown>): Promise<unknown> {
    const session = this.get(pid);
    return session ? session.call(op, args, run, dispatch) : dispatch();
  }

  stdinPrepared(pid: number, run: string | undefined): void { this.sessions.get(pid)?.journal.prepared(run); }

  async cacheResult(pid: number, run: string | undefined, ticket: string, result: { value?: unknown; failure?: unknown; failed?: boolean }): Promise<void> {
    const session = this.sessions.get(pid);
    if (!session) throw new Error('no such cache observation');
    await session.journal.externalResult(ticket, result, run);
  }

  /** The run after a stop reached the read the run before it stopped at. */
  async boundary(pid: number, run: string | undefined): Promise<void> {
    await this.sessions.get(pid)?.journal.boundary(run);
  }

  async netTls(pid: number, run: string | undefined, action: string, token: string, payload: Record<string, unknown> | undefined): Promise<unknown> {
    const session = this.sessions.get(pid);
    if (!session) throw new Error('netTls: no such process or connection');
    return session.netTls(run, action, token, payload);
  }

  async outbound(pid: number, run: string | undefined, action: string, payload: Record<string, unknown> | undefined): Promise<unknown> {
    const session = this.sessions.get(pid);
    if (!session) throw new Error('outbound: this run of the process has stopped');
    return session.outbound(run, action, payload);
  }
}
