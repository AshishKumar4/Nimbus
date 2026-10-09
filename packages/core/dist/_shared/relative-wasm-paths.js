/**
 * Wasm images named beside a JavaScript module, by a quoted relative path.
 * Shared by the launch's image collector and import()'s late read-ahead.
 * Self-contained because the guest receives this function as source.
 */
export function relativeWasmPaths(source, filename) {
    const literals = /["'`]((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)*\.wasm)["'`]/g;
    const dir = filename.replace(/^\/+/, '').split('/').slice(0, -1);
    const paths = new Set();
    for (const match of source.matchAll(literals)) {
        const segments = [...dir];
        for (const segment of match[1].split('/')) {
            if (segment === '..')
                segments.pop();
            else if (segment !== '.')
                segments.push(segment);
        }
        paths.add(segments.join('/'));
    }
    return [...paths];
}
