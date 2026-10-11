/**
 * Wasm images named beside a JavaScript module, by a quoted relative path.
 * Shared by the launch's image collector and import()'s late read-ahead.
 * Self-contained: the node shims declare it from its compiled bundle.
 */
export function relativeWasmPaths(source: string, filename: string): string[] {
  const literals = /["'`]((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)*\.wasm)["'`]/g;
  const dir = filename.replace(/^\/+/, '').split('/').slice(0, -1);
  const paths = new Set<string>();
  for (const match of source.matchAll(literals)) {
    const segments = [...dir];
    for (const segment of match[1]!.split('/')) {
      if (segment === '..') segments.pop();
      else if (segment !== '.') segments.push(segment);
    }
    paths.add(segments.join('/'));
  }
  return [...paths];
}
