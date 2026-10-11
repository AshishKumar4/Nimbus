import { cloneArrays } from './variables.js';
/** A shell's state at `cwd`, its variables `env` (PWD set), nothing else defined. */
export function createShellState(env, cwd, jobTable) {
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
export function forkShellState(parent) {
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
function withCwd(state, cwd) {
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
export function snapshotShellState(state) {
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
export function restoreShellState(state, frame) {
    for (const key of Object.keys(state.env))
        delete state.env[key];
    Object.assign(state.env, frame.env);
    state.setCwd(frame.cwd);
    replaceMap(state.arrays, frame.arrays);
    Object.assign(state.options, frame.options);
    for (const [signal] of Array.from(state.traps.entries()))
        state.traps.delete(signal);
    for (const [signal, action] of frame.traps)
        state.traps.set(signal, action);
    state.readonlyNames.clear();
    for (const name of frame.readonlyNames)
        state.readonlyNames.add(name);
    replaceMap(state.aliases, frame.aliases);
}
function replaceMap(target, source) {
    target.clear();
    for (const [key, value] of source)
        target.set(key, value);
}
