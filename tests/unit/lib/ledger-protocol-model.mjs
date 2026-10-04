// An exhaustive model of the Dynamic Worker ledger's deadlock protocol: the
// real ledger (packages/fabric/src/budgets.ts), driven by fake processes
// through a protocol adapter, over every interleaving of a small family.
//
// The family: a root guest R holding the workers the limit leaves over, and
// up to three guest holders under it (or under each other), each with up to
// two children of these kinds (a holder under a holder may also print to
// it, once):
//
//   q  a child queued for a worker; admitted, it starts, then exits;
//   b  a builtin running in the session (`sleep`): it may print, then exits;
//   s  a shell line (`sh -c 'node x'`) awaiting a program of its own, which
//      is queued for a worker under a pid the guest never names.
//
// The moves, in any order: a guest finishes its own work and blocks on its
// children (or exits, with none left); a piece of news (a child's start, its
// output, its exit, a refused spawn) is produced, sent and delivered, the
// replies in any order, waking the guest or not; a guest's reports, made as
// its state changes, are delivered in the order made (each waits on the
// last) but at any point relative to everything else; a child exits; a
// refused child's spawn fails; the ledger admits and refuses as it decides.
//
// R is prompt: news reaches it, and its report reaches the ledger, as the
// news is produced. It stands for the rest of the limit, held by a process
// waiting on the family; the races are the holders'.
//
// What must hold:
//   - the ledger never refuses while any process holding a worker can still
//     make progress (checked at each refusal, against the ground truth);
//   - when everything is truly stuck, the ledger refuses (no run ends in a
//     deadlock: every final state has every process done).
//
// The protocol adapter is the seam the protocol under test lives behind: how
// the session numbers news (produce, send), what a guest acknowledges
// (apply) and reports (report), and how the ledger learns the wait-for
// graph (bind, graphChanged).

import * as budgets from '../../../packages/fabric/src/budgets.ts';

const { issueProcessNews, processWaitGraphChanged, setProcessBlocked, bindProcessWaitGraph } = budgets;

/** The protocol as the session and the guests (node-shims.ts) speak it. */
export const CURRENT_PROTOCOL = {
  name: 'current',
  /** The ledger module: holds, waits, admissions and refusals. */
  ledger: budgets,
  /** News is numbered as it is produced; sending it does nothing more. */
  numbersAtSend: false,
  produce: (ctx, holder) => issueProcessNews(ctx, holder),
  send: (_ctx, _holder, tag) => [tag],
  newGuest: () => ({ frontier: 0, ahead: [], seq: 0 }),
  apply(guest, carried) {
    for (const n of carried) if (n > guest.ack.frontier && !guest.ack.ahead.includes(n)) guest.ack.ahead.push(n);
    for (let at; (at = guest.ack.ahead.indexOf(guest.ack.frontier + 1)) >= 0;) {
      guest.ack.ahead.splice(at, 1);
      guest.ack.frontier++;
    }
    guest.ack.ahead.sort((a, b) => a - b);
  },
  key: (guest, blocked) => (blocked ? `blocked@${guest.ack.frontier}` : 'running'),
  /**
   * The guest's numbers, and the ledger's for it, shifted so its frontier is
   * 0 and the last report taken is 0: the protocol compares and steps them,
   * never reads them whole, so two states that differ only by that shift
   * have the same futures.
   */
  canonical(guest, news) {
    const base = guest.ack.frontier;
    const seq0 = news?.reportSeq ?? 0;
    return {
      ahead: guest.ack.ahead.map((n) => n - base),
      seq: guest.ack.seq - seq0,
      said: guest.said.startsWith('blocked@') ? Number(guest.said.slice(8)) - base : guest.said,
      reports: guest.reports.map((r) => [r.blocked, r.frontier - base, r.seq - seq0]),
      inflight: guest.inflight.map((r) => [r.from, r.kind, r.carried.map((n) => n - base)]).map(String).sort(),
      ledger: news ? [news.issued - base, news.blockedAt === null ? null : news.blockedAt - base] : null,
    };
  },
  report: (guest, blocked) => ({ blocked, frontier: guest.ack.frontier, seq: ++guest.ack.seq }),
  deliverReport: (ctx, pid, report) => setProcessBlocked(ctx, pid, report),
  bind: (ctx, graph) => bindProcessWaitGraph(ctx, graph),
  graphChanged: (ctx) => processWaitGraphChanged(ctx),
};

