import { rootClampedSegments } from '@nimbus-sh/platform/lexical-path.js';
/**
 * Wasm images named beside a JavaScript module, by a quoted relative path.
 * Shared by the launch's image collector and import()'s late read-ahead.
 * The node shims declare it from its compiled bundle.
 */
export function relativeWasmPaths(source, filename) {
    const literals = /["'`]((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)*\.wasm)["'`]/g;
    const dir = filename.slice(0, filename.lastIndexOf('/') + 1);
    const paths = new Set();
    for (const match of source.matchAll(literals))
        paths.add(rootClampedSegments(dir + match[1]).join('/'));
    return [...paths];
}
