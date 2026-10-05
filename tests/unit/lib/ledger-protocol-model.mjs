// An exhaustive model of the Dynamic Worker ledger's deadlock protocol, wired
// to the production pieces the protocol is made of, over every interleaving
// of a small family:
//
//   - the ledger: packages/fabric/src/budgets.ts (holds, waits, admission,
//     refusal, news numbering, reports), bound to the process table as the
//     session binds it (bindProcessTable); a refusal it puts off to a later
//     turn is a move of its own here ('decide'), taken in any order with
//     the others;
//   - the process table and its work and await accounting:
//     packages/core/src/runtime/session-process-supervisor.ts, driven with
//     the calls the production paths make, in their order (a shell line, an
//     element of a pipeline and a background job are each a WorkThread, the
//     interpreter's, whose commands are its pid's work; FacetManager.exec
//     records an await of the program it runs for its invoker, npm's tracked
//     script an await of its wrapper, and an exit forgets what the process
//     waited on);
//   - each guest's half of the news protocol: the text of
//     packages/worker/src/runtime/child-news.ts, evaluated as the shims embed
//     it (or a mutant of that text).
//
// Only the ground truth is the model's own: who could still make progress.
//
// The family: a root guest R holding the workers the limit leaves over, and
// up to three guest holders under it (or under each other), each with up to
// two children of these kinds (a holder under a holder may also print to it,
// once):
//
//   q  a child queued for a worker; admitted, it starts, then exits;
//   b  a builtin running in the session (`sleep`): it may print, then exits;
//   s  `sh -c 'node x'`: a shell awaiting its program, queued for a worker
//      under a pid the guest never names;
//   f  `sh -c 'sleep 1; node x'`: a builtin first, then as s;
//   n  `sh -c 'npm run build'` with build `node x && true`: a shell awaiting
//      npm's script wrapper, itself a shell awaiting the program;
//   g  `sh -c 'node x & sleep 1; wait'`: the program in the background while
//      a builtin runs, then `wait`. Awaiting it is never the shell's only
//      work by the session's account, so a family with g that is truly stuck
//      waits rather than refuses: a known limit, checked for safety only.
//   k  `sh -c 'node x | (sleep 1; kill x)'`: the program in one element of a
//      pipeline, and in the other a builtin, then a `kill` of the program,
//      begun in the same turn the builtin ends;
//   K  the same, with the `kill` begun on a later turn (its line had more to
//      do first: `kill $(cat x.pid)` reads a file). Until the kill has run
//      the shell is never stuck: it will end the program.
//
// The moves, in any order: a guest finishes its own work and blocks on its
// children (or exits, with none left); a piece of news (a child's start, its
// output, its exit) is produced and delivered, the replies in any order,
// waking the guest or not; a guest's reports, made as its state changes, are
// delivered in the order made but at any point relative to everything else;
// a child, a shell's builtin, a shell exits; the ledger admits and refuses as
// it decides.
//
// R is prompt: news reaches it, and its report reaches the ledger, as the
// news is produced. It stands for the rest of the limit, held by a process
// waiting on the family; the races are the holders'.
//
// What must hold:
//   - safety: the ledger never refuses while any process holding a worker
//     can still make progress (checked at each refusal, against the truth);
//   - liveness: when everything is truly stuck, the ledger refuses (no run
//     ends in a deadlock: every final state has every process done), for a
//     family without g.

import * as budgets from '../../../packages/fabric/src/budgets.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { CHILD_NEWS_SOURCE } from '../../../packages/worker/src/runtime/child-news.ts';
import { WorkThread } from '../../../packages/core/src/substrate/lifo/shell/work-thread.ts';

const { beginLoaderFetch, beginLoaderFetchWhenFree, bindProcessTable, DO_DYNAMIC_WORKER_LIMIT, issueProcessNews, loaderLedgerStats, setProcessBlocked } = budgets;

