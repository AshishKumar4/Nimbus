/**
 * npm-journal.ts — how the shell's npm publishes an install: every rename it
 * makes in node_modules, recorded at `<node_modules>/.nimbus-install-journal`
 * before it starts and once its outcome is known, then committed once every
 * package is in place. An install that does not finish (a failure, a crash,
 * a lost isolate) is undone from the journal, by itself or by the next
 * install, and only from what the journal records.
 */
import type { CommandOutputStream } from '../types.js';
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import { renameOutcome } from '../../../../vfs/vfs-error.js';
import { basename, dirname, join } from '../../utils/path.js';

const FILE = '.nimbus-install-journal';

/** A rename publication makes: `kind` says whose content `from` holds. */
interface JournalStep {
	/** retire: the installed copy moved aside; publish: a staged package moved in; carry: a kept package moved from a retired copy into the new tree. */
	readonly kind: 'retire' | 'publish' | 'carry';
	readonly from: string;
	readonly to: string;
	/**
	 * begun: not known to have finished; done: `to` holds all of it (what is
	 * left at `from` is residue); none: nothing moved; undone: its inverse is
	 * made, recorded before the next older step's is begun.
	 */
	state: 'begun' | 'done' | 'none' | 'undone';
}

const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A journal's steps as read back: null where it is not one. */
function stepsOf(value: unknown): { steps: JournalStep[]; committed: boolean } | null {
	if (typeof value !== 'object' || value === null || !('steps' in value) || !('committed' in value)) return null;
	const { steps, committed } = value;
	if (typeof committed !== 'boolean' || !Array.isArray(steps)) return null;
	const read: JournalStep[] = [];
	for (const step of steps) {
		if (typeof step !== 'object' || step === null || !('kind' in step) || !('from' in step) || !('to' in step) || !('state' in step)) return null;
		const { kind, from, to, state } = step;
		if ((kind !== 'retire' && kind !== 'publish' && kind !== 'carry') || typeof from !== 'string' || typeof to !== 'string') return null;
		if (state !== 'begun' && state !== 'done' && state !== 'none' && state !== 'undone') return null;
		read.push({ kind, from, to, state });
	}
	return { steps: read, committed };
}

/** One install's publication into a node_modules tree. */
export class InstallJournal {
	private readonly steps: JournalStep[] = [];
	private committed = false;

	private constructor(private readonly vfs: VFS, private readonly path: string, private readonly run: string) {}

	/** A journal for the install `run` into `modulesDir`. */
	static begin(vfs: VFS, modulesDir: string, run: string): InstallJournal {
		return new InstallJournal(vfs, join(modulesDir, FILE), run);
	}

	/**
	 * Finish what an earlier install into `modulesDir` left: an uncommitted
	 * one undone (saying what it puts back), a committed one's retired copies
	 * removed. Answers false when it could not be undone, its copies kept as
	 * the errors it wrote name them.
	 */
	static async recover(vfs: VFS, modulesDir: string, stderr: CommandOutputStream): Promise<boolean> {
		const path = join(modulesDir, FILE);
		if (!(await vfs.exists(path))) return true;
		let read: ReturnType<typeof stepsOf> = null;
		try { read = stepsOf(JSON.parse(await vfs.readFileString(path))); } catch { read = null; }
		if (read !== null) {
			const journal = new InstallJournal(vfs, path, '');
			journal.steps.push(...read.steps);
			if (read.committed) await journal.removeRetired(stderr);
			else if (!(await journal.undoSteps(stderr, true))) return false;
		}
		await vfs.remove(path, { force: true });
		return true;
	}

	/** Where `target`'s installed copy is moved aside while this install publishes. */
	retired(target: string): string {
		return join(dirname(target), `.${basename(target)}-retired-${this.run}`);
	}

