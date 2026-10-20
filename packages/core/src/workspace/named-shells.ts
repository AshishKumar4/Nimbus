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
 * process's and end with it; its cwd and variables persist, their values and
 * their attributes (export, readonly, declared, arrays). The shell a
 * call runs in is built by the workspace for the call's own process
 * (`NimbusWorkspace.shellFor`), from the state this module keeps.
 */

import { z } from 'zod/v4';
import type { Shell } from '../substrate/lifo/shell/Shell.js';
import { cloneEnv, type VariableAttributes } from '../substrate/lifo/shell/variables.js';
import { startupAttributes } from '../substrate/lifo/shell/state.js';
import type { SqlDatabase } from '../runtime/os-contracts.js';

/**
 * Where a shell is: its working directory, its variables' scalar values
 * (`env`), and their attributes and arrays (`vars`). A state without `vars`
 * is one whose every variable is a scalar in `env`, exported, and nothing
 * else: it is saved without it, so its digest is what it was before `vars`.
 */
export interface ShellState {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly vars?: VariableAttributes;
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
  /** Release this call's ownership, without stopping it or saving its later state. */
  readonly detach?: AbortSignal;
}

/** A shell's name, the rule an `execId` follows. */
const ShellIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/** A plain object whose every value `entry` accepts, its own names kept (`__proto__` too), on a null prototype. */
function nameRecord<T>(entry: (value: unknown) => value is T): z.ZodType<Record<string, T>> {
  return z.custom<Record<string, T>>((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === null || prototype === Object.prototype) && Object.values(value).every(entry);
  }).transform((record) => {
    const copy: Record<string, T> = Object.create(null);
    for (const name of Object.keys(record)) copy[name] = record[name];
    return copy;
  });
}

const isString = (value: unknown): value is string => typeof value === 'string';
const NameListSchema = z.array(z.string());
/** An array's elements, `[index, value]` in index order. */
const isElements = (value: unknown): value is Array<[number, string]> => Array.isArray(value) && value.every((element) => (
  // Any index lifo's arrays take (an assignment's arithmetic), however high.
  Array.isArray(element) && element.length === 2 && Number.isInteger(element[0]) && element[0] >= 0 && typeof element[1] === 'string'
));
const VariableAttributesSchema: z.ZodType<VariableAttributes> = z.object({
  exported: NameListSchema,
  readonly: NameListSchema,
  declared: NameListSchema,
  arrays: nameRecord(isElements),
}).strict();
const ShellStateSchema = z.object({
  cwd: z.string().startsWith('/'),
  env: nameRecord(isString).transform(cloneEnv),
  vars: VariableAttributesSchema.optional(),
}).strict();

/** Saved variable attributes (a hosted terminal's JSON), or an error naming what is wrong with them. */
export function parseVariableAttributes(json: string): VariableAttributes {
  return VariableAttributesSchema.parse(JSON.parse(json));
}

/** A saved shell state, or an error naming what is wrong with it. */
export function parseShellState(value: unknown): ShellState {
  return ShellStateSchema.parse(value);
}

/** Where named shells are saved, one row each; made by the first call that names one. */
export const SHELLS_TABLE = 'vfs_shells';

export class NamedShells {
  /** One queue per name: the last call made on it, settled when that call is. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly idle = Promise.resolve();
  private parsedName: string | undefined;
  /** Whether the table has its `vars` column (addVarsColumn); a table made again by CREATE has it. */
  private varsColumn = false;

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
  hold<T>(id: string, options: NamedShellOptions, body: (shell: NamedShell) => Promise<T>): Promise<T> {
    return this.run(id, options, body);
  }

  /** The last saved state, after earlier calls on this name have settled. */
  read(id: string): Promise<ShellState | null> {
    return this.run(id);
  }