const tick = async () => { for (let i = 0; i < 3; i++) await null; };

/**
 * A family: holders as [{ parent: 'R' | holder index, children: 'q' | 'b' | 's' [] }].
 * Pids: R is 1; holder i is 10 * (i + 1); its j-th child holder pid + j + 1;
 * a shell's program its pid * 10 + 1.
 */
function build(topology) {
  const procs = new Map();
  const add = (p) => { procs.set(p.pid, { exited: false, ...p }); return p; };
  add({ pid: 1, parent: null, kind: 'guest', state: 'busy', outputDone: true });
  topology.forEach((h, i) => {
    const pid = 10 * (i + 1);
    add({ pid, parent: h.parent === 'R' ? 1 : 10 * (h.parent + 1), kind: 'guest', state: 'busy', outputDone: false });
  });
  topology.forEach((h, i) => {
    const holder = 10 * (i + 1);
    h.children.forEach((kind, j) => {
      const pid = holder + j + 1;
      if (kind === 'q') add({ pid, parent: holder, kind: 'queued', state: 'queued' });
      else if (kind === 'b') add({ pid, parent: holder, kind: 'builtin', state: 'running', outputDone: false });
      else {
        add({ pid, parent: holder, kind: 'shell', state: 'awaiting', program: pid * 10 + 1 });
        add({ pid: pid * 10 + 1, parent: pid, kind: 'queued', state: 'queued' });
      }
    });
  });
  return procs;
}

/** One run of the model: a fresh ledger, the family, and the moves taken so far. */
class Run {
  constructor(protocol, topology, focus = null) {
    this.protocol = protocol;
    /** The one guest whose news and reports race, when set; the others are prompt, as R is. */
    this.focus = focus;
    this.ledger = protocol.ledger;
    this.ctx = { id: { toString: () => 'ledger-protocol-model' } };
    this.procs = build(topology);
    this.guests = new Map();
    this.holds = new Map();
    this.violations = [];
    this.refusals = 0;
    /** Admitted children whose start is news still to produce (after the ledger call that admitted them). */
    this.starting = [];
    for (const p of this.procs.values()) {
      if (p.kind !== 'guest') continue;
      const live = [...this.procs.values()].filter((c) => c.parent === p.pid).map((c) => c.pid);
      this.guests.set(p.pid, { pid: p.pid, ack: protocol.newGuest(), said: '', reports: [], pending: [], inflight: [], live });
    }
  }

  get(pid) { return this.procs.get(pid); }
  prompt(pid) { return pid === 1 || (this.focus !== null && pid !== this.focus); }
  running(pid) { const p = this.procs.get(pid); return p !== undefined && !p.exited; }
  children(pid) { return [...this.procs.values()].filter((c) => c.parent === pid && !c.exited).map((c) => c.pid); }

