import { JSONStringify, SafeList, stringCharCodeAt, stringLastIndexOf, stringSlice, stringStartsWith } from './primordials.js';
/** A module's directory and extension determine its resolution/lowering; its basename does not. */
export function runtimeModuleScope(path) {
    if (stringStartsWith(path, 'data:'))
        return ['data:', '.mjs'];
    let at = 0;
    while (at < path.length && stringCharCodeAt(path, at) === 0x2f)
        at++;
    const p = stringSlice(path, at);
    const slash = stringLastIndexOf(p, '/');
    const base = stringSlice(p, slash + 1);
    const dot = stringLastIndexOf(base, '.');
    return [slash < 0 ? '' : stringSlice(p, 0, slash), dot > 0 ? stringSlice(base, dot) : ''];
}
/** `items` as a list that inherits nothing. */
function listOf(items) {
    const out = new SafeList();
    for (let i = 0; i < items.length; i++)
        out[i] = items[i];
    return out;
}
/** Both sides hash the same source, with a module's import/lowering scope. */
export function runtimeCodeKeySource(entry) {
    if (entry.kind === 'module') {
        const scope = runtimeModuleScope(entry.path);
        return JSONStringify(listOf(['module', scope[0], scope[1], entry.text]));
    }
    if (entry.kind === 'expression')
        return JSONStringify(listOf(['expression', entry.code]));
    if (entry.kind === 'wasm')
        return JSONStringify(listOf(['wasm', entry.bytes]));
    return JSONStringify(listOf([entry.kind, listOf(entry.params), entry.body]));
}
/** Text, the retained path, and bounded bookkeeping overhead; data URLs hold the source twice. */
export function runtimeCodeSourceCharge(source, entry) {
    return source.length + (entry.kind === 'module' ? entry.path.length : 0) + 512;
}
