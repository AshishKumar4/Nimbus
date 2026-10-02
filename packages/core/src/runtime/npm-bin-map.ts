/**
 * A package's `bin` field as npm installs it (npm-normalize-package-bin).
 *
 * A `bin` map comes from a registry, an installed package.json or a bin
 * manifest: files and answers anyone may write. Every name a command is
 * linked, written, listed or removed under, and every target it runs, goes
 * through here, so no `bin` map reaches a file outside the bin directory or
 * runs one outside its package.
 */

/**
 * The name a `bin` key links under: its last path component, with `\` and
 * `:` read as separators. Null for a key that names nothing ('', '.', '..').
 */
export function npmBinName(key: string): string | null {
  const base = key.replace(/[\\:]/g, '/').split('/').filter(Boolean).pop() ?? '';
  return base === '.' || base === '..' || base === '' ? null : base;
}

/**
 * Name -> target relative to the package. A string `bin` links under the
 * package's own name (none without one), each key under {@link npmBinName}, and each target is
 * a path inside the package, `..` stopping at its root (`\\` read as `/`).
 * A plain relative path, such as a staged-artifact sentinel, is unchanged.
 */
export function npmBinMap(packageName: string, bin: unknown): Map<string, string> {
  const out = new Map<string, string>();
  // An array names each target under its own last component.
  const fields: [string, unknown][] = typeof bin === 'string' ? [[packageName, bin]]
    : Array.isArray(bin) ? bin.map((target): [string, unknown] => [typeof target === 'string' ? target : '', target])
    : bin !== null && typeof bin === 'object' ? Object.entries(bin) : [];
  for (const [key, target] of fields) {
    const name = npmBinName(key);
    if (name === null || typeof target !== 'string') continue;
    const inside = withinPackage(target);
    if (inside !== null) out.set(name, inside);
  }
  return out;
}

/** `path.posix.join('/', target)` without its leading slash, as npm takes a target; null for the package root itself. */
function withinPackage(target: string): string | null {
  const slashed = target.replace(/\\/g, '/');
  const out: string[] = [];
  for (const segment of slashed.split('/')) {
    if (segment === '..') out.pop();
    else if (segment !== '.' && segment !== '') out.push(segment);
  }
  if (out.length === 0) return null;
  return out.join('/') + (slashed.endsWith('/') ? '/' : '');
}