  async setup() {
    const holders = [...this.guests.keys()].filter((pid) => pid !== 1);
    this.protocol.bind(this.ctx, this.protocol.graph ? this.protocol.graph(this) : {
      children: (pid) => this.children(pid),
      awaits: (pid) => {
        const p = this.procs.get(pid);
        return p?.kind === 'shell' && p.state === 'awaiting' && !p.exited ? [p.program] : null;
      },
    });
    const { beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT } = this.ledger;
    this.holds.set(1, Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - holders.length }, (_, i) => beginLoaderFetch(this.ctx, `pad-${i}`, undefined, 1)));
    for (const pid of holders) this.holds.set(pid, [beginLoaderFetch(this.ctx, `run-${pid}`, undefined, pid)]);
    for (const p of this.procs.values()) if (p.kind === 'queued') this.queue(p);
    await tick();
    // R, and every prompt guest, blocks on its children and says so at once.
    for (const g of this.guests.values()) {
      if (!this.prompt(g.pid)) continue;
      await this.move(['finish', g.pid]);
      this.sayAll();
      while (g.reports.length > 0) await this.move(['deliverReport', g.pid]);
    }
  }

  /** A queued child's wait for a worker: admitted, it holds one; refused, its spawn fails. */
  queue(p) {
    this.ledger.beginLoaderFetchWhenFree(this.ctx, `run-${p.pid}`, { process: { pid: p.pid } }).then(
      (end) => {
        p.state = 'admitted';
        this.holds.set(p.pid, [end]);
        // Admitted, it starts (the broker's onStarted, inside the admission).
        this.starting.push(p.pid);
      },
      () => this.refused(p),
    );
  }

  refused(p) {
    this.refusals++;
    const truth = this.truth();
    if (!truth.deadlocked) this.violations.push(`refused ${p.pid} while a holder could still make progress`);
    else if (!truth.stuck.has(p.parent)) this.violations.push(`refused ${p.pid}, whose parent ${p.parent} is not stuck`);
    p.state = 'refused';
  }

  // ── the ground truth ─────────────────────────────────────────────────────

  /** Who is truly stuck, and whether every worker is held by someone stuck while something waits. */
  truth() {
    const queued = new Set([...this.procs.values()].filter((p) => p.state === 'queued').map((p) => p.pid));
    const waitsOn = new Map();
    for (const p of this.procs.values()) {
      if (p.exited) continue;
      if (p.kind === 'guest') {
        const g = this.guests.get(p.pid);
        // Blocked, and every piece of news produced for it applied.
        if (p.state === 'blocked' && g.pending.length === 0 && g.inflight.length === 0) waitsOn.set(p.pid, this.children(p.pid));
      } else if (p.kind === 'shell' && p.state === 'awaiting') {
        waitsOn.set(p.pid, [p.program]);
      }
    }
    const stuck = new Set([...waitsOn].filter(([, on]) => on.length > 0).map(([pid]) => pid));
    for (let changed = true; changed;) {
      changed = false;
      for (const pid of stuck) {
        if (waitsOn.get(pid).some((c) => !queued.has(c) && !stuck.has(c))) { stuck.delete(pid); changed = true; }
      }
    }
    const owners = [...this.holds].filter(([, ends]) => ends.length > 0).map(([pid]) => pid);
    const deadlocked = queued.size > 0 && owners.length > 0 && owners.every((pid) => stuck.has(pid));
    return { stuck, deadlocked };
  }

  // ── moves ────────────────────────────────────────────────────────────────

  moves() {
    const moves = [];
    for (const g of this.guests.values()) {
      const p = this.get(g.pid);
      if (p.exited) continue;
      // A prompt guest moves only as its news comes (news).
      if (this.prompt(g.pid)) continue;
      // Blocking on its children is the guest's own; ending touches the ledger.
      if (p.state === 'busy') moves.push(['finish', g.pid, g.live.length > 0 ? 'block' : 'end']);
      // In the order sent: the guest sends each report after the last has
      // been answered (node-shims __nimbusBlockedChain).
      if (g.reports.length > 0) moves.push(['deliverReport', g.pid]);
      for (const item of g.pending) moves.push(['send', g.pid, item.id]);
      for (const reply of g.inflight) {
        moves.push(['deliver', g.pid, reply.id, 'wake']);
        // Ignored, or acted on: the same to a guest already running.
        if (reply.kind !== 'exit' && p.state === 'blocked') moves.push(['deliver', g.pid, reply.id, 'ignore']);
      }
    }
    // A holder under a holder may print to it, once.
    for (const g of this.guests.values()) {
      const p = this.get(g.pid);
      if (!p.exited && !p.outputDone && p.parent !== null && p.parent !== 1 && !this.get(p.parent).exited) moves.push(['output', g.pid]);
    }
    for (const p of this.procs.values()) {
      if (p.exited) continue;
      if (p.kind === 'builtin') {
        moves.push(['exit', p.pid]);
      } else if (p.kind === 'queued' && p.state === 'admitted') {
        moves.push(['exit', p.pid]);
      } else if (p.kind === 'queued' && p.state === 'refused') {
        moves.push(['fail', p.pid]);
      } else if (p.kind === 'shell' && p.state === 'finishing') {
        moves.push(['exit', p.pid]);
      }
    }
    return moves;
  }

  /** News of `child` for its parent, if that is a guest holding a worker. */
  async news(child, kind) {
    const parent = this.get(this.get(child).parent);
    if (!parent || parent.kind !== 'guest' || parent.exited) return;
    const g = this.guests.get(parent.pid);
    const id = `${child}:${kind}`;
    const item = { id, from: child, kind, tag: this.protocol.produce(this.ctx, parent.pid) };
    if (!this.prompt(parent.pid)) {
      if (this.protocol.numbersAtSend) g.pending.push(item);
      else g.inflight.push({ id, from: child, kind, carried: this.protocol.send(this.ctx, parent.pid, item.tag) });
      return;
    }
    // Prompt: sent, delivered and acted on now, and its report taken now.
    g.inflight.push({ id, from: child, kind, carried: this.protocol.send(this.ctx, parent.pid, item.tag) });
    await this.move(['deliver', parent.pid, id, 'wake']);
    if (parent.state === 'busy') await this.move(['finish', parent.pid]);
    this.sayAll();
    while (!parent.exited && g.reports.length > 0) await this.move(['deliverReport', parent.pid]);
  }

  async ended(pid) {
    const p = this.get(pid);
    p.exited = true;
    const parent = this.get(p.parent);
    if (parent?.kind === 'shell' && parent.program === pid) parent.state = 'finishing';
    this.protocol.graphChanged(this.ctx);
    await tick();
  }

  async releaseHolds(pid) {
    for (const end of this.holds.get(pid) ?? []) end();
    this.holds.set(pid, []);
    await tick();
  }

  /**
   * Each guest says what it is when that changes, as the shim does at the
   * next pass of its event loop (__nimbusReportBlocked): blocked at its
   * frontier, or running. The report waits in order to be delivered.
   */
  sayAll() {
    for (const g of this.guests.values()) {
      const p = this.get(g.pid);
      if (p.exited) continue;
      const blocked = p.state === 'blocked';
      const key = this.protocol.key(g, blocked);
      if (key === g.said || (!blocked && g.said === '')) continue;
      g.said = key;
      g.reports.push(this.protocol.report(g, blocked));
    }
  }

  async play(move) {
    await this.move(move);
    while (this.starting.length > 0) await this.news(this.starting.shift(), 'start');
    this.sayAll();
  }

  async move([move, pid, id, how]) {
    const p = this.get(pid);
    const g = this.guests.get(pid);
    switch (move) {
      case 'finish':
        if (g.live.length > 0) { p.state = 'blocked'; return; }
        p.state = 'done';
        await this.releaseHolds(pid);
        await this.news(pid, 'exit');
        return this.ended(pid);
      case 'deliverReport': {
        const report = g.reports.shift();
        this.protocol.deliverReport(this.ctx, pid, report);
        return tick();
      }
      case 'send': {
        const [item] = g.pending.splice(g.pending.findIndex((n) => n.id === id), 1);
        g.inflight.push({ id: item.id, from: item.from, kind: item.kind, carried: this.protocol.send(this.ctx, pid, item.tag) });
        return;
      }
      case 'deliver': {
        const [reply] = g.inflight.splice(g.inflight.findIndex((n) => n.id === id), 1);
        this.protocol.apply(g, reply.carried, reply);
        if (reply.kind === 'exit') g.live = g.live.filter((c) => c !== reply.from);
        if (how === 'wake' && p.state !== 'done') p.state = 'busy';
        return;
      }
      case 'output':
        p.outputDone = true;
        return this.news(pid, 'output');
      case 'fail':
        await this.news(pid, 'exit');
        return this.ended(pid);
      case 'exit':
        if (p.kind === 'queued') await this.releaseHolds(pid);
        await this.news(pid, 'exit');
        return this.ended(pid);
      default:
        throw new Error(`unknown move ${move}`);
    }
  }

  /** The guests as they stand: their acknowledgements, and news produced or in flight. */
  snapshot() {
    return [...this.guests.values()].map((g) => ({
      pid: g.pid, ack: structuredClone(g.ack), pending: g.pending.map((n) => n.kind), inflight: g.inflight.map((r) => ({ kind: r.kind, carried: r.carried })),
    }));
  }

  /** A canonical description of the state, the ledger's included. */
  key() {
    const sorted = (xs) => xs.map((x) => JSON.stringify(x)).sort();
    const procs = [...this.procs.values()].map((p) => [p.pid, p.state, p.exited, p.outputDone ?? null]);
    const stats = this.ledger.loaderLedgerStats(this.ctx);
    // An exited guest's leftovers (undelivered reports and replies) have no future.
    const guests = [...this.guests.values()].filter((g) => !this.get(g.pid).exited).map((g) => [
      g.pid,
      [...g.live].sort(),
      this.protocol.canonical
        ? this.protocol.canonical(g, stats.news?.[g.pid])
        : [g.ack, g.said, g.reports, sorted(g.pending), sorted(g.inflight), stats.news ?? null],
    ]);
    return JSON.stringify([procs, guests, stats.waiters, stats.holders]);
  }
}

