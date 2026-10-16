/**
 * What a process changed by name that its view may not have yet (VFS-9 B
 * stage 3): the entries it decided (null: removed), and the names it made
 * and removed in each directory, laid over the view's. Per name, its logged
 * ops unanswered and how many barriers had begun when the last was
 * answered: outside a subtree the process holds, a name retires once a
 * barrier begun after that lands (retire), the view having the session's
 * version of it then. A refused op's name retires at once: the session never
 * applied it, and the view's row is the session's.
 */

import type { RuntimeVfsDirEntry } from '../os-contracts.js';
import type { ResidentEntry } from './resident-filesystem.js';
import type { ProcessFsOp } from '../../_shared/process-fs-client.js';

export interface OwnNamesOptions {
  /** The view's own word, this process's aside (HolderStore.entry). */
  entry(key: string): ResidentEntry | null | undefined;
  /** Whether a subtree the process holds covers `key`: its decisions stand while it holds it. */
  held(key: string): boolean;
  /** `key` retired: what it decided there was `entry`. */
  forgot(key: string, entry: ResidentEntry | null | undefined): void;
}

export interface OwnNames {
  /** This process's word on `key`: what it decided, or absent for a name not made in a directory it made. Undefined where it has none. */
  entry(key: string): ResidentEntry | null | undefined;
  /** What it decided at `key` (null: removed); undefined where it decided nothing. */
  decided(key: string): ResidentEntry | null | undefined;
  /** `key` is `entry` as it decided (null: removed). */
  decide(key: string, entry: ResidentEntry | null): void;
  /** Its decision at `key` is no longer its own: the session's answer replaced it. */
  undecide(key: string): void;
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
  /** `op` was logged: its names wait for its answer. Its names. */
  logged(op: ProcessFsOp): string[];
  /** The op that changed `keys` was answered: refused, or not. */
  answered(keys: readonly string[], refused: boolean): void;
  /** The subtree at `root` is no longer held: what it logged there retires as anything of its own does, and what it never logged goes now. */
  released(root: string): void;
  /** A barrier begins: its number, which `retire` takes once it lands. */
  barrierBegun(): number;
  /** Barrier `begun` landed: each name outside a held subtree whose ops were all answered before it began retires. */
  retire(begun: number): void;
}

function parentKey(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

function nameOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

function within(key: string, root: string): boolean {
  return key === root || key.startsWith(`${root}/`);
}

/** The names an op changes. */
function keysOf(op: ProcessFsOp): string[] {
  return op.type === 'rename' ? [op.from, op.to] : op.type === 'call' ? [op.call.path] : [op.path];
}

export function ownNames(options: OwnNamesOptions): OwnNames {
  const decided = new Map<string, ResidentEntry | null>();
  const added = new Map<string, Map<string, RuntimeVfsDirEntry['type']>>();
  const removed = new Map<string, Set<string>>();
  const own = new Map<string, { pending: number; settled: number }>();
  /** Of those, the ones all answered outside a held subtree: what a landed barrier may retire. */
  const settling = new Set<string>();
  let barriers = 0;

  /** Whether directory `key` was made here, and the view knows nothing of it: its names are the ones made in it. */
  const madeHere = (key: string): boolean => decided.get(key)?.type === 'directory' && !options.entry(key);

  /** `key`'s record goes: the view's row answers for it from now on. */
  const forget = (key: string): void => {
    const entry = decided.get(key);
    own.delete(key);
    settling.delete(key);
    decided.delete(key);
    added.get(parentKey(key))?.delete(nameOf(key));
    removed.get(parentKey(key))?.delete(nameOf(key));
    if (added.get(key)?.size === 0) added.delete(key);
    options.forgot(key, entry);
  };

  return {
    entry: (key) => {
      const mine = decided.get(key);
      if (mine !== undefined) return mine;
      const dir = parentKey(key);
      return key !== '' && madeHere(dir) && !added.get(dir)?.has(nameOf(key)) ? null : undefined;
    },
    decided: (key) => decided.get(key),
    decide: (key, entry) => { decided.set(key, entry); },
    undecide: (key) => { decided.delete(key); },
    note: (dir, name, type) => {
      if (type === null) {
        added.get(dir)?.delete(name);
        let gone = removed.get(dir);
        if (gone === undefined) removed.set(dir, gone = new Set());
        gone.add(name);
      } else {
        removed.get(dir)?.delete(name);
        let made = added.get(dir);
        if (made === undefined) added.set(dir, made = new Map());
        made.set(name, type);
      }
    },
    madeDirectory: (key) => { added.set(key, added.get(key) ?? new Map()); },
    removedDirectory: (key) => {
      added.delete(key);
      removed.delete(key);
    },
    children: (key, base) => {
      const made = added.get(key);
      const gone = removed.get(key);
      if (made === undefined && gone === undefined) return base;
      // One the view has not listed is listed first (undefined asks for that).
      if (base === undefined && !madeHere(key)) return undefined;
      const out = new Map<string, RuntimeVfsDirEntry['type']>();
      for (const child of base ?? []) if (!gone?.has(child.name)) out.set(child.name, child.type);
      for (const [name, type] of made ?? []) out.set(name, type);
      return [...out].map(([name, type]) => ({ name, type }));
    },
    move: (from, to) => {
      const moved = (key: string): string => to + key.slice(from.length);
      for (const [key, value] of [...decided]) if (key !== from && within(key, from)) { decided.delete(key); decided.set(moved(key), value); }
      for (const map of [added, removed] as Map<string, unknown>[]) {
        for (const [key, value] of [...map]) if (within(key, from)) { map.delete(key); map.set(moved(key), value); }
      }
      for (const [key, value] of [...own]) {
        if (key === from || !within(key, from)) continue;
        own.delete(key);
        own.set(moved(key), value);
        if (settling.delete(key)) settling.add(moved(key));
      }
    },
    logged: (op) => {
      const keys = keysOf(op);
      for (const key of keys) {
        const record = own.get(key);
        if (record === undefined) own.set(key, { pending: 1, settled: barriers });
        else record.pending++;
      }
      return keys;
    },
    answered: (keys, refused) => {
      for (const key of keys) {
        const record = own.get(key);
        if (record === undefined) continue;
        record.pending--;
        record.settled = barriers;
        if (refused) forget(key);
        else if (record.pending === 0 && !options.held(key)) settling.add(key);
      }
    },
    released: (root) => {
      for (const key of [...decided.keys()]) if (within(key, root) && !own.has(key)) forget(key);
      for (const [key, record] of own) if (record.pending === 0 && within(key, root)) settling.add(key);
    },
    barrierBegun: () => ++barriers,
    retire: (begun) => {
      for (const key of [...settling]) {
        const record = own.get(key);
        if (record === undefined || options.held(key)) settling.delete(key);
        else if (record.pending === 0 && record.settled < begun) forget(key);
      }
    },
  };
}
