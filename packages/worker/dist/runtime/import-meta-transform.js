const IMPORT_META_RESOLVE_HELPER = '__nimbusImportMetaResolveForModule';
export function importMetaDefines(absUrl) {
    return {
        'import.meta.url': JSON.stringify(absUrl),
        'import.meta.resolve': IMPORT_META_RESOLVE_HELPER,
    };
}
export function bindImportMetaResolve(source, absUrl) {
    if (!source.includes(IMPORT_META_RESOLVE_HELPER))
        return source;
    return [
        `const ${IMPORT_META_RESOLVE_HELPER} = (specifier) => globalThis.__nimbusImportMetaResolve(specifier, ${JSON.stringify(absUrl)});`,
        source,
    ].join('\n');
}
