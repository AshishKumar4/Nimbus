/**
 * named-shells.ts — a workspace's named shells.
 *
 * A named shell is a cwd and an environment that outlive the call that set
 * them, the way a terminal tab's do. Each name is a row of the workspace's
 * `vfs_shells` table, so it outlives the workspace object and its host's
 * restarts. Calls on one name run one at a time, in the order they were
 * made: two at once would read one state and race to write it back, and the
 * loser's `cd` would vanish. Calls on different names run at once.
 *
 * A call's functions, aliases, options, umask and descriptors are its
 * process's and end with it; only cwd and environment persist. The shell a
 * call runs in is built by the workspace for the call's own process
 * (`NimbusWorkspace.shellFor`), from the state this module keeps.
 */

import { z } from 'zod/v4';
import type { Shell } from '../substrate/lifo/shell/Shell.js';
import type { SqlDatabase } from '../runtime/os-contracts.js';

/** Where a shell is: its working directory and its environment. */
export interface ShellState {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** A named shell, held by one call: see {@link NamedShells.hold}. */
export interface NamedShell {
  /** Its working directory, where the process the call runs as starts. */
  readonly cwd: string;
  /** The shell, built for `pid`, the process the call runs as. */
  open(pid: number): Shell;
}

export interface NamedShellOptions {
  /**
   * Where a name with no saved state starts: absent, in the directory the
   * workspace started in (`fs.cwd`), with nothing beyond the workspace shell's
   * environment.
   */
  readonly start?: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> };
  /**
   * Save what the shell holds when the call settles; the default. False for a
   * call whose shell outlives it, such as a background job: what it would
   * save is a moment nobody asked about. A new name is saved where it started
   * either way.
   */
  readonly persist?: boolean;
}

/** A shell's name, the rule an `execId` follows. */
const ShellIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ShellStateSchema = z.object({
  cwd: z.string().startsWith('/'),
  env: z.record(z.string(), z.string()),
}).strict();

/** A saved shell state, or an error naming what is wrong with it. */
export function parseShellState(value: unknown): ShellState {
  return ShellStateSchema.parse(value);
}

/** Where named shells are saved, one row each; made by the first call that names one. */
export const SHELLS_TABLE = 'vfs_shells';

export class NamedShells {
  /** One queue per name: the last call made on it, settled when that call is. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly sql: SqlDatabase,
    /** Where a name with no saved state and no `start` begins. */
    private readonly home: string,
    /** The shell for one call's process, in `state`. */
    private readonly shellFor: (pid: number, state: ShellState) => Shell,
  ) {}

  /**
   * Run `body` in the named shell `id`: in the cwd and environment the last
   * call on that name left it with, else `options.start`, and save what the
   * shell holds when `body` settles. A name's first call saves where it
   * started even when it saves nothing else (`persist: false`), so the name
   * exists from then on, rooted there.
   */
  async hold<T>(id: string, options: NamedShellOptions, body: (shell: NamedShell) => Promise<T>): Promise<T> {
    const name = ShellIdSchema.parse(id);
    const previous = this.queues.get(name) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.queues.set(name, tail);
    await previous;
    try {
      // Every call, so a workspace whose tables were dropped makes it again.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${SHELLS_TABLE} (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT NOT NULL)`);
      const [saved] = this.sql.exec(`SELECT cwd, env FROM ${SHELLS_TABLE} WHERE id = ?`, name);
      const state = saved === undefined
        ? { cwd: options.start?.cwd ?? this.home, env: options.start?.env ?? {} }
        : parseShellState({ cwd: saved.cwd, env: JSON.parse(String(saved.env)) });
      const call: { shell?: Shell } = {};
      try {
        return await body({ cwd: state.cwd, open: (pid) => (call.shell = this.shellFor(pid, state)) });
      } finally {
        if (options.persist !== false) this.save(name, call.shell ? { cwd: call.shell.getCwd(), env: call.shell.getEnv() } : state);
        else if (saved === undefined) this.save(name, state);
      }
    } finally {
      release();
      if (this.queues.get(name) === tail) this.queues.delete(name);
    }
  }

  private save(name: string, state: ShellState): void {
    const env = { ...state.env };
    // `$` is the pid of the call that just ended, not state of the shell.
    delete env.$;
    this.sql.exec(
      `INSERT INTO ${SHELLS_TABLE} (id, cwd, env) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, env = excluded.env`,
      name, state.cwd, JSON.stringify(env),
    );
  }
}
