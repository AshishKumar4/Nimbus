import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_CPU_SOURCES } from './cpu-sources.mjs';
import { benchmarkSource } from './paired-runner.mjs';

const source = benchmarkSource(CORE_CPU_SOURCES.source);
const measured = new Set(CORE_CPU_SOURCES.files);
const directories = new Set(CORE_CPU_SOURCES.files.map(dirname));
const prefix = '.bench-core-';

/** Each arm owns its measured modules and JIT state; only unmeasured sources are shared. */
export async function loadIsolatedCore(from, cleanup) {
  const fixture = mkdtempSync(join(source, prefix));
  cleanup(() => rmSync(fixture, { recursive: true, force: true }));
  for (const entry of readdirSync(source)) {
    if (entry.startsWith(prefix)) continue;
    if (!directories.has(entry)) { symlinkSync(join(source, entry), join(fixture, entry)); continue; }
    mkdirSync(join(fixture, entry));
    for (const file of readdirSync(join(source, entry))) {
      const relative = join(entry, file);
      const target = join(fixture, relative);
      if (measured.has(relative)) copyFileSync(join(from, relative), target);
      else symlinkSync(join(source, relative), target);
    }
  }
  const at = (path) => import(pathToFileURL(join(fixture, path)).href);
  const [{ SqliteVFS }, { CompositeVFS }, { sqliteFiles, SqliteFiles }, { ProcessFiles }, { normalizeVfsPath }] = await Promise.all(
    ['vfs/sqlite-vfs.ts', 'vfs/composite.ts', 'vfs/sqlite-files.ts', 'runtime/process-files.ts', 'vfs/path.ts'].map(at));
  return { SqliteVFS, CompositeVFS, sqliteFiles, SqliteFiles, ProcessFiles, normalizeVfsPath };
}
