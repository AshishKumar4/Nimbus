/**
 * Barrier schedules: a process's filesystem engine (guest-engines.mjs),
 * its supervisor's replies delivered when a schedule says
 * (schedule-transport.mjs), while a peer changes what the session holds.
 *
 * A schedule is a list of steps:
 *   ['own', op, ...args]   the process's awaited call, left in flight;
 *   ['sync', op, ...args]  its call that cannot wait, answered at once;
 *   ['peer', op, ...args]  a change from outside the process, left in flight;
 *   ['root', op, ...args]  the same, as root (chown and chmod: a directory
 *                          the process may no longer search, or now may);
 *   ['input']              input arrives: the process's barrier, left in flight;
 *   ['hold', kind, skip?]  the next reply of `kind` (after `skip` more) waits (KINDS);
 *   ['release', kind?]     the oldest parked reply (of `kind`) is delivered;
 *   ['settle']             wait until nothing moves without a release;
 *   ['poison']             the next ACQUIRE is answered with a poison.
 * Reads are stat, readFile and readdir; changes write, unlink, mkdir, rmdir,
 * rename, chmod and (root) chown, of names under the process's project
 * (UNIVERSE), judged with the process's credential: a name beneath a
 * directory it may not search is EACCES to it, as is a directory it may not
 * read listed or a file it may not read read.
 *
 * What each answer may be is judged against a model of the session's
 * files: every state each name has had (a peer's change once it returned,
 * the process's once its call did), in order.
 *   - An answer is a state its name had no earlier than the last input
 *     whose barrier landed, or the process's own last change of it,
 *     whichever is later, and no later than the answer; or one a change in
 *     flight then leaves. Node's awaited read takes its own barrier: its
 *     answer is no earlier than the call. A process listed on demand may
 *     refuse a call that cannot wait (EAGAIN); one whose names are all
 *     listed may not, except for bytes it does not hold, while a listing is
 *     in flight, or while a poison has stopped its namespace.
 *   - Once every reply is delivered, an awaited call still pending with
 *     nothing moving is a deadlock.
 *   - At the end, every reply delivered and a last barrier landed, each name
 *     answers as the session holds it, both ways, and the session holds what
 *     the model says (no write lost). Node's ledger of program misses holds
 *     exactly the files a call that cannot wait was refused the bytes of, no
 *     awaited read of which has answered since, that are still there.
 * What the store keeps against its budget is not judged here: neither
 * engine shows the store's own total, and its accounting is the budget's
 * own tests' (resident-fs-model).
 *
 * Two changes whose names overlap are never in flight together, so each
 * change's effect is the model's at its start; one that would overlap waits
 * for the step after the other returns. The process's own changes reach the
 * session when something leaves the process (publish): a peer's change of
 * names the process changed since waits for that first. The process never
 * decides a change of names a peer changed since its last input landed: it
 * cannot know of them, and the session may refuse what it decides.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import { APP, bootEngine, stat as normalized } from './guest-engines.mjs';
import { scheduleTransport, KINDS } from './schedule-transport.mjs';
import { sleep } from './resident-body.mjs';
import { writeSync } from 'node:fs';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The project a schedule starts from: '' is the project directory, a string a file's content, null a directory. */
export const SEED_TREE = Object.freeze({ d: null, 'd/e': null, x: null, 'd/f': 'f0', 'd/e/g': 'g0000', 'x/h': 'h00', top: 't0000000' });

/** The names a schedule reads and changes. */
export const UNIVERSE = Object.freeze({
  files: Object.freeze(['top', 'new', 'd/f', 'd/n', 'd/e/g', 'x/h', 'x/f', 'z/k', 'x/e/g', 'z/g']),
  dirs: Object.freeze(['d', 'd/e', 'x', 'z', 'x/e']),
});
const NAMES = [...UNIVERSE.dirs, ...UNIVERSE.files];
const FILE_MODES = [0o644, 0o600, 0o640];
const DIR_MODES = [0o755, 0o750, 0o700];
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
/** The process's user and group, and the session user's: what owns everything not root's. */
const USER = 1000;

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const under = (rel, root) => rel === root || root === '' || rel.startsWith(`${root}/`);
const abs = (rel) => (rel === '' ? APP : `${APP}/${rel}`);
const key = (rel) => abs(rel).slice(1);

