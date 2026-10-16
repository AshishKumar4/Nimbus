/**
 * runtime/script-path.ts — the script a runtime's command line names, found
 * as `node`, `bun` and the portable node all find it: `.` its package's
 * entry, else the path, then its extensions.
 */
import { normalizeVfsPath, resolveVfsPath } from '../vfs/path.js';

/** Extensions probed when a target names no exact file, in Node's order. */
const SCRIPT_RESOLUTION_CANDIDATES = ['.js', '.ts', '.tsx', '.mjs', '.jsx', '/index.js', '/index.ts'];

/** The VFS surface script resolution needs. */
export interface ScriptResolutionFs {
  isFile(path: string): boolean | Promise<boolean>;
  readFileString(path: string): string | Promise<string>;
}

/**
 * Resolve a runtime target — `./cli.ts`, `sub/x`, `.`, or a bare name — to a
 * canonical VFS key, or null when nothing runnable sits there.
 *
 * A directory never resolves to itself: it falls through to the index
 * candidates, so `bun ./tools` finds `tools/index.js` the way real bun does
 * rather than trying to read the directory as source.
 */
export async function resolveRuntimeScriptPath(
  fs: ScriptResolutionFs,
  cwd: string,
  target: string,
  opts?: { preferModuleField?: boolean },
): Promise<string | null> {
  const base = normalizeVfsPath(cwd || '/home/user');
  let resolved: string;
  if (target === '.' || target === './') {
    // `node .` / `bun .` — the package's declared entry point.
    let main = 'index.js';
    try {
      const pkg = JSON.parse(await fs.readFileString(`${base}/package.json`));
      main = (opts?.preferModuleField ? pkg.module : undefined) || pkg.main || 'index.js';
    } catch { /* no readable package.json — index.js */ }
    resolved = resolveVfsPath(main, base);
  } else {
    resolved = resolveVfsPath(target, base);
  }
  if (await fs.isFile(resolved)) return resolved;
  for (const candidate of SCRIPT_RESOLUTION_CANDIDATES) {
    if (await fs.isFile(resolved + candidate)) return resolved + candidate;
  }
  return null;
}
