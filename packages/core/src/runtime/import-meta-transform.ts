const IMPORT_META_RESOLVE_HELPER = '__nimbusImportMetaResolveForModule';
export const MODULE_URL_EXPRESSION = 'module.__nimbusModuleUrl';
export const MODULE_RESOLVE_EXPRESSION = 'module.__nimbusImportMetaResolve';

// Entry scripts have a fixed URL. Reusable module cells receive evaluation
// metadata from __loadModule, without changing CommonJS's five arguments.
export function importMetaDefines(absUrl: string, moduleFactory = false): Record<string, string> {
  return {
    'import.meta.url': moduleFactory ? MODULE_URL_EXPRESSION : JSON.stringify(absUrl),
    'import.meta.resolve': moduleFactory ? MODULE_RESOLVE_EXPRESSION : IMPORT_META_RESOLVE_HELPER,
  };
}

export function bindImportMetaResolve(source: string, absUrl: string): string {
  if (!source.includes(IMPORT_META_RESOLVE_HELPER)) return source;
  return [
    `const ${IMPORT_META_RESOLVE_HELPER} = (specifier) => globalThis.__nimbusImportMetaResolve(specifier, ${JSON.stringify(absUrl)});`,
    source,
  ].join('\n');
}
