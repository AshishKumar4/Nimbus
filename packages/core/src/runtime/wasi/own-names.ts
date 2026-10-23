/**
 * What a process decided by name in the subtrees it holds (VFS-9 B stage 3):
 * the entries it decided (null: removed), and the names it made and removed
 * in each directory, laid over the view's. They stand while it holds the
 * subtree; once it is given back, everything decided there sent, they retire
 * at the next barrier that lands (released, retire), the view having the
 * session's version of them then.
 */

import type { RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import { arrayCopy, mapKeyList, mapValueList, SafeList, SafeMap, SafeSet, setList, stringLastIndexOf, stringSlice, stringStartsWith } from '../../_shared/primordials.js';

export interface OwnNamesOptions {
  /** The view's own word, this process's aside (HolderStore.entry). */
  entry(key: string): ResidentEntry | null | undefined;
  /** `key` retired: what it decided there was `entry`. */
  forgot(key: string, entry: ResidentEntry | null | undefined): void;
}

export interface OwnNames {
  /** This process's word on `key`: what it decided, or absent for a name not made in a directory it made. Undefined where it has none. */
  entry(key: string): ResidentEntry | null | undefined;
  /** What it decided, by name (null: removed): read as the holder decides; a name decided again is the deciding grant's. */
  readonly decided: SafeMap<string, ResidentEntry | null>;
  /** Decide `key` (null: removed): a new decision there, of a new generation. */
  decide(key: string, entry: ResidentEntry | null): void;
  /** The generation of its decision at `key`: undefined where it has none. */
  generation(key: string): number | undefined;
  /** Its decision at `key` while the deciding grant's own, not given back: undefined where it has none or gave it back. */
  current(key: string): ResidentEntry | null | undefined;
  /** Its decision at `key` was changed in place (a held write): decided again, not what was given back. */
  rewritten(key: string): void;
  /** Its decision at `key` is no longer its own: the session's answer replaced it. */
  undecide(key: string): void;
  /** The session moved or removed the name `key`: what it decided at and under it goes, with what was noted there (its listing, a file's cell). */
  superseded(key: string): void;
  /**
   * A change of the process's own at `key`, made over its decision there of
   * `generation`, is the view's: that decision and what was noted of the
   * name go (true). One decided or moved there since is newer than the
   * view's answer, and stays.
   */
  settled(key: string, generation: number | undefined): boolean;
  /** Directory `dir` gained `name` (`type`), or lost it (null). */
  note(dir: string, name: string, type: RuntimeVfsDirEntry['type'] | null): void;
  /** A directory made at `key`: its names are the ones made in it. */
  madeDirectory(key: string): void;
  /** Directory `key` removed: what was noted in it goes. */
  removedDirectory(key: string): void;
  /** Directory `key`'s names as the view lists them (`base`), with what was made and removed there; undefined where the view must list it first. */
  children(key: string, base: RuntimeVfsDirEntry[] | undefined): RuntimeVfsDirEntry[] | undefined;
  /** What it decided beneath `from` is beneath `to` now: `from` itself is the rename's. */
  move(from: string, to: string): void;
  /**
   * The subtree at `root` is no longer held, everything decided there
   * answered: it retires as anything of the process's own does, at the next
   * barrier that lands.
   */
  released(root: string): void;
  /** A barrier begins: its number, which `retire` takes once it lands. */
  barrierBegun(): number;
  /** Barrier `begun` landed: each name given back, not decided again since, whose ops were all answered before it began retires. */
  retire(begun: number): void;
}

function parentKey(key: string): string {
  const at = stringLastIndexOf(key, '/');
  return at < 0 ? '' : stringSlice(key, 0, at);
}

function nameOf(key: string): string {
  return stringSlice(key, stringLastIndexOf(key, '/') + 1);
}

function within(key: string, root: string): boolean {
  return key === root || stringStartsWith(key, `${root}/`);
}

export function ownNames(options: OwnNamesOptions): OwnNames {
  const decided = new SafeMap<string, ResidentEntry | null>();
  /** Each decision's generation: one made again, or moved, is a new one. */
  const born = new SafeMap<string, number>();
  let generations = 0;
  /**
   * The barrier begun when each name's subtree was last given back,
   * everything decided there answered, and the generation of the decision
   * it gave back: one begun after retires it, unless the name was decided
   * again or moved since (a new generation).
   */
  const own = new SafeMap<string, { barrier: number; generation: number | undefined }>();
  const added = new SafeMap<string, SafeMap<string, RuntimeVfsDirEntry['type']>>();
  const removed = new SafeMap<string, SafeSet<string>>();
  let barriers = 0;
  /** The directories made here: until the view has one, its names are the ones made in it. */
  const made = new SafeSet<string>();

  /** Whether directory `key` was made here, and the view knows nothing of it: its names are the ones made in it. */
  const madeHere = (key: string): boolean => made.has(key) && decided.get(key)?.type === 'directory' && !options.entry(key);

  /** `key`'s record goes: the view's row answers for it from now on. */
  const forget = (key: string): void => {
    const entry = decided.get(key);
    own.delete(key);
    decided.delete(key);
    born.delete(key);
    made.delete(key);
    const madeIn = added.get(parentKey(key));
    if (madeIn !== undefined) madeIn.delete(nameOf(key));
    const goneIn = removed.get(parentKey(key));
    if (goneIn !== undefined) goneIn.delete(nameOf(key));
    const madeThere = added.get(key);
    if (madeThere !== undefined && madeThere.size === 0) added.delete(key);
    options.forgot(key, entry);
  };

  return {
    entry: (key) => {
      const mine = decided.get(key);
      if (mine !== undefined || made.size === 0) return mine;
      const dir = parentKey(key);
      if (key === '' || !madeHere(dir)) return undefined;
      const madeIn = added.get(dir);
      return madeIn === undefined || !madeIn.has(nameOf(key)) ? null : undefined;
    },
    decided,
    decide: (key, entry) => {
      decided.set(key, entry);
      born.set(key, ++generations);
    },
    generation: (key) => born.get(key),
    current: (key) => (own.has(key) ? undefined : decided.get(key)),
    rewritten: (key) => {
      if (own.size !== 0) own.delete(key);
    },
    undecide: (key) => {
      decided.delete(key);
      born.delete(key);
    },
    superseded: (key) => {
      const names = mapKeyList(decided);
      for (let i = 0; i < names.length; i++) if (within(names[i], key)) forget(names[i]);
    },
    settled: (key, generation) => {
      if (generation === undefined || born.get(key) !== generation) return false;
      forget(key);
      return true;
    },
    note: (dir, name, type) => {
      if (type === null) {
        const madeIn = added.get(dir);
        if (madeIn !== undefined) madeIn.delete(name);
        let gone = removed.get(dir);
        if (gone === undefined) removed.set(dir, gone = new SafeSet());
        gone.add(name);
      } else {
        const goneIn = removed.get(dir);
        if (goneIn !== undefined) goneIn.delete(name);
        let made = added.get(dir);
        if (made === undefined) added.set(dir, made = new SafeMap());
        made.set(name, type);
      }
    },
    madeDirectory: (key) => {
      made.add(key);
      added.set(key, added.get(key) ?? new SafeMap());
    },
    removedDirectory: (key) => {
      made.delete(key);
      added.delete(key);
      removed.delete(key);
    },
    children: (key, base) => {
      const made = added.get(key);
      const gone = removed.get(key);
      if (made === undefined && gone === undefined) return base;
      // One the view has not listed is listed first (undefined asks for that).
      if (base === undefined && !madeHere(key)) return undefined;
      const out = new SafeMap<string, RuntimeVfsDirEntry['type']>();
      if (base !== undefined) for (let i = 0; i < base.length; i++) if (gone === undefined || !gone.has(base[i].name)) out.set(base[i].name, base[i].type);
      if (made !== undefined) made.forEach((type, name) => { out.set(name, type); });
      const listed = new SafeList<RuntimeVfsDirEntry>();
      out.forEach((type, name) => { listed[listed.length] = { name, type }; });
      return arrayCopy(listed);
    },
    move: (from, to) => {
      const moved = (key: string): string => to + stringSlice(key, from.length);
      const keys = mapKeyList(decided);
      const values = mapValueList(decided);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === from || !within(key, from)) continue;
        decided.delete(key);
        born.delete(key);
        decided.set(moved(key), values[i]);
        born.set(moved(key), ++generations);
      }
      const dirs = setList(made);
      for (let i = 0; i < dirs.length; i++) if (within(dirs[i], from)) { made.delete(dirs[i]); made.add(moved(dirs[i])); }
      const moveAll = <V>(map: SafeMap<string, V>): void => {
        const at = mapKeyList(map);
        const held = mapValueList(map);
        for (let i = 0; i < at.length; i++) if (within(at[i], from)) { map.delete(at[i]); map.set(moved(at[i]), held[i]); }
      };
      moveAll(added);
      moveAll(removed);
      const owned = mapKeyList(own);
      for (let i = 0; i < owned.length; i++) if (owned[i] !== from && within(owned[i], from)) own.delete(owned[i]);
    },
    released: (root) => {
      // Stamped at every release: one decided under a later grant retires after this release, not an earlier one.
      decided.forEach((_entry, key) => { if (within(key, root)) own.set(key, { barrier: barriers, generation: born.get(key) }); });
    },
    barrierBegun: () => ++barriers,
    // A subtree held again since does not keep it: what the session has there now is what the view read.
    retire: (begun) => {
      const keys = mapKeyList(own);
      const stamps = mapValueList(own);
      for (let i = 0; i < keys.length; i++) {
        const { barrier, generation } = stamps[i];
        if (born.get(keys[i]) !== generation) own.delete(keys[i]);
        else if (barrier < begun) forget(keys[i]);
      }
    },
  };
}
