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
    /** What it decided, by name (null: removed): read and changed as the holder decides. */
    readonly decided: Map<string, ResidentEntry | null>;
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
    /**
     * The subtree at `root` is no longer held, everything decided there
     * answered: it retires as anything of the process's own does, at the next
     * barrier that lands.
     */
    released(root: string): void;
    /** A barrier begins: its number, which `retire` takes once it lands. */
    barrierBegun(): number;
    /** Barrier `begun` landed: each name outside a held subtree whose ops were all answered before it began retires. */
    retire(begun: number): void;
}
export declare function ownNames(options: OwnNamesOptions): OwnNames;
//# sourceMappingURL=own-names.d.ts.map