const dirState = (mode = DIR_MODE) => ({ type: 'dir', mode, uid: USER, gid: USER });
const fileState = (content, mode = FILE_MODE) => ({ type: 'file', content, mode, uid: USER, gid: USER });

/** The model: each name's state; '' (the project directory) always a directory. */
function seedWorld() {
  const world = new Map([['', dirState()]]);
  for (const [rel, content] of Object.entries(SEED_TREE)) world.set(rel, content === null ? dirState() : fileState(content));
  return world;
}

/** The permission bits `state` gives the process. */
const bits = (state) => (state.mode >> (state.uid === USER ? 6 : state.gid === USER ? 3 : 0)) & 7;

/** Why the process cannot reach `rel` (a directory above it missing, not one, or not searchable to it), or null. */
function unreachable(world, rel) {
  if (rel === '') return null;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const at = world.get(parts.slice(0, i).join('/'));
    if (at === undefined) return 'ENOENT';
    if (at.type !== 'dir') return 'ENOTDIR';
    if ((bits(at) & 1) === 0) return 'EACCES';
  }
  return null;
}

/** Whether the process may make or remove a name in `dir`'s directory: it reaches it, and may write and search it. */
const mayChangeIn = (world, rel) => unreachable(world, rel) === null && world.get(parentOf(rel))?.type === 'dir' && (bits(world.get(parentOf(rel))) & 3) === 3;

const childrenOf = (world, dir) => [...world.keys()].filter((rel) => rel !== '' && parentOf(rel) === dir).map((rel) => rel.slice(dir === '' ? 0 : dir.length + 1)).sort();

/** The names a change touches: its own, and everything beneath them. */
function domainOf(step) {
  const [, op, a, b] = step;
  return op === 'rename' ? [a, b] : [a];
}
const overlaps = (x, y) => x.some((p) => y.some((q) => under(p, q) || under(q, p)));
/** Whether a change is made outside the process (a peer's, or root's). */
const outside = (way) => way === 'peer' || way === 'root';

