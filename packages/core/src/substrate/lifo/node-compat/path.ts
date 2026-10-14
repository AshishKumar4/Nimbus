import realm from 'node:process';
import type { PlatformPath } from 'node:path';

// The engine's own path (X-3). What does not depend on a working directory is
// the engine's as it is; the module a program requires is createPath's.
export * from 'node:path';
export { default } from 'node:path';

/**
 * The engine's path against the program's working directory: resolve and
 * relative start from `cwd`, as Node's start from process.cwd(), the
 * engine's own process's, which is not the program's.
 */
export function createPath(cwd: string): PlatformPath {
  const engine = realm.getBuiltinModule('node:path');
  const against = (platform: PlatformPath): PlatformPath => ({
    ...platform,
    resolve: (...paths: string[]) => platform.resolve(cwd, ...paths),
    relative: (from: string, to: string) => platform.relative(platform.resolve(cwd, from), platform.resolve(cwd, to)),
  });
  const posix = against(engine.posix);
  const win32 = against(engine.win32);
  // Each platform's posix and win32 are these, as Node's are one another.
  Object.assign(posix, { posix, win32 });
  Object.assign(win32, { posix, win32 });
  return posix;
}