/** A guest news tracker factory from its source text: child-news.ts's, or a mutant of it. */
export const guestNewsFrom = (source) => new Function(`return (${source});`)();

/** The production pieces: the guest as the shims embed it, the table as the session keeps it. */
export const PRODUCTION = {
  name: 'production',
  createChildNews: guestNewsFrom(CHILD_NEWS_SOURCE),
  /** A hook to mutate the process table's accounting (a mutant); production leaves it alone. */
  patchProcesses: null,
  /** A shell's threads of control as its work (the interpreter's). */
  WorkThread,
  /** The ledger puts a refusal off to a later turn (bindProcessTable's schedule); false decides on the change's own path. */
  decideLater: true,
};

/**
 * The accounting before WorkThread, for mutants: each command of a shell
 * counted on its pid, nothing between them.
 */
export class CommandsOnly {
  constructor(begin) { this.begin = begin; }
  beginWork() { return this.begin(); }
  fork() { return new CommandsOnly(this.begin); }
  sibling() { return new CommandsOnly(this.begin); }
  close() {}
}

const tick = async () => { for (let i = 0; i < 3; i++) await null; };

/** Shell kinds: a shell child of a guest, with the program it ends up awaiting. */
const SHELL_KINDS = new Set(['s', 'f', 'n', 'g', 'k', 'K']);

/**
 * The family's processes, as model records: `id` is a readable label (R is
 * 1; holder i is 10 * (i + 1); its j-th child holder + j + 1; a shell's
 * program its id * 10 + 1, npm's wrapper its id * 10 + 2), `pid` the pid the
 * real process table gives it.
 */
function build(topology) {
  const procs = [];
  const add = (p) => { procs.push({ exited: false, ...p }); };
  add({ id: 1, parent: null, kind: 'guest', state: 'busy', outputDone: true });
  topology.forEach((h, i) => {
    add({ id: 10 * (i + 1), parent: h.parent === 'R' ? 1 : 10 * (h.parent + 1), kind: 'guest', state: 'busy', outputDone: false });
  });
  topology.forEach((h, i) => {
    const holder = 10 * (i + 1);
    h.children.forEach((kind, j) => {
      const id = holder + j + 1;
      if (kind === 'q') add({ id, parent: holder, kind: 'queued', state: 'queued' });
      else if (kind === 'b') add({ id, parent: holder, kind: 'builtin', state: 'running', outputDone: false });
      else if (SHELL_KINDS.has(kind)) add({ id, parent: holder, kind: 'shell', shell: kind, phase: 'starting', program: id * 10 + 1 });
      else throw new Error(`unknown child kind ${kind}`);
    });
  });
  return procs;
}

/** One run of the model: a fresh ledger and process table, the family, and the moves taken so far. */
class Run {
  constructor(production, topology, focus = null) {
    this.production = production;
    /** The one guest whose news and reports race, when set; the others are prompt, as R is. */
    this.focus = focus;
    this.ctx = { id: { toString: () => 'ledger-protocol-model' } };
    this.processes = new SessionProcessSupervisor();
    production.patchProcesses?.(this.processes);
    this.byId = new Map();
    for (const p of build(topology)) this.byId.set(p.id, p);
    this.guests = new Map();
    this.holds = new Map();
    this.violations = [];
    this.knownLimit = topology.some((h) => h.children.includes('g'));
    /** Admitted children whose start is news still to produce (after the ledger call that admitted them). */
    this.starting = [];
    /** Work and await ends the production paths hold, by label. */
    this.ends = new Map();
    /** Refusals the ledger has put off to a later turn, in order: each a 'decide' move. */
    this.decisions = [];
  }

  get(id) { return this.byId.get(id); }
  prompt(id) { return id === 1 || (this.focus !== null && id !== this.focus); }
  children(id) { return [...this.byId.values()].filter((c) => c.parent === id && !c.exited).map((c) => c.id); }

