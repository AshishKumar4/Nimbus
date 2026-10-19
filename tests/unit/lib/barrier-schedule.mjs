/**
 * Barrier schedules: a process's filesystem engine (guest-engines.mjs),
 * its supervisor's replies delivered when a schedule says
 * (schedule-transport.mjs), while a peer changes what the session holds.
 *
 * A schedule is a list of steps:
 *   ['own', op, ...args]   the process's awaited call, left in flight;
 *   ['sync', op, ...args]  its call that cannot wait, answered at once;
 *   ['peer', op, ...args]  a change from outside the process, left in flight;
 *   ['input']              input arrives: the process's barrier, left in flight;
 *   ['hold', kind]         the next reply of `kind` waits (KINDS);
 *   ['release', kind?]     the oldest parked reply (of `kind`) is delivered;
 *   ['settle']             wait until nothing moves without a release;
 *   ['poison']             the next ACQUIRE is answered with a poison.
 * Reads are stat, readFile and readdir; changes write, unlink, mkdir, rmdir,
 * rename and chmod, of names under the process's project (UNIVERSE).
 *
 * What each answer may be is judged against a model of the session's
 * files: every state each name has had (a peer's change once it returned,
 * the process's once its call did), in order.
 *   - An awaited answer is a state its name had while the call was in
 *     flight, or the one a change in flight then leaves.
 *   - An answer that cannot wait is a state its name had no earlier than the
 *     last input whose barrier landed, or the process's own last change of
 *     it, whichever is later. A process listed on demand may refuse it
 *     (EAGAIN); one whose names are all listed may not, except for bytes it
 *     does not hold, or while a poison has stopped its namespace.
 *   - Once every reply is delivered, an awaited call still pending with
 *     nothing moving is a deadlock.
 *   - At the end, every reply delivered and a last barrier landed, each name
 *     answers as the session holds it, both ways, and the session holds what
 *     the model says (no write lost). Node's ledger of program misses holds
 *     exactly the files a call that cannot wait was refused the bytes of, no
 *     awaited read of which has answered since, that are still there.
 * Two changes whose names overlap are never in flight together, so each
 * change's effect is the model's at its start; one that would overlap waits
 * for the step after the other returns.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import { APP, bootEngine, stat as normalized } from './guest-engines.mjs';
import { scheduleTransport, KINDS } from './schedule-transport.mjs';
import { sleep } from './resident-body.mjs';
import { writeSync } from 'node:fs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The project a schedule starts from: '' is the project directory, a string a file's content, null a directory. */
export const SEED_TREE = Object.freeze({ d: null, 'd/e': null, x: null, 'd/f': 'f0', 'd/e/g': 'g0000', 'x/h': 'h00', top: 't0000000' });

/** The names a schedule reads and changes. */
export const UNIVERSE = Object.freeze({
  files: Object.freeze(['top', 'new', 'd/f', 'd/n', 'd/e/g', 'x/h', 'x/f', 'z/k']),
  dirs: Object.freeze(['d', 'd/e', 'x', 'z', 'x/e']),
});
const NAMES = [...UNIVERSE.dirs, ...UNIVERSE.files];
const FILE_MODES = [0o644, 0o600, 0o640];
const DIR_MODES = [0o755, 0o750, 0o700];
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const under = (rel, root) => rel === root || root === '' || rel.startsWith(`${root}/`);
const abs = (rel) => (rel === '' ? APP : `${APP}/${rel}`);
const key = (rel) => abs(rel).slice(1);

/** The model: each name's state; '' (the project directory) always a directory. */
function seedWorld() {
  const world = new Map([['', { type: 'dir', mode: DIR_MODE }]]);
  for (const [rel, content] of Object.entries(SEED_TREE)) {
    world.set(rel, content === null ? { type: 'dir', mode: DIR_MODE } : { type: 'file', content, mode: FILE_MODE });
  }
  return world;
}

const childrenOf = (world, dir) => [...world.keys()].filter((rel) => rel !== '' && parentOf(rel) === dir).map((rel) => rel.slice(dir === '' ? 0 : dir.length + 1)).sort();

/** The names a change touches: its own, and everything beneath them. */
function domainOf(step) {
  const [, op, a, b] = step;
  return op === 'rename' ? [a, b] : [a];
}
const overlaps = (x, y) => x.some((p) => y.some((q) => under(p, q) || under(q, p)));

