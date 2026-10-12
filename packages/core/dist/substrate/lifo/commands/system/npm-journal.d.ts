/**
 * npm-journal.ts — how the shell's npm publishes an install: every rename it
 * makes in node_modules, recorded at `<node_modules>/.nimbus-install-journal`
 * before it starts and once its outcome is known, then committed once every
 * package is in place. An install that does not finish (a failure, a crash,
 * a lost isolate) is undone from the journal, by itself or by the next
 * install, and only from what the journal records.
 *
 * A rename leaves one of three states (renameOutcome): nothing moved; part
 * of the tree at its destination and all of it still at its source; or all
 * of it at its destination and residue (a part of it) at its source. Where
 * the outcome was not recorded (a crash), it is read back from the two
 * trees: the destination holds all of it exactly when every path still at
 * the source is at the destination too.
 */
import type { CommandOutputStream } from '../types.js';
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
/** A rename publication makes: `kind` says whose content `from` holds. */
interface JournalStep {
    /** retire: the installed copy moved aside; publish: a staged package moved in; carry: a kept package moved from a retired copy into the new tree. */
    readonly kind: 'retire' | 'publish' | 'carry';
    readonly from: string;
    readonly to: string;
    /**
     * begun: its outcome not recorded; done: `to` holds all of it (what is
     * left at `from` is residue); none: nothing moved; undoing: its inverse
     * (`to` back to `from`, which was empty) begun, its outcome not recorded;
     * undone: the inverse made, recorded before the next older step's begins.
     */
    state: 'begun' | 'done' | 'none' | 'undoing' | 'undone';
}
/** One install's publication into a node_modules tree. */
export declare class InstallJournal {
    private readonly vfs;
    private readonly path;
    private readonly run;
    private readonly steps;
    private committed;
    private constructor();
    /** A journal for the install `run` into `modulesDir`. */
    static begin(vfs: VFS, modulesDir: string, run: string): InstallJournal;
    /**
     * Finish what an earlier install into `modulesDir` left: an uncommitted
     * one undone (saying what it puts back), a committed one's retired copies
     * removed. Answers false when it could not be undone, its copies kept as
     * the errors it wrote name them.
     */
    static recover(vfs: VFS, modulesDir: string, stderr: CommandOutputStream): Promise<boolean>;
    /** Where `target`'s installed copy is moved aside while this install publishes. */
    retired(target: string): string;
    /** Rename `from` to `to` as a step of `kind`, recorded before it starts and once its outcome is known. */
    move(kind: JournalStep['kind'], from: string, to: string): Promise<void>;
    /** Undo every move, newest first; the journal goes once the tree is as it was. Answers whether it is. */
    undo(stderr: CommandOutputStream): Promise<boolean>;
    /** Every package is published: the journal says so, and the retired copies (the old tree's) go, then the journal. */
    commit(stderr: CommandOutputStream): Promise<void>;
    private write;
    private removeRetired;
    /**
     * Every path under `path`, relative to it ('' for `path` itself); a link
     * is not followed. Only a directory is listed, and a listing that fails,
     * or names what is not there, throws: an incomplete listing is no
     * evidence of what a rename moved.
     */
    private pathsUnder;
    /**
     * What a rename from `source` to `destination` whose outcome was not
     * recorded did: nothing; all of it (the source's remains residue); or
     * part of it, the source whole.
     */
    private settle;
    private record;
    /**
     * Newest first, each inverse recorded before it is made and once it is,
     * so a replay never makes one twice: a published package goes (its
     * content is new); a retired or carried copy moves back where it was,
     * over the residue a rename left there. A step whose outcome was not
     * recorded is settled from the trees first: a part moved is removed from
     * where it went, the source being whole. A step that cannot be undone
     * stops the undo there: nothing older is undone (an ancestor's inverse
     * would take the copy with it); the journal stays, and names it.
     * `recovering`: an install that did not finish is undone, and what is
     * put back is said.
     */
    private undoSteps;
}
export {};
//# sourceMappingURL=npm-journal.d.ts.map