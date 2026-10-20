/**
 * state.ts — a shell's own state: what its builtins read and change, and
 * what a child shell gets a copy of. The interactive shell (Shell.ts) holds
 * the first; each child shell (a subshell, pipeline element, `$( )` or
 * background job: interpreter.ts fork) its own; a builtin acts on the state
 * of the shell that runs it (BuiltinExecutionContext.shell).
 */
import type { JobTable } from './jobs.js';
import { assignVariable, cloneArrays, cloneEnv, isShellParameter, type VariableAttributes } from './variables.js';

export interface ShellOptions {
  errexit: boolean;
  nounset: boolean;
  pipefail: boolean;
  /** bash's POSIX mode (`sh`, `--posix`, `set -o posix`): a script ends at a special builtin's own failure. */
  posix: boolean;
}

export interface TrapTable {
  get(signal: string): string | undefined;
  set(signal: string, action: string): void;
  delete(signal: string): void;
  entries(): IterableIterator<[string, string]>;
}

export interface ShellState {
  readonly env: Record<string, string>;
  /**
   * Indexed arrays; `env` holds the scalars. A name lives in exactly one of
   * them, so `$arr` and `${arr[0]}` cannot disagree, and only `unset` moves a
   * name from one to the other.
   */
  readonly arrays: Map<string, (string | undefined)[]>;
  getCwd(): string;
  /** Move the shell, and PWD with it as an assignment would; false where PWD is readonly and kept its value. */
  setCwd(cwd: string): boolean;
  readonly options: ShellOptions;
  readonly traps: TrapTable;
  readonly readonlyNames: Set<string>;
  /** The variables with the export attribute: what came in the environment, and what `export` or `declare -x` marked. */
  readonly exportedNames: Set<string>;
  /** Variables declared with no value (`declare p`, `export p`): set or not, they exist until unset. */
  readonly declaredNames: Set<string>;
  readonly aliases: Map<string, string>;
  readonly jobTable: JobTable;
}

/**
 * The marks a shell starts with over variables named `names` (its
 * environment's), as bash's: each exported (a shell parameter kept among
 * them, `#` or `1`, is none), and PWD and OLDPWD exported too, OLDPWD
 * declared where it has no value.
 */
export function startupAttributes(names: Iterable<string>): { readonly exported: ReadonlySet<string>; readonly declared: ReadonlySet<string> } {
  const exported = new Set([...names].filter((name) => !isShellParameter(name)));
  const declared = new Set<string>();
  if (!exported.has('OLDPWD')) declared.add('OLDPWD');
  exported.add('PWD');
  exported.add('OLDPWD');
  return { exported, declared };
}

/** startupAttributes as VariableAttributes: what a saved state without its attributes restores to. */
export function startupVariableAttributes(names: Iterable<string>): VariableAttributes {
  const { exported, declared } = startupAttributes(names);
  return { exported: [...exported].sort(), readonly: [], declared: [...declared].sort(), arrays: {} };
}

/** A shell's state at `cwd`, its variables `env` (PWD set), nothing else defined. */
export function createShellState(env: Record<string, string>, cwd: string, jobTable: JobTable): ShellState {
  const shellEnv = cloneEnv(env);
  shellEnv.PWD = cwd;
  const startup = startupAttributes(Object.keys(env));
  return withCwd({
    env: shellEnv,
    arrays: new Map(),
    options: { errexit: false, nounset: false, pipefail: false, posix: false },
    traps: new Map(),
    readonlyNames: new Set(),
    exportedNames: new Set(startup.exported),
    declaredNames: new Set(startup.declared),
    aliases: new Map(),
    jobTable,
  }, cwd);
}

/**
 * A child shell's state, as fork(2) makes one: its own copy of every part of
 * `parent`, so nothing it changes reaches `parent`. Traps reset to the
 * default, except ignored ones; jobs are the child's own.
 */
export function forkShellState(parent: ShellState): ShellState {
  return withCwd({
    env: cloneEnv(parent.env),
    arrays: cloneArrays(parent.arrays),
    options: { ...parent.options },
    traps: new Map(Array.from(parent.traps.entries()).filter(([, action]) => action === '')),
    readonlyNames: new Set(parent.readonlyNames),
    exportedNames: new Set(parent.exportedNames),
    declaredNames: new Set(parent.declaredNames),
    aliases: new Map(parent.aliases),
    jobTable: parent.jobTable.fork(),
  }, parent.getCwd());
}

function withCwd(state: Omit<ShellState, 'getCwd' | 'setCwd'>, cwd: string): ShellState {
  let current = cwd;
  return {
    ...state,
    getCwd: () => current,
    setCwd: (next) => {
      current = next;
      return assignVariable(state, 'PWD', next);
    },
  };
}

/** A shell's state as it was, for restoreShellState: a copy of every part but its jobs. */
export interface ShellStateFrame {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly arrays: Map<string, (string | undefined)[]>;
  readonly options: ShellOptions;
  readonly traps: Map<string, string>;
  readonly readonlyNames: Set<string>;
  readonly exportedNames: Set<string>;
  readonly declaredNames: Set<string>;
  readonly aliases: Map<string, string>;
}

export function snapshotShellState(state: ShellState): ShellStateFrame {
  return {
    cwd: state.getCwd(),
    env: cloneEnv(state.env),
    arrays: cloneArrays(state.arrays),
    options: { ...state.options },
    traps: new Map(state.traps.entries()),
    readonlyNames: new Set(state.readonlyNames),
    exportedNames: new Set(state.exportedNames),
    declaredNames: new Set(state.declaredNames),
    aliases: new Map(state.aliases),
  };
}

/** Put `state` back as `frame` holds it, in place: whatever holds its parts sees them restored. */
export function restoreShellState(state: ShellState, frame: ShellStateFrame): void {
  for (const key of Object.keys(state.env)) delete state.env[key];
  Object.assign(state.env, frame.env);
  state.setCwd(frame.cwd);
  replaceMap(state.arrays, frame.arrays);
  Object.assign(state.options, frame.options);
  for (const [signal] of Array.from(state.traps.entries())) state.traps.delete(signal);
  for (const [signal, action] of frame.traps) state.traps.set(signal, action);
  state.readonlyNames.clear();
  for (const name of frame.readonlyNames) state.readonlyNames.add(name);
  state.exportedNames.clear();
  for (const name of frame.exportedNames) state.exportedNames.add(name);
  state.declaredNames.clear();
  for (const name of frame.declaredNames) state.declaredNames.add(name);
  replaceMap(state.aliases, frame.aliases);
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
