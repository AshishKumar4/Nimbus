import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchmarkSource } from './paired-runner.mjs';

const prefix = '.bench-core-';

/** Each arm owns its measured modules and JIT state; only unmeasured sources are shared. */
export async function loadIsolatedCore(from, cleanup, { sources, modules }) {
  const source = benchmarkSource(sources.source);
  const measured = new Set(sources.files);
  const trees = new Set(sources.directories);
  const directories = new Set();
  for (const path of [...measured, ...trees]) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) directories.add(parent);
  }
  const fixture = mkdtempSync(join(source, prefix));
  cleanup(() => rmSync(fixture, { recursive: true, force: true }));
  const all = sources.files === undefined && sources.directories === undefined;
  const fill = (parent = '') => {
    const entries = new Set([source, from].flatMap((root) => existsSync(join(root, parent)) ? readdirSync(join(root, parent)) : []));
    for (const entry of entries) {
      if (parent === '' && entry.startsWith(prefix)) continue;
      const relative = join(parent, entry);
      const target = join(fixture, relative);
      if (all || trees.has(relative)) {
        if (existsSync(join(from, relative))) cpSync(join(from, relative), target, { recursive: true });
      } else if (measured.has(relative)) copyFileSync(join(from, relative), target);
      else if (directories.has(relative)) { mkdirSync(target); fill(relative); }
      else if (existsSync(join(source, relative))) symlinkSync(join(source, relative), target);
    }
  };
  fill();
  const at = (path) => import(pathToFileURL(join(fixture, path)).href);
  return Object.fromEntries(await Promise.all(modules.map(async (path) => [path, await at(path)])));
}