	/** Rename `from` to `to` as a step of `kind`, recorded before it starts and once its outcome is known. */
	async move(kind: JournalStep['kind'], from: string, to: string): Promise<void> {
		const step: JournalStep = { kind, from, to, state: 'begun' };
		this.steps.push(step);
		await this.write();
		try {
			await this.vfs.mkdir(dirname(to), { recursive: true });
			await this.vfs.rename(from, to);
			step.state = 'done';
		} catch (error) {
			const outcome = renameOutcome(error);
			if (outcome !== undefined) step.state = outcome === 'all' ? 'done' : 'none';
			await this.write();
			throw error;
		}
		await this.write();
	}

	/** Undo every move, newest first; the journal goes once the tree is as it was. Answers whether it is. */
	async undo(stderr: CommandOutputStream): Promise<boolean> {
		const restored = await this.undoSteps(stderr, false);
		if (restored) await this.vfs.remove(this.path, { force: true });
		return restored;
	}

	/** Every package is published: the journal says so, and the retired copies (the old tree's) go, then the journal. */
	async commit(stderr: CommandOutputStream): Promise<void> {
		this.committed = true;
		await this.write();
		await this.removeRetired(stderr);
		await this.vfs.remove(this.path, { force: true });
	}

	private async write(): Promise<void> {
		await this.vfs.writeFile(this.path, JSON.stringify({ run: this.run, steps: this.steps, committed: this.committed }));
	}

	private async removeRetired(stderr: CommandOutputStream): Promise<void> {
		for (const { kind, to, state } of this.steps) {
			if (kind !== 'retire' || state === 'none') continue;
			try { await this.vfs.remove(to, { recursive: true, force: true }); } catch (error) {
				await stderr.write(`npm WARN could not remove ${to}: ${describeError(error)}\n`);
			}
		}
	}

	/**
	 * Newest first, each inverse recorded as made before the next older one
	 * begins, so a replay never makes one twice: a published package goes
	 * (its content is new), and a retired or carried copy moves back, over
	 * any residue a rename left where it came from; one already back (its
	 * copy gone from where it was moved, and in place) is only recorded. A
	 * step whose copy cannot be told, or restored, stops the undo there:
	 * nothing older is undone (an ancestor's inverse would take the copy
	 * with it), both names and the journal are kept, and named.
	 * `recovering`: an install that did not finish is undone, and what is
	 * put back is said.
	 */
	private async undoSteps(stderr: CommandOutputStream, recovering: boolean): Promise<boolean> {
		for (const step of [...this.steps].reverse()) {
			const { kind, from, to } = step;
			if (step.state === 'undone') continue;
			try {
				let state = step.state;
				if (state === 'begun') {
					const atFrom = await this.vfs.exists(from);
					const atTo = await this.vfs.exists(to);
					state = !atTo ? 'none' : !atFrom ? 'done' : kind === 'publish' ? 'done' : 'begun';
				}
				if (state === 'begun') {
					await stderr.write(`npm ERR! could not tell whether ${from} or ${to} holds the installed copy; both are kept, and nothing older is undone\n`);
					return false;
				}
				if (state === 'done' && kind === 'publish') {
					// Staged and published content alike are this install's own.
					await this.vfs.remove(to, { recursive: true, force: true });
					await this.vfs.remove(from, { recursive: true, force: true });
				} else if (state === 'done' && await this.vfs.exists(to)) {
					await this.vfs.remove(from, { recursive: true, force: true });
					await this.vfs.mkdir(dirname(from), { recursive: true });
					await this.vfs.rename(to, from);
					if (recovering) await stderr.write(`npm WARN restored ${from}, which an install that did not finish had moved\n`);
				} else if (state === 'done' && !(await this.vfs.exists(from))) {
					await stderr.write(`npm ERR! the copy ${to} held of ${from} is gone; nothing older is undone\n`);
					return false;
				}
				step.state = 'undone';
				await this.write();
			} catch (error) {
				await stderr.write(kind === 'publish'
					? `npm ERR! could not remove ${to}, which an install that did not finish published: ${describeError(error)}; nothing older is undone\n`
					: `npm ERR! could not restore ${from}; its copy is kept at ${to}: ${describeError(error)}; nothing older is undone\n`);
				return false;
			}
		}
		return true;
	}
}
