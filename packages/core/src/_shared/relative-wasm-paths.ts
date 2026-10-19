import { arrayJoin, dataDescriptor, reflectDefineProperty, regExpExec, SafeList, SafeSet, stringSlice } from './primordials.js';

/**
 * Wasm images named beside a JavaScript module, by a quoted relative path.
 * Shared by the launch's image collector and import()'s late read-ahead.
 * The node shims declare it from its compiled bundle.
 */
export function relativeWasmPaths(source: string, filename: string): string[] {
  const literals = /["'`]((?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)*\.wasm)["'`]/g;
  const dir = new SafeList<string>();
  let start = 0;
  while (start < filename.length && filename[start] === '/') start++;
  for (let i = start; i < filename.length; i++) {
    if (filename[i] !== '/') continue;
    dir[dir.length] = stringSlice(filename, start, i);
    start = i + 1;
  }
  const paths = new SafeSet<string>();
  for (let match = regExpExec(literals, source); match !== null; match = regExpExec(literals, source)) {
    const segments = new SafeList<string>();
    for (let i = 0; i < dir.length; i++) segments[segments.length] = dir[i];
    const path = match[1];
    start = 0;
    for (let i = 0; i <= path.length; i++) {
      if (i < path.length && path[i] !== '/') continue;
      const segment = stringSlice(path, start, i);
      start = i + 1;
      if (segment === '..') {
        if (segments.length > 0) segments.length = segments.length - 1;
      } else if (segment !== '' && segment !== '.') segments[segments.length] = segment;
    }
    paths.add(arrayJoin(segments, '/'));
  }
  const out: string[] = [];
  paths.forEach((path) => { reflectDefineProperty(out, out.length, dataDescriptor(path, true, true, true)); });
  return out;
}
