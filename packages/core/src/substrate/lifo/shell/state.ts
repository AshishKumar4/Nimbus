/**
 * state.ts — a shell's own state: what its builtins read and change, and
 * what a child shell gets a copy of. The interactive shell (Shell.ts) holds
 * the first; each child shell (a subshell, pipeline element, `$( )` or
 * background job: interpreter.ts fork) its own; a builtin acts on the state
 * of the shell that runs it (BuiltinExecutionContext.shell).
 */
import type { JobTable } from './jobs.js';
import { cloneArrays } from './variables.js';

export interface ShellOptions {
  errexit: boolean;
  nounset: boolean;
  pipefail: boolean;
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
  /** Move the shell, and PWD with it. */
  setCwd(cwd: string): void;
  readonly options: ShellOptions;
  readonly traps: TrapTable;
  readonly readonlyNames: Set<string>;
  readonly aliases: Map<string, string>;
  readonly jobTable: JobTable;
}

/** A shell's state at `cwd`, its variables `env` (PWD set), nothing else defined. */
export function createShellState(env: Record<string, string>, cwd: string, jobTable: JobTable): ShellState {
  return withCwd({
    env: { ...env, PWD: cwd },
    arrays: new Map(),
    options: { errexit: false, nounset: false, pipefail: false },
    traps: new Map(),
    readonlyNames: new Set(),
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
    env: { ...parent.env },
    arrays: cloneArrays(parent.arrays),
    options: { ...parent.options },
    traps: new Map(Array.from(parent.traps.entries()).filter(([, action]) => action === '')),
    readonlyNames: new Set(parent.readonlyNames),
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
      state.env.PWD = next;
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
  readonly aliases: Map<string, string>;
}

export function snapshotShellState(state: ShellState): ShellStateFrame {
  return {
    cwd: state.getCwd(),
    env: { ...state.env },
    arrays: cloneArrays(state.arrays),
    options: { ...state.options },
    traps: new Map(state.traps.entries()),
    readonlyNames: new Set(state.readonlyNames),
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
  replaceMap(state.aliases, frame.aliases);
}

function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}
