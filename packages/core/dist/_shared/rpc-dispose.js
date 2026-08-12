export function disposeRpcResource(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return false;
    const disposerKey = Symbol.dispose;
    if (!disposerKey)
        return false;
    const disposer = Reflect.get(value, disposerKey);
    if (typeof disposer !== 'function')
        return false;
    try {
        Reflect.apply(disposer, value, []);
        return true;
    }
    catch {
        return false;
    }
}
export function disposeRpcResources(values) {
    for (const value of values)
        disposeRpcResource(value);
}
export async function useRpcResource(promise, use) {
    const value = await promise;
    try {
        return await use(value);
    }
    finally {
        disposeRpcResource(value);
    }
}