/** `change` applied to `world`, or null when it would fail there (so a schedule never asks it). */
function applied(world, [, op, a, b]) {
  const at = world.get(a);
  const parent = world.get(parentOf(a));
  const next = new Map(world);
  switch (op) {
    case 'write':
      if (parent?.type !== 'dir' || at?.type === 'dir') return null;
      next.set(a, { type: 'file', content: b, mode: at?.mode ?? FILE_MODE });
      return next;
    case 'unlink':
      if (at?.type !== 'file') return null;
      next.delete(a);
      return next;
    case 'mkdir':
      if (parent?.type !== 'dir' || at !== undefined) return null;
      next.set(a, { type: 'dir', mode: DIR_MODE });
      return next;
    case 'rmdir':
      if (at?.type !== 'dir' || a === '' || childrenOf(world, a).length > 0) return null;
      next.delete(a);
      return next;
    case 'chmod':
      if (at === undefined) return null;
      next.set(a, { ...at, mode: b });
      return next;
    case 'rename': {
      const to = world.get(b);
      if (at === undefined || a === '' || a === b || under(b, a) || world.get(parentOf(b))?.type !== 'dir') return null;
      if (to !== undefined && (to.type !== at.type || (to.type === 'dir' && childrenOf(world, b).length > 0))) return null;
      for (const rel of world.keys()) if (under(rel, b)) next.delete(rel);
      for (const [rel, state] of world) {
        if (!under(rel, a)) continue;
        next.delete(rel);
        next.set(b + rel.slice(a.length), state);
      }
      return next;
    }
    default:
      throw new Error(`no change ${op}`);
  }
}

/** A deterministic stream for a seed (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A schedule of `steps` steps from `seed`, each change valid in the model as the steps before it leave it. */
export function generate(seed, steps = 40) {
  const random = prng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  let world = seedWorld();
  const schedule = [];
  let content = 0;
  const change = () => {
    for (let tries = 0; tries < 20; tries++) {
      const op = pick(['write', 'write', 'unlink', 'mkdir', 'rmdir', 'rename', 'rename', 'chmod']);
      const isFile = (rel) => world.get(rel)?.type === 'file';
      const candidate = op === 'write' ? [op, pick(UNIVERSE.files), `c${seed}.${++content}`]
        : op === 'unlink' ? [op, pick(UNIVERSE.files)]
          : op === 'mkdir' || op === 'rmdir' ? [op, pick(UNIVERSE.dirs)]
            : op === 'chmod' ? (() => { const rel = pick(NAMES); return [op, rel, pick(isFile(rel) ? FILE_MODES : DIR_MODES)]; })()
              : (() => { const from = pick(NAMES); return [op, from, pick(isFile(from) ? UNIVERSE.files : UNIVERSE.dirs)]; })();
      const next = applied(world, ['', ...candidate]);
      if (next !== null) { world = next; return candidate; }
    }
    return null;
  };
  while (schedule.length < steps) {
    const r = random();
    if (r < 0.22) schedule.push(['own', pick(['stat', 'stat', 'readFile', 'readdir']), pick(NAMES)]);
    else if (r < 0.40) schedule.push(['sync', pick(['stat', 'stat', 'readFile', 'readdir']), pick(NAMES)]);
    else if (r < 0.62) {
      const made = change();
      if (made !== null) schedule.push([pick(['own', 'own', 'peer', 'peer', 'sync']), ...made]);
    } else if (r < 0.72) schedule.push(['input']);
    else if (r < 0.86) schedule.push(random() < 0.5 ? ['release'] : ['release', pick(Object.values(KINDS))]);
    else if (r < 0.94) schedule.push(['hold', pick(Object.values(KINDS))]);
    else if (r < 0.985) schedule.push(['settle']);
    else schedule.push(['poison']);
  }
  return schedule;
}

/** A finding: the schedule, the step, and what was wrong there. */
class Finding extends Error {
  constructor(message, at) {
    super(`step ${at}: ${message}`);
    this.at = at;
  }
}

const describe = (state) => (state === undefined ? 'absent' : state.type === 'file' ? `file ${JSON.stringify(state.content)} ${state.mode.toString(8)}` : `dir ${state.mode.toString(8)}`);

