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
 *   ['stall'], ['unstall'] the process's waves wait before they reach the
 *                          session (a parked reply has reached it), or go on;
 *   ['settle']             wait until nothing moves without a release;
 *   ['poison']             the next ACQUIRE is answered with a poison;
 *   ['restart']            the session's database starts a new incarnation
 *                          (SqliteVFS rotateIncarnation): every cursor held
 *                          against the last one poisons; its files, their
 *                          revisions and the process's descriptors stay.
 * A restart is only what the platform produces: one database's revisions
 * never go back (vfs_state.gen is durable, and an answer is held until the
 * write it names commits), so a new epoch never names a revision of the last
 * one's with other bytes. A world where it would (a new database under a
 * store that outlived it) is not drawn: the store keeps its invariants for
 * it (pages keyed by epoch, a fill's own chunk rows) at no cost.
 * Reads are stat, readFile, readdir, (awaited) opendir, a directory read
 * through its descriptor, and (awaited) pread, a file's bytes at an offset
 * read through its descriptor; a file past what a process holds whole
 * (BULK: 'big') is paged that way, one past a fill's batch ('mid') fetched
 * in more than one. Changes write, unlink, mkdir, rmdir,
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
 *     answer is no earlier than the call. Node decides a structural change
 *     (rename, unlink, mkdir, rmdir, chmod) when it is called, awaited or
 *     not: its call that cannot wait shows every one it has begun. A process listed on demand may
 *     refuse a call that cannot wait (EAGAIN); one whose names are all
 *     listed may not, except for bytes it does not hold, while a listing is
 *     in flight, or while a poison has stopped its namespace.
 *   - Once every reply is delivered, an awaited call still pending with
 *     nothing moving is a deadlock.
 *   - At the end, every reply delivered and a last barrier landed, each name
 *     answers as the session holds it, both ways, and the session holds what
 *     the model says (no write lost). Node's ledger of program misses holds
 *     exactly the files a call that cannot wait was refused the bytes of, no
 *     awaited read of which has answered since, that are still there and
 *     the process may still read.
 * What the store keeps against its budget is not judged here: neither
 * engine shows the store's own total, and its accounting is the budget's
 * own tests' (resident-fs-model).
 *
 * A change from outside the process is never in flight with one whose names
 * it overlaps: it waits for the step after the other returns, so its effect
 * is the model's at its start. Node's own changes are in flight together
 * in program order (it decides each when it is called): each is the model's
 * as its earlier ones leave it, and lands after every earlier one it
 * overlaps. A WASI guest makes one call at a time: its own overlapping
 * changes wait for each other, as a peer's do. The process's own changes reach the
 * session when something leaves the process (publish): a peer's change of
 * names the process changed since waits for that first. The process never
 * decides a change of names a peer changed since its last input landed: it
 * cannot know of them, and the session may refuse what it decides.
 *
 * The drawn schedules once missed a class a review found: every pair of
 * overlapping changes ran one after the other, and nothing held a wave
 * before it reached the session, so a chain of Node's own renames whose
 * first landed alone could not arise. Node's own changes now fly together in
 * program order, and ['stall'] holds its waves; barrier-oracle.mjs holds the
 * model itself to refusing every answer no world gave.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import { APP, bootEngine, stat as normalized } from './guest-engines.mjs';
import { scheduleTransport, KINDS } from './schedule-transport.mjs';
import { sleep } from './resident-body.mjs';
import { writeSync } from 'node:fs';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { FS_READ_BATCH_REQUEST_BYTES, WASI_RESIDENT_FILE_CAP_BYTES } from '../../../packages/core/src/constants.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The project a schedule starts from: '' is the project directory, a string a file's content, null a directory. */
export const SEED_TREE = Object.freeze({ d: null, 'd/e': null, x: null, 'd/f': 'f0', 'd/e/g': 'g0000', 'x/h': 'h00', top: 't0000000' });

/** Files a schedule that names them starts with too, of their sizes: one fetched in two batches, one paged. */
const BULK = Object.freeze({ mid: FS_READ_BATCH_REQUEST_BYTES + 1_000_000, big: WASI_RESIDENT_FILE_CAP_BYTES + 1_000_000 });
/** What a pread reads, and where. */
const PREAD_BYTES = 4096;
const PREAD_AT = Object.freeze([0, 70_000, 4_200_000, 8_400_000]);
/** A file of `size` printable bytes, `tag` its pattern. */
const bulk = (tag, size) => `${tag}:0123456789abcdefghijklmnopqrstuvwxyz `.repeat(Math.ceil(size / (tag.length + 38))).slice(0, size);
/** The project `schedule` starts from: SEED_TREE, and the BULK files it names. */
export function seedTreeFor(schedule) {
  const named = new Set(schedule.flat().filter((part) => typeof part === 'string'));
  return { ...SEED_TREE, ...Object.fromEntries(Object.entries(BULK).filter(([rel]) => named.has(rel)).map(([rel, size]) => [rel, bulk(rel, size)])) };
}

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
/** The changes a process decides when it calls them (node-shims' structural calls, and chmod). */
const DECIDED = Object.freeze(['rename', 'unlink', 'mkdir', 'rmdir', 'chmod']);
/** The process's user and group, and the session user's: what owns everything not root's. */
const USER = 1000;

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const under = (rel, root) => rel === root || root === '' || rel.startsWith(`${root}/`);
const abs = (rel) => (rel === '' ? APP : `${APP}/${rel}`);
const key = (rel) => abs(rel).slice(1);

/** Each file and directory made has an identity of its own, which a rename moves and a write or chmod keeps: what a descriptor follows. */
let identities = 0;
const dirState = (mode = DIR_MODE) => ({ type: 'dir', mode, uid: USER, gid: USER, id: ++identities });
const fileState = (content, mode = FILE_MODE) => ({ type: 'file', content, size: content.length, mode, uid: USER, gid: USER, id: ++identities });

/** The model: each name's state; '' (the project directory) always a directory. */
function seedWorld(tree = SEED_TREE) {
  const world = new Map([['', dirState()]]);
  for (const [rel, content] of Object.entries(tree)) world.set(rel, content === null ? dirState() : fileState(content));
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

/**
 * `change` applied to `world` (by `way`: root is not judged), or null when it would fail there (so a schedule never asks it).
 * @param {Map<string, any>} world
 * @param {any[]} change
 */
function applied(world, change) {
  const [way, op, a, b] = change;
  const root = way === 'root';
  const at = world.get(a);
  const parent = world.get(parentOf(a));
  const next = new Map(world);
  if (!root && unreachable(world, a) !== null) return null;
  switch (op) {
    case 'write':
      if (parent?.type !== 'dir' || at?.type === 'dir') return null;
      if (!root && (at === undefined ? !mayChangeIn(world, a) : (bits(at) & 2) === 0)) return null;
      next.set(a, at === undefined ? fileState(b) : { ...at, content: b, size: b.length });
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
  const bulkRead = () => (random() < 0.5 ? ['own', 'pread', pick(Object.keys(BULK)), pick(PREAD_AT)] : [pick(['own', 'sync']), 'readFile', 'mid']);
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
    if (r < 0.03) schedule.push(bulkRead());
    else if (r < 0.22) schedule.push(['own', pick(['stat', 'stat', 'readFile', 'readdir', 'opendir']), pick(NAMES)]);
    else if (r < 0.40) schedule.push(['sync', pick(['stat', 'stat', 'readFile', 'readdir']), pick(NAMES)]);
    else if (r < 0.62) {
      const way = pick(['own', 'own', 'peer', 'peer', 'sync', 'root']);
      const made = change(way);
      if (made !== null) schedule.push([way, ...made]);
    } else if (r < 0.72) schedule.push(['input']);
    else if (r < 0.86) schedule.push(random() < 0.5 ? ['release'] : ['release', pick(Object.values(KINDS))]);
    else if (r < 0.91) schedule.push(['hold', pick(Object.values(KINDS))]);
    else if (r < 0.94) schedule.push([random() < 0.5 ? 'stall' : 'unstall']);
    else if (r < 0.98) schedule.push(['settle']);
    else if (r < 0.99) schedule.push(['poison']);
    else schedule.push(['restart']);
  }
  return schedule;
}

/**
 * What an engine is known to answer wrong, each kept red by its scenario in
 * lib/barrier-found.mjs (listed there as a gap), and let pass here so a
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
  eager: Object.freeze({ unshownAwaitedChange: true, refusedAsDirectory: true }),
});

/** A finding: the schedule, the step, and what was wrong there. */
class Finding extends Error {
  constructor(message, at) {
    super(`step ${at}: ${message}`);
  }
}

const shownText = (text) => (text.length > 40 ? `${JSON.stringify(text.slice(0, 24))}… (${text.length} bytes)` : JSON.stringify(text));
const describe = (state) => (state === undefined ? 'absent'
  : `${state.type === 'file' ? `file ${shownText(state.content)}` : 'dir'} ${state.mode.toString(8)}${state.uid === USER ? '' : ` uid ${state.uid}`}`);

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
  return state.type !== 'file' || answer.size === state.size;
}

/** Whether `answer` (of read `op` of `rel`; a pread's at `offset`) is what `world` says to the process. */
function answers(op, rel, answer, world, offset = 0) {
  if (op === 'opendir') return answers('readdir', rel, answer, world);
  if (op === 'pread') {
    const state = world.get(rel);
    if (state?.type === 'file' && unreachable(world, rel) === null && (bits(state) & 4) !== 0) return answer === state.content.slice(offset, offset + PREAD_BYTES);
    return answers('readFile', rel, answer, world);
  }
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
 * The model a schedule is judged against: the session's files, every state
 * they have had (state i: after i changes returned), and every change begun.
 * runSchedule drives it; a test drives it with no engine (barrier-oracle.mjs).
 */
export function createModel(tree = SEED_TREE) {
  let world = seedWorld(tree);
  const history = [world];
  /** Every change begun, in program order: its names, whether it is the process's own, the world it leaves (and, a write of the process's, the one it passes through), the states it began and landed at. */
  const changes = [];
  const seq = () => history.length - 1;
  /**
   * Whether `later` (the process's own) must land after `earlier`: an own
   * change before it whose names it overlaps, decided when it was called (a
   * call that cannot wait, or Node's structural one). A write decided later
   * than its call races what the process does meanwhile, either way.
   */
  const after = (earlier, later) => earlier !== later && earlier.own && later.own && (earlier.decides || earlier.sync) && changes.indexOf(earlier) < changes.indexOf(later) && overlaps(earlier.domain, later.domain);
  /**
   * Every world `rel` may have been seen in between states `from` and `to`:
   * at each state, the recorded world with any of the changes then in flight
   * (begun by it, not yet returned) that touch `rel` laid over it, each as it
   * ends or (a write) as it begins. Changes in flight together never
   * overlap, so any of them may have landed first; only four are laid, a
   * schedule rarely having more.
   */
  const worldsSeen = (rel, from, to, decided = false) => {
    const touching = changes.filter((change) => change.domain.some((root) => under(rel, root) || under(root, rel)));
    const worlds = [];
    for (let i = from; i <= to; i++) {
      const flying = touching.filter((c) => c.begun <= i && (c.done === null || c.done > i)).slice(0, 4);
      // Each change in flight: not landed (null), landed, or (a write) passing through; one of the process's own only once every earlier one it overlaps has landed.
      let choices = [[]];
      for (const change of flying) {
        const effects = decided && change.decides ? [change.post] : [null, change.post, ...(change.partial === null ? [] : [change.partial])];
        choices = choices.flatMap((chosen) => effects.map((effect) => [...chosen, effect]));
      }
      for (const chosen of choices) {
        if (flying.some((later, j) => chosen[j] !== null && flying.some((earlier, k) => k < j && after(earlier, later) && chosen[k] !== earlier.post))) continue;
        worlds.push(flying.reduce((world, change, j) => (chosen[j] === null ? world : laid(world, change.domain, chosen[j])), history[i]));
      }
    }
    return worlds;
  };
  return {
    get world() { return world; },
    seq,
    worldsSeen,
    /** Whether `step` must wait: a change in flight overlaps it, other than its own earlier ones for a process that orders its own (`ordered`). */
    busy: (step, ordered = false) => changes.some((change) => change.done === null && overlaps(change.domain, domainOf(step)) && (!ordered || outside(step[0]) || !change.own)),
    /** `step` begun now, as the process's own changes in flight leave the model for one of its own: its record, or null where it would fail. */
    begin(step) {
      const [way, op, a] = step;
      const own = !outside(way);
      const base = own ? changes.filter((c) => c.own && c.done === null).reduce((w, c) => laid(w, c.domain, c.post), world) : world;
      const post = applied(base, step);
      if (post === null) return null;
      // A write the process makes is an open that truncates, then the bytes: while it is in flight, the file may be empty.
      const partial = way === 'own' && op === 'write' ? new Map([...post, [a, { ...post.get(a), content: '', size: 0 }]]) : null;
      const decides = own && DECIDED.includes(op);
      const record = { domain: domainOf(step), own, decides, sync: way === 'sync', post, partial, begun: seq(), done: null, landing: null };
      changes.push(record);
      return record;
    },
    /** `record` returned: it lands (`landed` told) once every earlier own change it overlaps has, its effect on whatever else changed meanwhile. */
    finish(record, landed = () => {}) {
      record.landing = landed;
      for (let moved = true; moved;) {
        moved = false;
        for (const change of changes) {
          if (change.done !== null || change.landing === null || changes.some((earlier) => earlier.done === null && after(earlier, change))) continue;
          world = laid(world, change.domain, change.post);
          history.push(world);
          change.done = seq();
          const told = change.landing;
          change.landing = null;
          told();
          moved = true;
        }
      }
    },
    /** `record` was refused: it changed nothing. */
    drop(record) { changes.splice(changes.indexOf(record), 1); },
    /** Whether `answer` (of read `op` of `rel`, a pread's at `offset`) is one the session's files gave between states `from` and `to` (`decided`: with every structural change of the process's own in flight shown). */
    admits: (op, rel, answer, from, to, decided = false, offset = 0) => worldsSeen(rel, from, to, decided).some((w) => answers(op, rel, answer, w, offset)),
    /**
     * Whether `answer` (a descriptor read, `op` opendir or pread, of `rel`)
     * is what the file or directory it opened gave, wherever that was by the
     * time it was read: opened at `rel` at a state between `from` and `to`,
     * with the access the open needed, then read at that state or a later one.
     */
    followed: (op, rel, answer, from, to, offset = 0) => {
      for (let i = from; i <= to; i++) {
        for (const opened of worldsSeen(rel, i, i)) {
          const state = opened.get(rel);
          if (state === undefined || unreachable(opened, rel) !== null || (bits(state) & 4) === 0) continue;
          if (state.type !== (op === 'opendir' ? 'dir' : 'file')) continue;
          for (let j = i; j <= to; j++) {
            for (const [k, held] of history[j]) {
              if (held.id !== state.id) continue;
              for (const read of worldsSeen(k, j, j)) {
                const now = read.get(k);
                if (now?.id !== state.id) continue;
                if (op === 'opendir' ? Array.isArray(answer) && answer.join('/') === childrenOf(read, k).join('/') : answer === now.content.slice(offset, offset + PREAD_BYTES)) return true;
              }
            }
          }
        }
      }
      return false;
    },
    /** The names of the process's own changes in flight, not decided when called, that `domain` overlaps: its outcome races theirs. */
    racing: (domain) => changes.filter((c) => c.done === null && c.own && !c.decides && !c.sync && overlaps(c.domain, domain)).flatMap((c) => c.domain),
    /** Whether any change is in flight. */
    moving: () => changes.some((change) => change.done === null),
    /** The state the latest change of `rel` (or above it) landed at; Infinity while one is in flight. */
    touched: (rel) => Math.max(0, ...changes.filter((c) => c.domain.some((root) => under(rel, root))).map((c) => (c.done === null ? Infinity : c.done))),
    /** The state the latest structural change of the process's own in flight at or about `rel` began at, or 0. */
    decidedSince: (rel) => Math.max(0, ...changes.filter((c) => c.done === null && c.decides && c.domain.some((root) => under(rel, root) || under(root, rel))).map((c) => c.begun)),
    /** Whether a world between `from` and `to` holds, at `rel`, a file the process may read: what a refusal of its bytes (EAGAIN) can be about. */
    readable: (rel, from, to) => worldsSeen(rel, from, to).some((w) => unreachable(w, rel) === null && w.get(rel)?.type === 'file' && (bits(w.get(rel)) & 4) !== 0),
  };
}

/**
 * Run `schedule` on engine `kind` (bootEngine) with a seeded parking policy
 * (`parkSeed`, or none: only `hold` parks), letting pass what `knownGaps`
 * (KNOWN_GAPS[kind]) names. Resolves when it holds; throws a Finding naming
 * the step where it does not. Each step, call and park is written to stderr
 * as it happens: a child killed for a hang shows where it was.
 * @param {string} kind
 * @param {any[][]} schedule
 * @param {{ parkSeed?: number, knownGaps?: Record<string, boolean>, deadlineMs?: number }} [options]
 */
export async function runSchedule(kind, schedule, { parkSeed, knownGaps: gaps = {}, deadlineMs = 40_000 } = {}) {
  const note = (line) => { writeSync(2, `  | ${line}\n`); };
  note(`boot ${kind}`);
  // A store listed on demand refuses a name it does not know; the resident
  // filesystem over an enumerated one is let refuse it too (its completeness
  // is the view's own tests', resident-view-eager).
  const lazy = kind !== 'node';
  /** Whether a barrier refetches the files it drops that the process held (B5): the resident filesystem's over an enumerated store. */
  const refetches = kind === 'eager';
  /** Inputs whose barrier has not landed. */
  let inputsInFlight = 0;
  /** Files whose bytes an awaited read of the process's answered, and no change of its own touched since. */
  const resident = new Set();
  /** A poison the session answered, and no input landed since: a namespace that is not answering may refuse. */
  let poisoned = false;
  // Replies park at random once the process is up: its boot waits on replies no step releases.
  const parkRandom = parkSeed === undefined ? null : prng(parkSeed);
  let booted = false;
  const transport = scheduleTransport({
    park: () => booted && parkRandom !== null && parkRandom() < 0.3,
    note: (line) => { if (booted) note(line); },
    poisoned: () => { poisoned = true; },
  });
  const tree = seedTreeFor(schedule);
  const engine = await bootEngine(kind, {
    seed: (authority) => {
      for (const [rel, content] of Object.entries(tree)) {
        if (content === null) authority.kfs.mkdir(key(rel), { mode: DIR_MODE });
        else authority.kfs.writeFile(key(rel), content);
      }
    },
    supervise: transport.supervise,
    stdin: kind === 'node',
  });
  booted = true;
  const deadline = Date.now() + deadlineMs;

  const model = createModel(tree);
  const seq = model.seq;
  /** Every name a schedule may read: the universe's, and its bulk files. */
  const readable = ['', ...NAMES, ...Object.keys(tree).filter((rel) => rel in BULK)];
  /** Calls in flight: settled when their promise does. */
  const inflight = new Set();
  let completions = 0;
  /** The latest input whose barrier landed, as the model stood when it arrived. */
  let landed = 0;
  /** Each name's own last change, as the model stood when it returned. */
  const ownAt = new Map();
  const deferred = [];
  /** Files whose bytes a call that cannot wait was refused, and no awaited read answered since (Node's misses). */
  const missed = new Set();
  /** Names where two of the process's own changes raced (Node: a write decided after its call, and a later change): the session says how they ended. */
  const unsure = new Set();
  /** Wrong answers and refused changes found in flight, thrown at the next step. */
  const failures = [];
  /** The process's waves wait before they reach the session (['stall']). */
  let stalled = false;
  /** The names of the process's changes that returned and have not been published since. */
  let unpublished = [];
  /** Each peer change that returned, and as the model stood then: what the process may not know of before its next input lands. */
  const peerAt = [];
  /** Each awaited change of the process's own that returned, and as the model stood then: unshown to its calls that cannot wait until a barrier lands, where that is a known gap. */
  const awaitedAt = [];

  /** Whether a call that cannot wait may be refused (EAGAIN): a view listed on demand, a namespace a poison stopped or a listing is moving, or bytes it does not hold of a file it may read. */
  /**
   * Whether a refusal of `rel`'s bytes is a miss the store owes: a file the
   * process held, still there, every barrier since its last change landed
   * (each refetches what it drops) and none in flight.
   */
  const owedBytes = (rel) => refetches && resident.has(rel) && inputsInFlight === 0 && !poisoned && transport.inFlight('listing') === 0
    && model.world.get(rel)?.type === 'file' && model.touched(rel) <= landed;
  const refusable = (op, rel, from, to) => (op === 'readFile' && owedBytes(rel) ? false
    : lazy || poisoned || transport.inFlight('listing') > 0 || (op === 'readFile' && model.readable(rel, from, to)));
  const judge = (at, way, op, rel, answer, from, to, offset = 0) => {
    if (answer?.code === 'EAGAIN' && way === 'sync' && refusable(op, rel, from, to)) return;
    if (gaps.refusedAsDirectory && way === 'sync' && answer?.code === 'EISDIR' && model.worldsSeen(rel, from, to).some((world) => world.get(rel)?.type === 'dir')) return;
    if (gaps.absentWhileRelisted && way === 'sync' && answer === null && transport.inFlight('listing') > 0) return;
    const decided = kind === 'node' && way === 'sync';
    if (model.admits(op, rel, answer, from, to, decided, offset)) return;
    // A descriptor follows what it opened: a directory or file a rename moved after the open is read where it went.
    if ((op === 'opendir' || op === 'pread') && model.followed(op, rel, answer, from, to, offset)) return;
    const shown = answer?.code ?? (answer && typeof answer === 'object' && !Array.isArray(answer) ? `${answer.type} ${(answer.mode & 0o777).toString(8)} size ${answer.size}`
      : typeof answer === 'string' ? shownText(answer) : JSON.stringify(answer));
    const held = [...new Set(model.worldsSeen(rel, from, to, decided).map((world) => ((op === 'readdir' || op === 'opendir') && world.get(rel)?.type === 'dir' ? `[${childrenOf(world, rel)}]` : describe(world.get(rel)))))];
    throw new Finding(`${way} ${op} ${rel || '.'}${op === 'pread' ? ` at ${offset}` : ''} answered ${shown}; the session held ${held.join(' | ')} (states ${from}..${to})`, at);
  };

  const read = async (way, op, rel, offset = 0) => {
    const path = abs(rel);
    const call = way === 'sync' ? engine.sync : engine.fs;
    try {
      if (op === 'pread') {
        const opened = await engine.fs.open(path, { read: true });
        try { return dec.decode(await engine.fs.read(opened.id, offset, PREAD_BYTES)); } finally { await engine.fs.close(opened.id); }
      }
      if (op === 'stat') return normalized(await (way === 'sync' ? engine.sync.stat(path) : engine.stat(path)));
      if (op === 'readFile') {
        const bytes = await call.readFile(path);
        return bytes === null ? { code: 'ENOENT' } : dec.decode(bytes);
      }
      if (op === 'opendir') return await engine.opendir(path);
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

  /** A change begun now, as the model stands: 'wait' while one it may not overlap is in flight; null when it cannot be asked at all. */
  const begin = (at, way, step) => {
    const domain = domainOf(step);
    if (model.busy(step, kind === 'node')) return 'wait';
    if (!outside(way) && peerAt.some(({ done, domain: theirs }) => done > landed && overlaps(theirs, [...domain, ...domain.map(parentOf)]))) {
      note(`  (step ${at} skipped: a peer changed its names since the process's last input)`);
      return null;
    }
    if (way === 'sync' && gaps.unshownAwaitedChange && awaitedAt.some(({ done, domain: its }) => done > landed && overlaps(its, [...domain, ...domain.map(parentOf)]))) {
      note(`  (step ${at} skipped: it would decide on an awaited change of the process's own its view does not show yet, a known gap)`);
      return null;
    }
    const raced = !outside(way) ? model.racing(domain) : [];
    const record = model.begin(step);
    if (record === null) { note(`  (step ${at} skipped: ${JSON.stringify(step)} is not valid now)`); return null; }
    for (const root of raced.length > 0 ? [...raced, ...domain] : []) unsure.add(root);
    const publishes = outside(way) && overlaps(unpublished, domain) ? unpublished : null;
    const finish = () => model.finish(record, () => {
      if (outside(way)) peerAt.push({ done: seq(), domain });
      else {
        if (way === 'own') awaitedAt.push({ done: seq(), domain });
        for (const rel of [...resident]) if (domain.some((root) => under(rel, root) || under(root, rel))) resident.delete(rel);
        if (way === 'sync' || !gaps.unshownAwaitedChange) for (const root of domain) ownAt.set(root, seq());
        unpublished = [...unpublished, ...domain];
      }
    });
    if (way === 'sync') {
      try {
        change(way, step);
      } catch (error) {
        model.drop(record);
        if (error?.code === 'EAGAIN' && (lazy || poisoned)) return null;
        if (error?.code === 'EISDIR' && gaps.refusedAsDirectory && domain.some((rel) => model.world.get(rel)?.type === 'dir')) return null;
        throw new Finding(`sync ${step[1]} ${step.slice(2).join(' ')} failed: ${error?.code ?? error?.message ?? error}`, at);
      }
      finish();
      return null;
    }
    const published = publishes === null ? Promise.resolve() : engine.publish().then(() => { unpublished = unpublished.filter((root) => !publishes.includes(root)); });
    return track(published.then(() => change(way, step)).then(finish, (error) => {
      model.drop(record);
      failures.push(new Finding(`${way} ${step[1]} ${step.slice(2).join(' ')} failed: ${error?.code ?? error?.message ?? error}`, at));
    }));
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
      if (transport.parked().length === 0 && !stalled) {
        await sleep(1_000);
        if (progress() === seen && inflight.size > 0) throw new Finding(`deadlock: ${inflight.size} call(s) pending, every reply delivered, nothing moving`, at);
        continue;
      }
      return;
    }
    if (failures.length > 0) throw failures[0];
  };

  /** The states the session's database started a new incarnation at. */
  const restarts = [];
  /**
   * The session's database starts a new incarnation (rotateIncarnation):
   * its files and their revisions stay; every cursor held against the last
   * epoch poisons, and the process learns of it with its next barrier.
   * Node's own engine (node-shims) is not run across one: it goes with the
   * cutover.
   */
  const restart = (at) => {
    if (kind === 'node') { note(`  (step ${at}: a restart is the resident filesystem's to meet)`); return; }
    engine.authority.rawVfs.rotateIncarnation();
    restarts.push(seq());
    note(`  (step ${at}: the session's database started a new incarnation, epoch ${engine.authority.cursor().epoch})`);
  };

  const step = async (at, s) => {
    const [what] = s;
    if (what === 'hold') return transport.hold(s[1], s[2]);
    if (what === 'release') { transport.release(s[1]); return sleep(0); }
    if (what === 'settle') return settle(at);
    if (what === 'poison') return transport.poison();
    if (what === 'stall') { stalled = true; return engine.stall(); }
    if (what === 'unstall') { stalled = false; return engine.release(); }
    if (what === 'restart') return restart(at);
    if (what === 'input') {
      const arrived = seq();
      inputsInFlight++;
      return void track(engine.input().then(() => { landed = Math.max(landed, arrived); poisoned = false; }).finally(() => { inputsInFlight--; }));
    }
    const [way, op, rel, offset = 0] = s;
    if (op === 'stat' || op === 'readFile' || op === 'readdir' || op === 'opendir' || op === 'pread') {
      const bound = Math.max(landed, kind === 'node' && way === 'sync' ? model.decidedSince(rel) : 0,
        ...[...ownAt].filter(([root]) => under(rel, root) || under(root, rel)).map(([, i]) => i));
      if (way === 'sync') {
        const answer = await read(way, op, rel);
        if (op === 'readFile' && answer?.code === 'EAGAIN') missed.add(rel);
        return judge(at, way, op, rel, answer, bound, seq());
      }
      const from = kind === 'node' ? seq() : bound;
      return void track(read(way, op, rel, offset).then((answer) => {
        judge(at, way, op, rel, answer, from, seq(), offset);
        // A file past what the process holds whole is never held: its refusals are no miss.
        if (op === 'readFile' && typeof answer === 'string' && answer.length <= WASI_RESIDENT_FILE_CAP_BYTES) {
          missed.delete(rel);
          if (model.touched(rel) !== Infinity) resident.add(rel);
        }
      }).catch((error) => { failures.push(error); }));
    }
    if (begin(at, way, s) === 'wait') deferred.push([at, s]);
    return undefined;
  };

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
      if (failures.length > 0) throw failures[0];
    }
    // Quiescence: every reply delivered, every call returned, the deferred asked, a last barrier landed.
    const end = schedule.length;
    note('at rest: every reply delivered');
    stalled = false;
    await engine.release();
    transport.drain();
    await settle(end);
    while (deferred.length > 0) {
      const [was, s] = deferred.shift();
      if (begin(was, s[0], s) === 'wait') deferred.push([was, s]);
      await settle(end);
    }
    const arrived = seq();
    note('at rest: what the process wrote published, and a last input');
    track(engine.publish().then(() => engine.input()));
    await settle(end);
    landed = arrived;
    note('at rest: every name, both ways');
    const world = model.world;
    if (kind === 'node') {
      await globalThis.__nimbusVfsResidencySettle?.();
      const ledger = [...(globalThis.__nimbusVfsResidencyMisses ?? [])].sort();
      const owed = [...missed].filter((rel) => world.get(rel)?.type === 'file' && unreachable(world, rel) === null && (bits(world.get(rel)) & 4) !== 0).map(key).sort();
      if (ledger.join() !== owed.join()) throw new Finding(`at rest, the program's misses are [${ledger}]; unanswered are [${owed}]`, end);
    }
    // Where the process's own changes raced, how they ended is what the session holds: the process must show that.
    const truth = new Map(world);
    for (const rel of readable) {
      if (![...unsure].some((root) => under(rel, root) || under(root, rel))) continue;
      const held = normalized(await engine.authority.peerAs(CRED_KERNEL).lstat(key(rel)).catch(() => null));
      if (held === null) { truth.delete(rel); continue; }
      truth.set(rel, held.type === 'directory' ? { ...world.get(rel), type: 'dir', mode: held.mode & 0o777, uid: held.uid, gid: held.gid }
        : { ...world.get(rel), type: 'file', content: dec.decode(engine.authority.rawVfs.as(CRED_KERNEL).readFile(key(rel))), size: held.size, mode: held.mode & 0o777, uid: held.uid, gid: held.gid });
    }
    for (const rel of readable) {
      const state = truth.get(rel);
      for (const way of ['own', 'sync']) {
        for (const op of ['stat', state?.type === 'dir' ? 'readdir' : 'readFile']) {
          const answer = await read(way, op, rel);
          if (answer?.code === 'EAGAIN' && way === 'sync' && (op === 'readFile' ? !owedBytes(rel) && (lazy || model.readable(rel, seq(), seq())) : lazy)) continue;
          if (answer?.code === 'EISDIR' && way === 'sync' && gaps.refusedAsDirectory && state?.type === 'dir') continue;
          if (!answers(op, rel, answer, truth)) {
            throw new Finding(`at rest, ${way} ${op} ${rel || '.'} answered ${JSON.stringify(answer)}; the model holds ${op === 'readdir' && state?.type === 'dir' ? `[${childrenOf(truth, rel)}]` : describe(state)}`, end);
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
