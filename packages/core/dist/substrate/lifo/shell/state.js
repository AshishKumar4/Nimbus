import { assignVariable, cloneArrays, cloneEnv, isShellParameter } from './variables.js';
/**
 * The marks a shell starts with over variables named `names` (its
 * environment's), as bash's: each exported (a shell parameter kept among
 * them, `#` or `1`, is none), and PWD and OLDPWD exported too, OLDPWD
 * declared where it has no value.
 */
export function startupAttributes(names) {
    const exported = new Set([...names].filter((name) => !isShellParameter(name)));
    const declared = new Set();
    if (!exported.has('OLDPWD'))
        declared.add('OLDPWD');
    exported.add('PWD');
    exported.add('OLDPWD');
    return { exported, declared };
}
/** startupAttributes as VariableAttributes: what a saved state without its attributes restores to. */
export function startupVariableAttributes(names) {
    const { exported, declared } = startupAttributes(names);
    return { exported: [...exported].sort(), readonly: [], declared: [...declared].sort(), arrays: {} };
}
/** A shell's state at `cwd`, its variables `env` (PWD set), nothing else defined. */
export function createShellState(env, cwd, jobTable) {
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
export function forkShellState(parent) {
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
function withCwd(state, cwd) {
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
export function snapshotShellState(state) {
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
    state.exportedNames.clear();
    for (const name of frame.exportedNames)
        state.exportedNames.add(name);
    state.declaredNames.clear();
    for (const name of frame.declaredNames)
        state.declaredNames.add(name);
    replaceMap(state.aliases, frame.aliases);
}
function replaceMap(target, source) {
    target.clear();
    for (const [key, value] of source)
        target.set(key, value);
}