  /** Spawn `p` in the process table, under its parent. */
  spawn(p) {
    const parent = p.parent === null ? undefined : this.get(p.parent).pid;
    p.pid = this.processes.spawn(`model-${p.id}`, [], '/', parent === undefined ? {} : { parentPid: parent }).pid;
  }

  /** Hold an end function a production path holds (a command's work, a wrapper's await). */
  holdEnd(id, end) { const list = this.ends.get(id) ?? []; list.push(end); this.ends.set(id, list); }
  runEnds(id) { for (const end of this.ends.get(id) ?? []) end(); this.ends.delete(id); }

  async setup() {
    bindProcessTable(this.ctx, this.processes, this.production.decideLater ? (decide) => this.decisions.push(decide) : (decide) => decide());
    const holders = [...this.byId.values()].filter((p) => p.kind === 'guest' && p.id !== 1);
    for (const p of this.byId.values()) if (p.kind === 'guest' || p.kind === 'queued' || p.kind === 'builtin') this.spawn(p);
    for (const p of [...this.byId.values()]) {
      if (p.kind !== 'guest') continue;
      this.guests.set(p.id, {
        id: p.id,
        news: this.production.createChildNews((report) => this.guests.get(p.id).reports.push(report)),
        reports: [],
        inflight: [],
        live: this.children(p.id),
      });
    }
    const root = this.get(1);
    this.holds.set(1, Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - holders.length }, (_, i) => beginLoaderFetch(this.ctx, `pad-${i}`, undefined, root.pid)));
    for (const h of holders) this.holds.set(h.id, [beginLoaderFetch(this.ctx, `run-${h.id}`, undefined, h.pid)]);
    for (const p of [...this.byId.values()]) {
      if (p.kind === 'queued') this.queue(p);
      if (p.kind === 'shell') this.startShell(p);
    }
    for (const g of this.guests.values()) g.live = this.children(g.id);
    await tick();
    // R, and every prompt guest, blocks on its children and says so at once.
    for (const g of this.guests.values()) {
      if (!this.prompt(g.id)) continue;
      await this.move(['finish', g.id]);
      this.sayAll();
      while (g.reports.length > 0) await this.move(['deliverReport', g.id]);
    }
  }

  /**
   * A shell child starts its line, with the accounting the production paths
   * keep: the line is a WorkThread of its pid (Interpreter.executeLine), as
   * is each element of a pipeline (forked from it) and a background job
   * (beside it); each command is a unit of work under its thread; exec
   * spawns the program under the invoker and records the invoker's await of
   * it; npm's tracked script runs on a shell of its own under its wrapper's
   * pid, and records the command's await of the wrapper.
   */
  startShell(s) {
    this.spawn(s);
    const line = this.thread(s.pid);
    s.line = line;
    if (s.shell === 'f') {
      // `sleep 1` first: the builtin is the shell's work.
      this.holdEnd(`${s.id}:sleep`, line.beginWork());
      s.phase = 'sleeping';
      return;
    }
    if (s.shell === 'n') {
      this.holdEnd(s.id, line.beginWork()); // `npm run build`
      const w = { id: s.id * 10 + 2, parent: s.id, kind: 'shell', shell: 'wrapper', phase: 'starting', program: s.id * 10 + 1 };
      this.byId.set(w.id, w);
      this.spawn(w);
      // shellExecuteTracked: ended as the wrapper exits.
      this.holdEnd(`${w.id}:awaited`, this.processes.beginAwait(s.pid, w.pid));
      w.line = this.thread(w.pid);
      s.phase = 'awaiting';
      s.awaits = w.id;
      this.runProgram(w, w.line);
      return;
    }
    if (s.shell === 'g') {
      s.job = line.sibling(); // `node x &`
      this.runProgram(s, s.job);
      this.holdEnd(`${s.id}:sleep`, line.beginWork()); // `sleep 1`
      s.phase = 'sleeping';
      return;
    }
    if (s.shell === 'k' || s.shell === 'K') {
      // `node x | (sleep 1; kill x)`: two elements the line waits on.
      s.element = line.fork();
      s.killer = line.fork();
      this.runProgram(s, s.element);
      this.holdEnd(`${s.id}:sleep`, s.killer.beginWork());
      s.killPhase = 'sleeping';
      return;
    }
    this.runProgram(s, line);
  }

  /** A thread of `pid`'s control, its work counted on the process table. */
  thread(pid) {
    return new this.production.WorkThread(() => this.processes.beginWork(pid));
  }

  /** Shell `s` runs `node x` on `thread`: its command is work; exec spawns the program and records the await. */
  runProgram(s, thread) {
    this.holdEnd(s.id, thread.beginWork());
    const program = { id: s.program, parent: s.id, kind: 'queued', state: 'queued' };
    this.byId.set(program.id, program);
    this.spawn(program);
    this.processes.beginAwait(s.pid, program.pid); // FacetManager.exec: ended by the program's exit
    s.phase = 'awaiting';
    s.awaits = program.id;
    this.queue(program);
  }

  /** A queued child's wait for a worker: admitted, it holds one; refused, its spawn fails; killed, it never runs. */
  queue(p) {
    p.kill = new AbortController();
    beginLoaderFetchWhenFree(this.ctx, `run-${p.id}`, { process: { pid: p.pid }, signal: p.kill.signal }).then(
      (end) => {
        p.state = 'admitted';
        this.holds.set(p.id, [end]);
        // Admitted, it starts (the broker's onStarted, inside the admission).
        this.starting.push(p.id);
      },
      (error) => (p.kill.signal.aborted && error === p.kill.signal.reason ? undefined : this.refused(p)),
    );
  }

  refused(p) {
    const truth = this.truth();
    if (!truth.deadlocked) this.violations.push(`refused ${p.id} while a holder could still make progress`);
    else if (!truth.stuck.has(p.parent)) this.violations.push(`refused ${p.id}, whose parent ${p.parent} is not stuck`);
    p.state = 'refused';
  }

  // ── the ground truth ─────────────────────────────────────────────────────

  /** Who is truly stuck, and whether every worker is held by someone stuck while something waits. */
  truth() {
    const queued = new Set([...this.byId.values()].filter((p) => p.state === 'queued').map((p) => p.id));
    const waitsOn = new Map();
    for (const p of this.byId.values()) {
      if (p.exited) continue;
      if (p.kind === 'guest') {
        const g = this.guests.get(p.id);
        // Blocked, and every piece of news produced for it applied.
        if (p.state === 'blocked' && g.inflight.length === 0) waitsOn.set(p.id, this.children(p.id));
      } else if (p.kind === 'shell' && (p.phase === 'awaiting' || p.phase === 'waiting')) {
        // Awaiting its program (or its wrapper), or `wait`ing on its background
        // job; with a `kill` of it still to run, never stuck.
        if (p.killPhase === undefined || p.killPhase === 'done') waitsOn.set(p.id, [p.awaits]);
      }
    }
    const stuck = new Set([...waitsOn].filter(([, on]) => on.length > 0).map(([id]) => id));
    for (let changed = true; changed;) {
      changed = false;
      for (const id of stuck) {
        if (waitsOn.get(id).some((c) => !queued.has(c) && !stuck.has(c))) { stuck.delete(id); changed = true; }
      }
    }
    const owners = [...this.holds].filter(([, ends]) => ends.length > 0).map(([id]) => id);
    const deadlocked = queued.size > 0 && owners.length > 0 && owners.every((id) => stuck.has(id));
    return { stuck, deadlocked };
  }

  // ── moves ────────────────────────────────────────────────────────────────

  moves() {
    const moves = [];
    // The ledger's put-off decision, on a later turn than the change that asked for it.
    if (this.decisions.length > 0) moves.push(['decide']);
    for (const g of this.guests.values()) {
      const p = this.get(g.id);
      if (p.exited) continue;
      // A prompt guest moves only as its news comes (news).
      if (this.prompt(g.id)) continue;
      // Blocking on its children is the guest's own; ending touches the ledger.
      if (p.state === 'busy') moves.push(['finish', g.id, g.live.length > 0 ? 'block' : 'end']);
      // In the order sent: the guest sends each report after the last has
      // been answered (node-shims __nimbusBlockedChain).
      if (g.reports.length > 0) moves.push(['deliverReport', g.id]);
      for (const reply of g.inflight) {
        moves.push(['deliver', g.id, reply.id, 'wake']);
        // Ignored, or acted on: the same to a guest already running.
        if (reply.kind !== 'exit' && p.state === 'blocked') moves.push(['deliver', g.id, reply.id, 'ignore']);
      }
    }
    // A holder under a holder may print to it, once.
    for (const g of this.guests.values()) {
      const p = this.get(g.id);
      if (!p.exited && !p.outputDone && p.parent !== null && p.parent !== 1 && !this.get(p.parent).exited) moves.push(['output', g.id]);
    }
    for (const p of this.byId.values()) {
      if (p.exited) continue;
      if (p.kind === 'builtin') moves.push(['exit', p.id]);
      else if (p.kind === 'queued' && p.state === 'admitted') moves.push(['exit', p.id]);
      else if (p.kind === 'queued' && p.state === 'refused') moves.push(['fail', p.id]);
      else if (p.kind === 'shell' && p.phase === 'sleeping') moves.push(['sleepEnd', p.id]);
      else if (p.kind === 'shell' && p.phase === 'finishing') moves.push(['exit', p.id]);
      if (p.killPhase === 'sleeping') moves.push(['sleepEnd', p.id]);
      else if (p.killPhase === 'between') moves.push(['nextStep', p.id]);
      else if (p.killPhase === 'killing') moves.push(['kill', p.id]);
    }
    return moves;
  }

  /** News of `child` for its parent, if that is a guest holding a worker; numbered by the ledger as it is produced. */
  async news(childId, kind) {
    const parent = this.get(this.get(childId).parent);
    if (!parent || parent.kind !== 'guest' || parent.exited) return;
    const g = this.guests.get(parent.id);
    const id = `${childId}:${kind}`;
    g.inflight.push({ id, from: childId, kind, carried: [issueProcessNews(this.ctx, parent.pid)] });
    if (!this.prompt(parent.id)) return;
    // Prompt: delivered and acted on now, and its report taken now.
    await this.move(['deliver', parent.id, id, 'wake']);
    if (parent.state === 'busy') await this.move(['finish', parent.id]);
    this.sayAll();
    while (!parent.exited && g.reports.length > 0) await this.move(['deliverReport', parent.id]);
  }

  /** `p` has ended: the process table hears it (forgetting what it waited on), and whoever awaited it moves on. */
  async ended(p) {
    p.exited = true;
    this.processes.exit(p.pid, 0);
    const parent = this.get(p.parent);
    if (parent?.kind === 'shell' && parent.awaits === p.id) {
      // Its command ends with what it awaited (`node x` with x, `npm run` with its script).
      this.runEnds(parent.id);
      // g's background job ends with its one command, k's first element too.
      parent.job?.close();
      parent.element?.close();
      // g's background job may end while its `sleep` runs: `wait` will return at once.
      if (parent.phase === 'sleeping') parent.backgroundDone = true;
      // k's line ends once its other element has too.
      else if (parent.killPhase !== undefined && parent.killPhase !== 'done') parent.phase = 'running';
      else parent.phase = 'finishing';
    }
    await tick();
  }

  async releaseHolds(id) {
    for (const end of this.holds.get(id) ?? []) end();
    this.holds.set(id, []);
    await tick();
  }

  /**
   * Each guest says what it is, as the shim does at the next pass of its
   * event loop (__nimbusReportBlocked): the production tracker decides
   * whether it changed, and makes the report. The report waits in order to
   * be delivered.
   */
  sayAll() {
    for (const g of this.guests.values()) {
      const p = this.get(g.id);
      if (!p.exited) g.news.say(p.state === 'blocked');
    }
  }

  async play(move) {
    await this.move(move);
    while (this.starting.length > 0) await this.news(this.starting.shift(), 'start');
    this.sayAll();
  }

  async move([move, id, replyId, how]) {
    const p = this.get(id);
    const g = this.guests.get(id);
    switch (move) {
      case 'finish':
        if (g.live.length > 0) { p.state = 'blocked'; return; }
        p.state = 'done';
        await this.releaseHolds(id);
        await this.news(id, 'exit');
        return this.ended(p);
      case 'deliverReport': {
        setProcessBlocked(this.ctx, p.pid, g.reports.shift());
        return tick();
      }
      case 'deliver': {
        const [reply] = g.inflight.splice(g.inflight.findIndex((n) => n.id === replyId), 1);
        g.news.apply(reply.carried);
        if (reply.kind === 'exit') g.live = g.live.filter((c) => c !== reply.from);
        if (how === 'wake' && p.state !== 'done') p.state = 'busy';
        return;
      }
      case 'output':
        p.outputDone = true;
        return this.news(id, 'output');
      case 'decide':
        this.decisions.shift()();
        return tick();
      case 'sleepEnd':
        this.runEnds(`${id}:sleep`);
        if (p.shell === 'k') {
          // `kill` begins in the turn `sleep` ends in.
          this.holdEnd(`${id}:kill`, p.killer.beginWork());
          p.killPhase = 'killing';
        } else if (p.shell === 'K') p.killPhase = 'between';
        else if (p.shell === 'f') this.runProgram(p, p.line);
        else if (p.backgroundDone) p.phase = 'finishing';
        else {
          // g: `wait`, a builtin: the shell's work, awaiting its background job.
          this.holdEnd(id, p.line.beginWork());
          p.phase = 'waiting';
        }
        return tick();
      case 'nextStep':
        // K: `kill $(cat x.pid)` begins, a turn later.
        this.holdEnd(`${id}:kill`, p.killer.beginWork());
        p.killPhase = 'killing';
        return tick();
      case 'kill': {
        const x = this.get(p.program);
        if (!x.exited) {
          // Queued, its wait is abandoned (its launch's signal); running, it ends.
          if (x.state === 'queued') x.kill.abort();
          else if (x.state === 'admitted') await this.releaseHolds(x.id);
          x.state = 'killed';
          await this.ended(x);
        }
        this.runEnds(`${id}:kill`);
        p.killer.close();
        p.killPhase = 'done';
        if (p.phase === 'running') p.phase = 'finishing';
        return tick();
      }
      case 'fail':
        await this.news(id, 'exit');
        return this.ended(p);
      case 'exit':
        if (p.kind === 'queued') await this.releaseHolds(id);
        if (p.kind === 'shell') { this.runEnds(id); p.line.close(); this.runEnds(`${id}:awaited`); }
        await this.news(id, 'exit');
        return this.ended(p);
      default:
        throw new Error(`unknown move ${move}`);
    }
  }

  /** The guests as they stand: their trackers, and news in flight. */
  snapshot() {
    return [...this.guests.values()].map((g) => ({
      id: g.id, news: g.news.inspect(), inflight: g.inflight.map((r) => ({ kind: r.kind, carried: r.carried })),
    }));
  }

  /**
   * A canonical description of the state, the ledger's included. A guest's
   * news numbers and report numbers are shifted so its frontier is 0 and the
   * last report taken is 0: the protocol compares and steps them, never reads
   * them whole, so two states that differ only by that shift have the same
   * futures.
   */
  key() {
    const procs = [...this.byId.values()].map((p) => [p.id, p.state ?? p.phase, p.exited, p.outputDone ?? null, p.killPhase ?? null]);
    const stats = loaderLedgerStats(this.ctx);
    // An exited guest's leftovers (undelivered reports and replies) have no future.
    const guests = [...this.guests.values()].filter((g) => !this.get(g.id).exited).map((g) => {
      const tracker = g.news.inspect();
      const news = stats.news?.[this.get(g.id).pid];
      const base = tracker.frontier;
      const seq0 = news?.reportSeq ?? 0;
      return [g.id, [...g.live].sort(), {
        ahead: tracker.ahead.map((n) => n - base),
        seq: tracker.seq - seq0,
        said: tracker.said.startsWith('blocked@') ? Number(tracker.said.slice(8)) - base : tracker.said,
        reports: g.reports.map((r) => [r.blocked, r.frontier - base, r.seq - seq0]),
        inflight: g.inflight.map((r) => [r.from, r.kind, r.carried.map((n) => n - base)]).map(String).sort(),
        ledger: news ? [news.issued - base, news.blockedAt === null ? null : news.blockedAt - base] : null,
      }];
    });
    return JSON.stringify([procs, guests, stats.waiters, stats.holders, this.decisions.length]);
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
 * Every interleaving of `topology` with `production`'s pieces, up to
 * `maxStates` distinct states, up to the order of independent moves: the
 * violations found, each with the moves that led there. Each state is
 * reached by replaying its moves on a fresh ledger and process table.
 */
export async function explore(production, topology, { maxStates = 200_000, collect = 1, stop = () => false, focus = null } = {}) {
  // State → the moves already covered from it (its sleep set when explored).
  const asleep = new Map();
  const found = [];
  let states = 0;
  let finals = 0;
  const stack = [{ path: [], sleep: [] }];
  while (stack.length > 0 && found.length < collect) {
    const { path, sleep } = stack.pop();
    const run = new Run(production, topology, focus);
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
      const unfinished = [...run.byId.values()].filter((p) => !p.exited).map((p) => p.id);
      if (unfinished.length > 0 && !run.knownLimit) {
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

/**
 * Every multiset of up to `n` child kinds: a child queued for a worker (q),
 * a builtin running in the session (b), `sh -c 'node x'` (s).
 */
export function childSets(n, kinds = ['q', 'b', 's']) {
  const sets = [[]];
  for (let size = 1; size <= n; size++) {
    const grow = (from, acc) => {
      if (acc.length === size) { sets.push(acc); return; }
      for (let k = from; k < kinds.length; k++) grow(k, [...acc, kinds[k]]);
    };
    grow(0, []);
  }
  return sets;
}

/**
 * Explore every case (a family, or [family, focus]) under production;
 * fail on the first violation, with its path. Returns the states explored.
 */
export async function checkFamilies(cases, { maxStates = 500_000 } = {}) {
  let states = 0;
  const t0 = Date.now();
  for (const c of cases) {
    const [family, focus] = Array.isArray(c[0]) ? c : [c, null];
    const result = await explore(PRODUCTION, family, { focus, maxStates });
    states += result.states;
    if (result.found.length > 0) {
      const [f] = result.found;
      throw new Error(`${JSON.stringify(family)} (focus ${focus}): ${f.violation}\n  ${describe(f.path)}`);
    }
  }
  console.log(`  ${cases.length} families, ${states} states, ${Date.now() - t0} ms: no violation`);
  return states;
}

/** A run replayed along `path`, for diagnosis: its ledger, process table and model records. */
export async function replay(production, topology, path, { focus = null } = {}) {
  const run = new Run(production, topology, focus);
  await run.setup();
  for (const move of path) await run.play(move);
  return run;
}
