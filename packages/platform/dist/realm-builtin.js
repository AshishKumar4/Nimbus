export function realmBuiltin(id) {
    try {
        const global = globalThis;
        const current = global.process;
        const own = (current && global[Symbol.for('nimbus.fronts')]?.get(current)?.own);
        return (own ?? current)?.getBuiltinModule?.(id);
    }
    catch {
        return undefined;
    }
}