/** Whether `answer` (of read `op`) is what `state` says. */
function answers(op, answer, state, world) {
  if (op === 'stat') {
    if (state === undefined) return answer === null;
    if (answer === null || answer.type !== (state.type === 'dir' ? 'directory' : 'file') || (answer.mode & 0o777) !== state.mode) return false;
    return state.type !== 'file' || answer.size === enc.encode(state.content).byteLength;
  }
  if (op === 'readFile') {
    if (state === undefined) return answer?.code === 'ENOENT';
    if (state.type === 'dir') return answer?.code === 'EISDIR';
    return typeof answer === 'string' && answer === state.content;
  }
  if (state === undefined) return answer?.code === 'ENOENT';
  if (state.type !== 'dir') return answer?.code === 'ENOTDIR';
  return Array.isArray(answer) && answer.join('/') === childrenOf(world, '').join('/');
}

/**
 * Run `schedule` on engine `kind` (bootEngine) with a seeded parking policy
 * (`parkSeed`, or none: only `hold` parks). Resolves when it holds; throws a
 * Finding naming the step where it does not.
 */
export async function runSchedule(kind, schedule, { parkSeed, deadlineMs = 40_000, trace = [] } = {}) {
  // Each line as it happens, on the test's own stderr: a child killed for a hang shows where it was.
  const note = (line) => { trace.push(line); writeSync(2, `  | ${line}\n`); };
  note(`boot ${kind}`);
  const lazy = kind === 'holder';
  const parkRandom = parkSeed === undefined ? null : prng(parkSeed);
  const transport = scheduleTransport({ park: parkRandom === null ? () => false : () => parkRandom() < 0.3 });
  const engine = await bootEngine(kind, {
    seed: (authority) => {
      for (const [rel, content] of Object.entries(SEED_TREE)) {
        if (content === null) authority.kfs.mkdir(key(rel), { mode: DIR_MODE });
        else authority.kfs.writeFile(key(rel), content);
      }
    },
    supervise: transport.supervise,
    stdin: kind === 'node',
  });
  const deadline = Date.now() + deadlineMs;

  // The model, and every state it has had: history[i] is the world after i changes returned.
  let world = seedWorld();
  const history = [world];
  const seq = () => history.length - 1;
  /** Changes in flight, and every change ever begun: { domain, post, begun, done }. */
  const changes = [];
  /** Calls in flight: settled when their promise does. */
  const inflight = new Set();
  let completions = 0;
  /** The latest input whose barrier landed, as the model stood when it arrived. */
  let landed = 0;
  /** Each name's own last change, as the model stood when it returned. */
  const ownAt = new Map();
  /** A poison asked and no input landed since: a namespace that is not answering may refuse. */
  let poisoned = false;
  const deferred = [];
  /** Files whose bytes a call that cannot wait was refused, and no awaited read answered since (Node's misses). */
  const missed = new Set();

  const statesOf = (rel, from, to) => {
    const states = [];
    for (let i = from; i <= to; i++) states.push(history[i].get(rel));
    for (const change of changes) {
      if (change.begun <= to && (change.done === null || change.done >= from) && change.domain.some((root) => under(rel, root))) states.push(change.post.get(rel));
    }
    return states;
  };
  const worldAt = (state, rel, i) => {
    // A listing's children, as the world `i` that `state` came from holds them.
    const view = new Map();
    for (const [name, value] of history[i]) if (under(name, rel)) view.set(rel === '' ? name : name.slice(rel.length + 1) || '', value);
    return view;
  };
  const judge = (at, way, op, rel, answer, from, to) => {
    if (answer?.code === 'EAGAIN' && way === 'sync' && (lazy || poisoned || op === 'readFile')) return;
    if (op === 'readdir') {
      for (let i = from; i <= to; i++) if (answers(op, answer, history[i].get(rel), worldAt(null, rel, i))) return;
      for (const change of changes) {
        if (change.begun <= to && (change.done === null || change.done >= from) && change.domain.some((root) => under(rel, root) || under(root, rel))) {
          const view = new Map();
          for (const [name, value] of change.post) if (under(name, rel)) view.set(rel === '' ? name : name.slice(rel.length + 1) || '', value);
          if (answers(op, answer, change.post.get(rel), view)) return;
        }
      }
    } else if (statesOf(rel, from, to).some((state) => answers(op, answer, state, null))) return;
    const shown = answer?.code ?? (answer && typeof answer === 'object' && !Array.isArray(answer) ? `${answer.type} ${(answer.mode & 0o777).toString(8)} size ${answer.size}` : JSON.stringify(answer));
    throw new Finding(`${way} ${op} ${rel || '.'} answered ${shown}; the session held ${statesOf(rel, from, to).map(describe).join(' | ') || 'nothing'} (states ${from}..${to})`, at);
  };

  const read = async (way, op, rel) => {
    const path = abs(rel);
    const call = way === 'sync' ? engine.sync : engine.fs;
    try {
      if (op === 'stat') return normalized(await (way === 'sync' ? engine.sync.stat(path) : engine.stat(path)));
      if (op === 'readFile') {
        const bytes = await call.readFile(path);
        return bytes === null ? { code: 'ENOENT' } : dec.decode(bytes);
      }
      return (await call.readdir(path)).map((entry) => entry.name).sort();
    } catch (error) {
      if (op === 'stat' && error?.code === 'ENOENT') return null;
      return { code: error?.code ?? String(error?.message ?? error) };
    }
  };

  /** The change as `way` makes it: a promise, but for a call that cannot wait, which answers or throws now. */
  const change = (way, [, op, a, b]) => {
    const fs = way === 'sync' ? engine.sync : way === 'peer' ? null : engine.fs;
    if (way === 'peer') {
      const peer = engine.authority.peer;
      if (op === 'write') return peer.writeFile(key(a), b);
      if (op === 'mkdir') return peer.mkdir(key(a), { mode: DIR_MODE });
      if (op === 'rename') return peer.rename(key(a), key(b));
      if (op === 'chmod') return peer.chmod(key(a), b);
      return peer[op](key(a));
    }
    if (op === 'write') return way === 'sync' ? fs.writeFile(abs(a), enc.encode(b)) : engine.write(abs(a), b);
    if (op === 'mkdir') return fs.mkdir(abs(a), { mode: DIR_MODE });
    if (op === 'rename') return fs.rename(abs(a), abs(b));
    if (op === 'chmod') return fs.chmod(abs(a), b);
    return fs[op](abs(a));
  };

  /** A change begun now, as the model stands: `null` when it cannot be asked yet (overlapping one in flight) or at all. */
  const begin = (at, way, step) => {
    const domain = domainOf(step);
    if (changes.some((other) => other.done === null && overlaps(other.domain, domain))) return 'wait';
    const post = applied(world, step);
    if (post === null) { note(`  (step ${at} skipped: ${JSON.stringify(step)} is not valid now)`); return null; }
    const record = { domain, post, begun: seq(), done: null, way, step };
    const finish = () => {
      // Its effect, on whatever else changed meanwhile (nothing it overlaps).
      const next = new Map(world);
      for (const rel of world.keys()) if (domain.some((root) => under(rel, root))) next.delete(rel);
      for (const [rel, state] of post) if (domain.some((root) => under(rel, root))) next.set(rel, state);
      world = next;
      history.push(world);
      record.done = seq();
      if (way !== 'peer') for (const root of domain) ownAt.set(root, seq());
    };
    changes.push(record);
    if (way === 'sync') {
      try {
        change(way, step);
      } catch (error) {
        changes.splice(changes.indexOf(record), 1);
        if (error?.code === 'EAGAIN' && (lazy || poisoned)) return null;
        throw new Finding(`sync ${step[1]} ${step.slice(2).join(' ')} failed: ${error?.code ?? error?.message ?? error}`, at);
      }
      finish();
      return null;
    }
    const work = Promise.resolve().then(() => change(way, step)).then(finish, (error) => {
      record.done = seq();
      record.failed = new Finding(`${way} ${step[1]} ${step.slice(2).join(' ')} failed: ${error?.code ?? error?.message ?? error}`, at);
    });
    return track(work);
  };

  const track = (work) => {
    const settled = work.finally(() => { inflight.delete(settled); completions++; });
    inflight.add(settled);
    return settled;
  };

  const progress = () => completions + transport.counts.asked + transport.counts.delivered + Object.values(engine.log.calls).reduce((n, c) => n + c, 0);
  /** Wait until nothing moves; a call pending with no reply parked and nothing moving is a deadlock. */
  const settle = async (at, quietMs = 120) => {
    let quietSince = Date.now();
    let seen = progress();
    while (inflight.size > 0) {
      if (Date.now() > deadline) throw new Finding(`the schedule ran past its wall budget with ${inflight.size} call(s) pending`, at);
      await sleep(5);
      if (progress() !== seen) { seen = progress(); quietSince = Date.now(); continue; }
      if (Date.now() - quietSince < quietMs) continue;
      if (transport.parked().length === 0) {
        await sleep(1_000);
        if (progress() === seen && inflight.size > 0) throw new Finding(`deadlock: ${inflight.size} call(s) pending, every reply delivered, nothing moving`, at);
        continue;
      }
      return;
    }
    for (const record of changes) if (record.failed) throw record.failed;
  };

  const step = async (at, s) => {
    const [what] = s;
    if (what === 'hold') return transport.hold(s[1]);
    if (what === 'release') { transport.release(s[1]); return sleep(0); }
    if (what === 'settle') return settle(at);
    if (what === 'poison') { transport.poison(); poisoned = true; return undefined; }
    if (what === 'input') {
      const arrived = seq();
      return void track(engine.input().then(() => { landed = Math.max(landed, arrived); poisoned = false; }));
    }
    const [way, op, rel] = s;
    if (op === 'stat' || op === 'readFile' || op === 'readdir') {
      if (way === 'sync') {
        const bound = Math.max(landed, ...[...ownAt].filter(([root]) => under(rel, root) || under(root, rel)).map(([, i]) => i));
        const answer = await read(way, op, rel);
        if (op === 'readFile' && answer?.code === 'EAGAIN') missed.add(rel);
        return judge(at, way, op, rel, answer, bound, seq());
      }
      const from = seq();
      return void track(read(way, op, rel).then((answer) => {
        judge(at, way, op, rel, answer, from, seq());
        if (op === 'readFile' && typeof answer === 'string') missed.delete(rel);
      }).catch((error) => { readFailures.push(error); }));
    }
    const begun = begin(at, way, s);
    if (begun === 'wait') deferred.push([at, s]);
    return undefined;
  };
  const readFailures = [];

  try {
    for (let at = 0; at < schedule.length; at++) {
      note(`${at}: ${JSON.stringify(schedule[at])}`);
      for (let i = 0; i < deferred.length;) {
        const [was, s] = deferred[i];
        if (begin(was, s[0], s) === 'wait') i++;
        else deferred.splice(i, 1);
      }
      await step(at, schedule[at]);
      await sleep(1);
      if (readFailures.length > 0) throw readFailures[0];
    }
    // Quiescence: every reply delivered, every call returned, the deferred asked, a last barrier landed.
    const end = schedule.length;
    note('at rest: every reply delivered');
    transport.drain();
    await settle(end);
    while (deferred.length > 0) {
      const [was, s] = deferred.shift();
      if (begin(was, s[0], s) === 'wait') deferred.push([was, s]);
      await settle(end);
    }
    if (readFailures.length > 0) throw readFailures[0];
    const arrived = seq();
    note('at rest: a last input');
    track(engine.input());
    await settle(end);
    landed = arrived;
    note('at rest: every name, both ways');
    if (kind === 'node') {
      await globalThis.__nimbusVfsResidencySettle?.();
      const ledger = [...(globalThis.__nimbusVfsResidencyMisses ?? [])].sort();
      const owed = [...missed].filter((rel) => world.get(rel)?.type === 'file').map(key).sort();
      if (ledger.join() !== owed.join()) throw new Finding(`at rest, the program's misses are [${ledger}]; unanswered are [${owed}]`, end);
    }
    for (const rel of ['', ...NAMES]) {
      const state = world.get(rel);
      for (const way of ['own', 'sync']) {
        for (const op of ['stat', state?.type === 'dir' ? 'readdir' : 'readFile']) {
          const answer = await read(way, op, rel);
          if (answer?.code === 'EAGAIN' && way === 'sync' && (lazy || op === 'readFile')) continue;
          if (op === 'readdir' ? !answers(op, answer, state, worldAt(null, rel, seq())) : !answers(op, answer, state, null)) {
            throw new Finding(`at rest, ${way} ${op} ${rel || '.'} answered ${JSON.stringify(answer)}; the session holds ${describe(state)}`, end);
          }
        }
      }
      // What the session holds is what the model says: nothing the process wrote was lost.
      const held = normalized(await engine.peerStat(abs(rel), { followSymlinks: false }).catch(() => null));
      if (!answers('stat', held, state, null)) throw new Finding(`at rest, the session holds ${JSON.stringify(held)} at ${rel || '.'}; the model says ${describe(state)}`, end);
    }
  } finally {
    transport.drain();
  }
}
