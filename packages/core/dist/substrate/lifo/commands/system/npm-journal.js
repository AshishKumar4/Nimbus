import { renameOutcome } from '../../../../vfs/vfs-error.js';
import { basename, dirname, join } from '../../utils/path.js';
const FILE = '.nimbus-install-journal';
const describeError = (error) => error instanceof Error ? error.message : String(error);
/** A journal's steps as read back: null where it is not one. */
function stepsOf(value) {
    if (typeof value !== 'object' || value === null || !('steps' in value) || !('committed' in value))
        return null;
    const { steps, committed } = value;
    if (typeof committed !== 'boolean' || !Array.isArray(steps))
        return null;
    const read = [];
    for (const step of steps) {
        if (typeof step !== 'object' || step === null || !('kind' in step) || !('from' in step) || !('to' in step) || !('state' in step))
            return null;
        const { kind, from, to, state } = step;
        if ((kind !== 'retire' && kind !== 'publish' && kind !== 'carry') || typeof from !== 'string' || typeof to !== 'string')
            return null;
        if (state !== 'begun' && state !== 'done' && state !== 'none' && state !== 'undoing' && state !== 'undone')
            return null;
        read.push({ kind, from, to, state });
    }
    return { steps: read, committed };
}
/** One install's publication into a node_modules tree. */
export class InstallJournal {
    vfs;
    path;
    run;
    steps = [];
    committed = false;
    constructor(vfs, path, run) {
        this.vfs = vfs;
        this.path = path;
        this.run = run;
    }
    /** A journal for the install `run` into `modulesDir`. */
    static begin(vfs, modulesDir, run) {
        return new InstallJournal(vfs, join(modulesDir, FILE), run);
    }
    /**
     * Finish what an earlier install into `modulesDir` left: an uncommitted
     * one undone (saying what it puts back), a committed one's retired copies
     * removed. Answers false when it could not be undone, its copies kept as
     * the errors it wrote name them.
     */
    static async recover(vfs, modulesDir, stderr) {
        const path = join(modulesDir, FILE);
        if (!(await vfs.exists(path)))
            return true;
        let read = null;
        try {
            read = stepsOf(JSON.parse(await vfs.readFileString(path)));
        }
        catch {
            read = null;
        }
        if (read !== null) {
            const journal = new InstallJournal(vfs, path, '');
            journal.steps.push(...read.steps);
            if (read.committed)
                await journal.removeRetired(stderr);
            else if (!(await journal.undoSteps(stderr, true)))
                return false;
        }
        await vfs.remove(path, { force: true });
        return true;
    }
    /** Where `target`'s installed copy is moved aside while this install publishes. */
    retired(target) {
        return join(dirname(target), `.${basename(target)}-retired-${this.run}`);
    }
    /** Rename `from` to `to` as a step of `kind`, recorded before it starts and once its outcome is known. */
    async move(kind, from, to) {
        const step = { kind, from, to, state: 'begun' };
        this.steps.push(step);
        await this.write();
        try {
            await this.vfs.mkdir(dirname(to), { recursive: true });
            await this.vfs.rename(from, to);
            step.state = 'done';
        }
        catch (error) {
            const outcome = renameOutcome(error);
            if (outcome !== undefined)
                step.state = outcome === 'all' ? 'done' : 'none';
            await this.write();
            throw error;
        }
        await this.write();
    }
    /** Undo every move, newest first; the journal goes once the tree is as it was. Answers whether it is. */
    async undo(stderr) {
        const restored = await this.undoSteps(stderr, false);
        if (restored)
            await this.vfs.remove(this.path, { force: true });
        return restored;
    }
    /** Every package is published: the journal says so, and the retired copies (the old tree's) go, then the journal. */
    async commit(stderr) {
        this.committed = true;
        await this.write();
        await this.removeRetired(stderr);
        await this.vfs.remove(this.path, { force: true });
    }
    async write() {
        await this.vfs.writeFile(this.path, JSON.stringify({ run: this.run, steps: this.steps, committed: this.committed }));
    }
    async removeRetired(stderr) {
        for (const { kind, to, state } of this.steps) {
            if (kind !== 'retire' || state === 'none')
                continue;
            try {
                await this.vfs.remove(to, { recursive: true, force: true });
            }
            catch (error) {
                await stderr.write(`npm WARN could not remove ${to}: ${describeError(error)}\n`);
            }
        }
    }
    /** Every path under `dir`, relative to it ('' for `dir` itself); a link is not followed. */
    async pathsUnder(dir, prefix = '', out = new Set()) {
        out.add(prefix);
        if (await this.vfs.isSymlink(dir))
            return out;
        let entries;
        try {
            entries = await this.vfs.readdir(dir);
        }
        catch {
            return out;
        }
        for (const { name } of entries)
            await this.pathsUnder(join(dir, name), `${prefix}/${name}`, out);
        return out;
    }
    /**
     * What a rename from `source` to `destination` whose outcome was not
     * recorded did: nothing; all of it (the source's remains residue); or
     * part of it, the source whole.
     */
    async settle(source, destination) {
        if (!(await this.vfs.exists(destination)))
            return 'none';
        if (!(await this.vfs.exists(source)))
            return 'all';
        const moved = await this.pathsUnder(destination);
        for (const path of await this.pathsUnder(source))
            if (!moved.has(path))
                return 'part';
        return 'all';
    }
    async record(step, state) {
        step.state = state;
        await this.write();
    }
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
    async undoSteps(stderr, recovering) {
        for (const step of [...this.steps].reverse()) {
            const { kind, from, to } = step;
            try {
                if (step.state === 'begun') {
                    const outcome = await this.settle(from, to);
                    if (outcome === 'part')
                        await this.vfs.remove(to, { recursive: true, force: true });
                    await this.record(step, outcome === 'all' ? 'done' : 'none');
                }
                if (step.state === 'undoing') {
                    const outcome = await this.settle(to, from);
                    if (outcome === 'all')
                        await this.vfs.remove(to, { recursive: true, force: true });
                    if (outcome === 'part')
                        await this.vfs.remove(from, { recursive: true, force: true });
                    await this.record(step, outcome === 'all' ? 'undone' : 'done');
                }
                if (step.state !== 'done')
                    continue;
                if (kind === 'publish') {
                    // Staged and published content alike are this install's own.
                    await this.vfs.remove(to, { recursive: true, force: true });
                    await this.vfs.remove(from, { recursive: true, force: true });
                    await this.record(step, 'undone');
                    continue;
                }
                if (!(await this.vfs.exists(to))) {
                    await stderr.write(`npm ERR! the copy ${to} held of ${from} is gone; nothing older is undone\n`);
                    return false;
                }
                // What is at `from` is residue: the inverse's destination is emptied first.
                await this.vfs.remove(from, { recursive: true, force: true });
                await this.vfs.mkdir(dirname(from), { recursive: true });
                await this.record(step, 'undoing');
                try {
                    await this.vfs.rename(to, from);
                }
                catch (error) {
                    const outcome = renameOutcome(error);
                    if (outcome === undefined)
                        throw error;
                    if (outcome !== 'all') {
                        await this.record(step, 'done');
                        throw error;
                    }
                    // All of it is back; what is left where it was is residue.
                    await this.vfs.remove(to, { recursive: true, force: true });
                }
                await this.record(step, 'undone');
                if (recovering)
                    await stderr.write(`npm WARN restored ${from}, which an install that did not finish had moved\n`);
            }
            catch (error) {
                await stderr.write(kind === 'publish'
                    ? `npm ERR! could not remove ${to}, which an install that did not finish published: ${describeError(error)}; nothing older is undone\n`
                    : `npm ERR! could not restore ${from}; its copy is kept at ${to}: ${describeError(error)}; nothing older is undone\n`);
                return false;
            }
        }
        return true;
    }
}