  private run(id: string): Promise<ShellState | null>;
  private run<T>(id: string, options: NamedShellOptions, body: (shell: NamedShell) => Promise<T>): Promise<T>;
  private async run<T>(id: string, options?: NamedShellOptions, body?: (shell: NamedShell) => Promise<T>): Promise<T | ShellState | null> {
    // Cache only name syntax; reload its saved state on every turn.
    const name = this.parsedName !== undefined && id === this.parsedName ? id : ShellIdSchema.parse(id);
    this.parsedName = name;
    const queued = this.queues.get(name);
    const previous = queued ?? this.idle;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = queued === undefined ? gate : previous.then(() => gate);
    this.queues.set(name, tail);
    await previous;
    let detached = false;
    const leave = () => {
      release();
      if (this.queues.get(name) === tail) this.queues.delete(name);
    };
    const detach = () => { detached = true; leave(); };
    try {
      // Every call, so a workspace whose tables were dropped makes it again.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${SHELLS_TABLE} (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT NOT NULL, vars TEXT)`);
      this.addVarsColumn();
      const [row] = this.sql.exec(`SELECT cwd, env, vars FROM ${SHELLS_TABLE} WHERE id = ?`, name);
      const saved = row === undefined ? null : parseShellState({
        cwd: row.cwd,
        env: JSON.parse(String(row.env)),
        // A row from before `vars`, or one whose attributes were the default, has none.
        ...(row.vars === null || row.vars === undefined ? {} : { vars: JSON.parse(String(row.vars)) }),
      });
      if (options === undefined || body === undefined) return saved;
      const state = saved ?? { cwd: options.start?.cwd ?? this.home, env: options.start?.env ?? {} };
      // The next owner may start before this body settles. It sees the last
      // durable state, including a new name's initial root, never this body's
      // in-flight cwd/environment or its later completion.
      if (saved === null) this.save(name, state);
      if (options.detach?.aborted) detach();
      else options.detach?.addEventListener('abort', detach, { once: true });
      const call: { shell?: Shell } = {};
      try {
        return await body({ cwd: state.cwd, open: (pid) => (call.shell = this.shellFor(pid, state)) });
      } finally {
        if (!detached && options.persist !== false) {
          this.save(name, call.shell ? { cwd: call.shell.getCwd(), env: call.shell.getEnv(), vars: call.shell.getVariableAttributes() } : state);
        }
      }
    } finally {
      options?.detach?.removeEventListener('abort', detach);
      leave();
    }
  }

  private save(name: string, state: ShellState): void {
    const env = cloneEnv(state.env);
    // The call's own (CALL_VARIABLES) are not state of the shell.
    for (const name of CALL_VARIABLES) delete env[name];
    const vars = state.vars === undefined ? undefined : withoutCallVariables(state.vars);
    this.sql.exec(
      `INSERT INTO ${SHELLS_TABLE} (id, cwd, env, vars) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, env = excluded.env, vars = excluded.vars`,
      name, state.cwd, JSON.stringify(env), vars === undefined || isDefault(vars, env) ? null : JSON.stringify(vars),
    );
  }

  /** The `vars` column, on a table made before it: added once, its rows' `vars` null (read as today's). */
  private addVarsColumn(): void {
    if (this.varsColumn) return;
    const columns = [...this.sql.exec(`PRAGMA table_info(${SHELLS_TABLE})`)];
    if (!columns.some((column) => column.name === 'vars')) this.sql.exec(`ALTER TABLE ${SHELLS_TABLE} ADD COLUMN vars TEXT`);
    this.varsColumn = true;
  }
}

/**
 * A call's own variables, not state of the shell: `$`, the pid of the call
 * that just ended, and PIPESTATUS, its last statuses (as `$?` is not kept).
 */
const CALL_VARIABLES: ReadonlySet<string> = new Set(['$', 'PIPESTATUS']);

/** `vars` without the call's own variables (CALL_VARIABLES). */
function withoutCallVariables(vars: VariableAttributes): VariableAttributes {
  const arrays: Record<string, ReadonlyArray<readonly [number, string]>> = Object.create(null);
  for (const [array, elements] of Object.entries(vars.arrays)) if (!CALL_VARIABLES.has(array)) arrays[array] = elements;
  return {
    exported: vars.exported.filter((name) => !CALL_VARIABLES.has(name)),
    readonly: vars.readonly.filter((name) => !CALL_VARIABLES.has(name)),
    declared: vars.declared.filter((name) => !CALL_VARIABLES.has(name)),
    arrays,
  };
}

/** Whether `vars` says no more than a state without it: the marks a shell starts with over `env` (startupAttributes), and nothing else. */
function isDefault(vars: VariableAttributes, env: Readonly<Record<string, string>>): boolean {
  const startup = startupAttributes(Object.keys(env));
  return vars.readonly.length === 0 && Object.keys(vars.arrays).length === 0
    && sameNames(vars.exported, startup.exported) && sameNames(vars.declared, startup.declared);
}

function sameNames(names: readonly string[], set: ReadonlySet<string>): boolean {
  return names.length === set.size && names.every((name) => set.has(name));
}