/**
 * A move that only the guest it belongs to sees: applying a reply to it, or
 * its blocking on its children. Two such moves of different guests commute,
 * and neither can refuse or admit anything, so their order is not explored
 * (sleep sets): every order of the others, and of these against the others,
 * still is.
 */
const local = (m) => m[0] === 'deliver' || (m[0] === 'finish' && m[2] === 'block');
const independent = (a, b) => local(a) && local(b) && a[1] !== b[1];
const idOf = (m) => m.join(':');

/**
 * Every interleaving of `topology` under `protocol`, up to `maxStates`
 * distinct states, up to the order of independent moves: the violations
 * found, each with the moves that led there. Each state is reached by
 * replaying its moves on a fresh ledger.
 */
export async function explore(protocol, topology, { maxStates = 200_000, collect = 1, stop = () => false, focus = null } = {}) {
  // State → the moves already covered from it (its sleep set when explored).
  const asleep = new Map();
  const found = [];
  let states = 0;
  let finals = 0;
  const stack = [{ path: [], sleep: [] }];
  while (stack.length > 0 && found.length < collect) {
    const { path, sleep } = stack.pop();
    const run = new Run(protocol, topology, focus);
    await run.setup();
    for (const move of path) await run.play(move);
    if (run.violations.length > 0) {
      found.push({ violation: run.violations[0], path, guests: run.snapshot() });
      if (stop(found.at(-1))) break;
      continue;
    }
    const key = run.key();
    const sleeping = new Set(sleep.map(idOf));
    const before = asleep.get(key);
    if (before !== undefined) {
      // Reached again: only the moves asleep then and awake now are new.
      const awake = [...before].filter((id) => !sleeping.has(id));
      if (awake.length === 0) continue;
      asleep.set(key, new Set([...before].filter((id) => sleeping.has(id))));
      pushChildren(stack, path, sleep, run.moves().filter((m) => awake.includes(idOf(m))));
      continue;
    }
    if (++states > maxStates) throw new Error(`more than ${maxStates} states: narrow the family`);
    asleep.set(key, sleeping);
    const moves = run.moves();
    if (moves.length === 0) {
      finals++;
      const unfinished = [...run.procs.values()].filter((p) => !p.exited).map((p) => p.pid);
      if (unfinished.length > 0) {
        found.push({ violation: `ended stuck with no refusal: ${unfinished.join(', ')} never finished`, path, guests: run.snapshot() });
      }
      continue;
    }
    pushChildren(stack, path, sleep, moves.filter((m) => !sleeping.has(idOf(m))));
  }
  return { states, finals, found };
}

/** Each move's successor, asleep to what it is independent of among the moves before it. */
function pushChildren(stack, path, sleep, moves) {
  const children = [];
  const done = [...sleep];
  for (const move of moves) {
    children.push({ path: [...path, move], sleep: done.filter((s) => independent(s, move)) });
    done.push(move);
  }
  for (const child of children.reverse()) stack.push(child);
}

/** The moves of a path, readable. */
export const describe = (path) => path.map((m) => m.join(':')).join(' → ');
