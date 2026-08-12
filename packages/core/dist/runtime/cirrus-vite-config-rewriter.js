import { rewriteJavaScriptModuleSource } from './module-source-rewriter.js';
export function rewriteCirrusViteConfigBundle(source) {
    return rewriteJavaScriptModuleSource(source, {
        staticSpecifier: cirrusStaticSpecifier,
        dynamicImport: cirrusDynamicImport,
        createRequireCallee: '(globalThis.__cirrusNodeCreateRequire || createRequire)',
    });
}
function cirrusStaticSpecifier(specifier) {
    if (specifier === 'vite' || specifier.startsWith('vite/'))
        return './vite-config-helper.js';
    if (specifier === '@vitejs/plugin-react' || specifier.startsWith('@vitejs/plugin-react/')) {
        return './cirrus-plugin-react.js';
    }
    if (specifier === 'node:fs')
        return './cirrus-fs.js';
    if (specifier === 'node:fs/promises')
        return './cirrus-fs-promises.js';
    return undefined;
}
function cirrusDynamicImport(specifier) {
    const literal = JSON.stringify(specifier);
    return `Promise.resolve().then(() => {` +
        ` const m = globalThis.__cirrusRealUserspaceRequire?.(${literal});` +
        ` if (!m) throw new Error('[cirrus-real] dynamic import failed for ' + ${literal});` +
        ` return { default: m.default ?? m, ...(typeof m === 'object' ? m : {}) };` +
        ` })`;
}
