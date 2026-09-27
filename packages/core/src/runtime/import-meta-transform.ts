const IMPORT_META_RESOLVE_HELPER = '__nimbusImportMetaResolveForModule';

// Entry scripts have a fixed URL. Reusable module cells receive evaluation
// metadata from __loadModule, without changing CommonJS's five arguments.
export function importMetaDefines(absUrl: string, moduleFactory = false): Record<string, string> {
  // The facet parser rewrites actual MetaProperty nodes for reusable cells.
  // Never mark arbitrary user properties by a reserved-looking spelling.
  if (moduleFactory) return {};
  return {
    'import.meta.url': JSON.stringify(absUrl),
    'import.meta.resolve': IMPORT_META_RESOLVE_HELPER,
  };
}

export function bindImportMetaResolve(source: string, absUrl: string): string {
  if (!source.includes(IMPORT_META_RESOLVE_HELPER)) return source;
  return [
    `const ${IMPORT_META_RESOLVE_HELPER} = (specifier) => globalThis.__nimbusImportMetaResolve(specifier, ${JSON.stringify(absUrl)});`,
    source,
  ].join('\n');
}