/** `change` applied to `world` (by `way`: root is not judged), or null when it would fail there (so a schedule never asks it). */
function applied(world, [way, op, a, b]) {
  const root = way === 'root';
  const at = world.get(a);
  const parent = world.get(parentOf(a));
  const next = new Map(world);
  if (!root && unreachable(world, a) !== null) return null;
  switch (op) {
    case 'write':
      if (parent?.type !== 'dir' || at?.type === 'dir') return null;
      if (!root && (at === undefined ? !mayChangeIn(world, a) : (bits(at) & 2) === 0)) return null;
      next.set(a, at === undefined ? fileState(b) : { ...at, content: b });
      return next;
    case 'unlink':
      if (at?.type !== 'file' || (!root && !mayChangeIn(world, a))) return null;
      next.delete(a);
      return next;
    case 'mkdir':
      if (parent?.type !== 'dir' || at !== undefined || (!root && !mayChangeIn(world, a))) return null;
      next.set(a, dirState());
      return next;
    case 'rmdir':
      if (at?.type !== 'dir' || a === '' || childrenOf(world, a).length > 0 || (!root && !mayChangeIn(world, a))) return null;
      next.delete(a);
      return next;
    case 'chmod':
      if (at === undefined || a === '' || (!root && at.uid !== USER)) return null;
      next.set(a, { ...at, mode: b });
      return next;
    case 'chown':
      if (at === undefined || a === '' || !root) return null;
      next.set(a, { ...at, uid: b, gid: b });
      return next;
    case 'rename': {
      const to = world.get(b);
      if (at === undefined || a === '' || a === b || under(b, a) || world.get(parentOf(b))?.type !== 'dir') return null;
      if (!root && (!mayChangeIn(world, a) || !mayChangeIn(world, b))) return null;
      // A directory moved to another parent has its '..' rewritten: the process must be able to write it.
      if (!root && at.type === 'dir' && parentOf(a) !== parentOf(b) && (bits(at) & 2) === 0) return null;
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
  const change = (way) => {
    for (let tries = 0; tries < 20; tries++) {
      if (way === 'root') {
        const dir = pick(UNIVERSE.dirs);
        const candidate = random() < 0.5 ? ['chown', dir, pick([0, USER])] : ['chmod', dir, pick([0o700, 0o711, 0o750, 0o755])];
        const next = applied(world, ['root', ...candidate]);
        if (next !== null) { world = next; return candidate; }
        continue;
      }
      const op = pick(['write', 'write', 'unlink', 'mkdir', 'rmdir', 'rename', 'rename', 'chmod']);
      const isFile = (rel) => world.get(rel)?.type === 'file';
      const candidate = op === 'write' ? [op, pick(UNIVERSE.files), `c${seed}.${++content}`]
        : op === 'unlink' ? [op, pick(UNIVERSE.files)]
          : op === 'mkdir' || op === 'rmdir' ? [op, pick(UNIVERSE.dirs)]
            : op === 'chmod' ? (() => { const rel = pick(NAMES); return [op, rel, pick(isFile(rel) ? FILE_MODES : DIR_MODES)]; })()
              : (() => { const from = pick(NAMES); return [op, from, pick(isFile(from) ? UNIVERSE.files : UNIVERSE.dirs)]; })();
      const next = applied(world, [way, ...candidate]);
      if (next !== null) { world = next; return candidate; }
    }
    return null;
  };
  while (schedule.length < steps) {
    const r = random();
    if (r < 0.22) schedule.push(['own', pick(['stat', 'stat', 'readFile', 'readdir']), pick(NAMES)]);
    else if (r < 0.40) schedule.push(['sync', pick(['stat', 'stat', 'readFile', 'readdir']), pick(NAMES)]);
    else if (r < 0.62) {
      const way = pick(['own', 'own', 'peer', 'peer', 'sync', 'root']);
      const made = change(way);
      if (made !== null) schedule.push([way, ...made]);
    } else if (r < 0.72) schedule.push(['input']);
    else if (r < 0.86) schedule.push(random() < 0.5 ? ['release'] : ['release', pick(Object.values(KINDS))]);
    else if (r < 0.94) schedule.push(['hold', pick(Object.values(KINDS))]);
    else if (r < 0.985) schedule.push(['settle']);
    else schedule.push(['poison']);
  }
  return schedule;
}

/**
 * What an engine is known to answer wrong, each kept red by its scenario in
 * barrier-schedules.mjs (listed there as a gap), and let pass here so a
 * drawn schedule finds something new. A gap closed is removed from both.
 *   - unshownAwaitedChange: an awaited change outside a grant is not shown
 *     to a call that cannot wait until a barrier lands (O9);
 *   - refusedAsDirectory: a call that cannot wait, on a directory the view
 *     cannot answer it for, is refused EISDIR, whatever it asked;
 *   - absentWhileRelisted: a directory being relisted answers a name under
 *     it as absent (B2).
 */
export const KNOWN_GAPS = Object.freeze({
  node: Object.freeze({ absentWhileRelisted: true }),
  holder: Object.freeze({ unshownAwaitedChange: true, refusedAsDirectory: true }),
});

/** A finding: the schedule, the step, and what was wrong there. */
class Finding extends Error {
  constructor(message, at) {
    super(`step ${at}: ${message}`);
    this.at = at;
  }
}

const describe = (state) => (state === undefined ? 'absent'
  : `${state.type === 'file' ? `file ${JSON.stringify(state.content)}` : 'dir'} ${state.mode.toString(8)}${state.uid === USER ? '' : ` uid ${state.uid}`}`);

/** `world` with `effect` (a world a change leaves) laid over the names under `domain`. */
function laid(world, domain, effect) {
  const next = new Map(world);
  for (const rel of world.keys()) if (domain.some((root) => under(rel, root))) next.delete(rel);
  for (const [rel, state] of effect) if (domain.some((root) => under(rel, root))) next.set(rel, state);
  return next;
}

/** Whether a stat (normalized; null for nothing) describes `state`. */
function statIs(answer, state) {
  if (state === undefined) return answer === null;
  if (answer === null || answer.type !== (state.type === 'dir' ? 'directory' : 'file') || (answer.mode & 0o777) !== state.mode || answer.uid !== state.uid) return false;
  return state.type !== 'file' || answer.size === enc.encode(state.content).byteLength;
}

/** Whether `answer` (of read `op` of `rel`) is what `world` says to the process. */
function answers(op, rel, answer, world) {
  const blocked = unreachable(world, rel);
  if (blocked !== null) return op === 'stat' && blocked === 'ENOENT' ? answer === null : answer?.code === blocked;
  const state = world.get(rel);
  if (state !== undefined && op !== 'stat' && (bits(state) & 4) === 0) return answer?.code === 'EACCES';
  if (op === 'stat') return statIs(answer, state);
  if (op === 'readFile') {
    if (state === undefined) return answer?.code === 'ENOENT';
    if (state.type === 'dir') return answer?.code === 'EISDIR';
    return typeof answer === 'string' && answer === state.content;
  }
  if (state === undefined) return answer?.code === 'ENOENT';
  if (state.type !== 'dir') return answer?.code === 'ENOTDIR';
  return Array.isArray(answer) && answer.join('/') === childrenOf(world, rel).join('/');
}

/**
 * Run `schedule` on engine `kind` (bootEngine) with a seeded parking policy
 * (`parkSeed`, or none: only `hold` parks), letting pass what `knownGaps`
 * (KNOWN_GAPS[kind]) names. Resolves when it holds; throws a Finding naming
 * the step where it does not.
 */
export async function runSchedule(kind, schedule, { parkSeed, knownGaps = {}, deadlineMs = 40_000, trace = [] } = {}) {
  // Each line as it happens, on the test's own stderr: a child killed for a hang shows where it was.
  const note = (line) => { trace.push(line); writeSync(2, `  | ${line}\n`); };
  note(`boot ${kind}`);
  const lazy = kind === 'holder';
  const gaps = knownGaps;
  // Replies park at random once the process is up: its boot waits on replies no step releases.
  const parkRandom = parkSeed === undefined ? null : prng(parkSeed);
  let booted = false;
  const transport = scheduleTransport({ park: () => booted && parkRandom !== null && parkRandom() < 0.3, note: (line) => { if (booted) note(line); } });
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
  booted = true;
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
  /** The names of the process's changes that returned and have not been published since. */
  let unpublished = [];
  /** Each peer change that returned, and as the model stood then: what the process may not know of before its next input lands. */
  const peerAt = [];

  /**
   * Every world `rel` may have been seen in between states `from` and `to`:
   * each recorded one, with any of the changes in flight then that touch
   * `rel` laid over it, each as it ends or (a write) as it begins. Changes
   * in flight together never overlap, so any of them may have landed first.
   */
  const worldsSeen = (rel, from, to) => {
    const flying = changes.filter((change) => change.begun <= to && (change.done === null || change.done >= from)
      && change.domain.some((root) => under(rel, root) || under(root, rel)));
    let worlds = history.slice(from, to + 1);
    for (const change of flying.slice(0, 4)) {
      const effects = change.partial === null ? [change.post] : [change.post, change.partial];
      worlds = worlds.flatMap((world) => [world, ...effects.map((effect) => laid(world, change.domain, effect))]);
    }
    return worlds;
  };
  const judge = (at, way, op, rel, answer, from, to) => {
    // A namespace relisting a directory answers what is under it as unknown until the listing lands.
    if (answer?.code === 'EAGAIN' && way === 'sync' && (lazy || poisoned || op === 'readFile' || transport.inFlight('listing') > 0)) return;
    if (gaps.refusedAsDirectory && way === 'sync' && answer?.code === 'EISDIR' && worldsSeen(rel, from, to).some((world) => world.get(rel)?.type === 'dir')) return;
    if (gaps.absentWhileRelisted && way === 'sync' && answer === null && transport.inFlight('listing') > 0) return;
    const worlds = worldsSeen(rel, from, to);
    if (worlds.some((world) => answers(op, rel, answer, world))) return;
    const shown = answer?.code ?? (answer && typeof answer === 'object' && !Array.isArray(answer) ? `${answer.type} ${(answer.mode & 0o777).toString(8)} size ${answer.size}` : JSON.stringify(answer));
    const held = [...new Set(worlds.map((world) => (op === 'readdir' && world.get(rel)?.type === 'dir' ? `[${childrenOf(world, rel)}]` : describe(world.get(rel)))))];
    throw new Finding(`${way} ${op} ${rel || '.'} answered ${shown}; the session held ${held.join(' | ')} (states ${from}..${to})`, at);
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
    const fs = way === 'sync' ? engine.sync : engine.fs;
    if (outside(way)) {
      const peer = way === 'root' ? engine.authority.peerAs(CRED_KERNEL) : engine.authority.peer;
      if (op === 'chown') return peer.chown(key(a), b, b);
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
    if (!outside(way) && peerAt.some(({ done, domain: theirs }) => done > landed && overlaps(theirs, [...domain, ...domain.map(parentOf)]))) {
      note(`  (step ${at} skipped: a peer changed its names since the process's last input)`);
      return null;
    }
    const publishes = outside(way) && overlaps(unpublished, domain) ? unpublished : null;
    // A write the process makes is an open that truncates, then the bytes: while it is in flight, the file may be empty.
    const partial = way === 'own' && step[1] === 'write' ? new Map([...post, [step[2], { ...post.get(step[2]), content: '' }]]) : null;
    const record = { domain, post, partial, begun: seq(), done: null, way, step };
    const finish = () => {
      // Its effect, on whatever else changed meanwhile (nothing it overlaps).
      world = laid(world, domain, post);
      history.push(world);
      record.done = seq();
      if (outside(way)) peerAt.push({ done: seq(), domain });
      else {
        if (way === 'sync' || !gaps.unshownAwaitedChange) for (const root of domain) ownAt.set(root, seq());
        unpublished = [...unpublished, ...domain];
      }
    };
    changes.push(record);
    if (way === 'sync') {
      try {
        change(way, step);
      } catch (error) {
        changes.splice(changes.indexOf(record), 1);
        if (error?.code === 'EAGAIN' && (lazy || poisoned)) return null;
        if (error?.code === 'EISDIR' && gaps.refusedAsDirectory && domain.some((rel) => world.get(rel)?.type === 'dir')) return null;
        throw new Finding(`sync ${step[1]} ${step.slice(2).join(' ')} failed: ${error?.code ?? error?.message ?? error}`, at);
      }
      finish();
      return null;
    }
    const published = publishes === null ? Promise.resolve() : engine.publish().then(() => { unpublished = unpublished.filter((root) => !publishes.includes(root)); });
    const work = published.then(() => change(way, step)).then(finish, (error) => {
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
    if (what === 'hold') return transport.hold(s[1], s[2]);
    if (what === 'release') { transport.release(s[1]); return sleep(0); }
    if (what === 'settle') return settle(at);
    if (what === 'poison') { transport.poison(); poisoned = true; return undefined; }
    if (what === 'input') {
      const arrived = seq();
      return void track(engine.input().then(() => { landed = Math.max(landed, arrived); poisoned = false; }));
    }
    const [way, op, rel] = s;
    if (op === 'stat' || op === 'readFile' || op === 'readdir') {
      const bound = Math.max(landed, ...[...ownAt].filter(([root]) => under(rel, root) || under(root, rel)).map(([, i]) => i));
      if (way === 'sync') {
        const answer = await read(way, op, rel);
        if (op === 'readFile' && answer?.code === 'EAGAIN') missed.add(rel);
        return judge(at, way, op, rel, answer, bound, seq());
      }
      const from = kind === 'node' ? seq() : bound;
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
    note('at rest: what the process wrote published, and a last input');
    track(engine.publish().then(() => engine.input()));
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
          if (answer?.code === 'EISDIR' && way === 'sync' && gaps.refusedAsDirectory && state?.type === 'dir') continue;
          if (!answers(op, rel, answer, world)) {
            throw new Finding(`at rest, ${way} ${op} ${rel || '.'} answered ${JSON.stringify(answer)}; the model holds ${describe(state)}`, end);
          }
        }
      }
      // What the session holds is what the model says, as root sees it: nothing the process wrote was lost.
      const held = normalized(await engine.authority.peerAs(CRED_KERNEL).lstat(key(rel)).catch(() => null));
      if (!statIs(held, state)) throw new Finding(`at rest, the session holds ${JSON.stringify(held)} at ${rel || '.'}; the model says ${describe(state)}`, end);
    }
  } finally {
    transport.drain();
  }
}
