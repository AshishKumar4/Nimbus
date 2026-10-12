/**
 * npm's package-lock.json / npm-shrinkwrap.json (lockfileVersion 2 and 3),
 * read for `npm ci`: the `packages` map keyed by install path.
 */

/** A parsed JSON object or array: a value whose fields can be read and set. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export interface PackageLockEntry {
  name?: unknown;
  version?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  link?: unknown;
  dev?: unknown;
  optional?: unknown;
  devOptional?: unknown;
  peer?: unknown;
  extraneous?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
  bundleDependencies?: unknown;
  bin?: unknown;
  os?: unknown;
  cpu?: unknown;
  libc?: unknown;
}

export interface PackageLock {
  lockfileVersion: number;
  packages: Record<string, PackageLockEntry>;
}

export function parsePackageLock(text: string, lockName: string): PackageLock {
  const lock = JSON.parse(text) as { lockfileVersion?: unknown; packages?: unknown };
  const version = typeof lock.lockfileVersion === 'number' ? lock.lockfileVersion : 0;
  if (version < 2 || lock.packages === null || typeof lock.packages !== 'object') {
    throw new Error(
      `${lockName} has lockfileVersion ${version || 'unknown'}; \`npm ci\` here reads lockfileVersion 2 or 3. ` +
      'Run `npm install` with npm 7 or newer to upgrade it.',
    );
  }
  return { lockfileVersion: version, packages: lock.packages as Record<string, PackageLockEntry> };
}

export function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [key, v] of Object.entries(value)) if (typeof v === 'string') out[key] = v;
  return out;
}

export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}
