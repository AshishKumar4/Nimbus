import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function publishPackages(root, commit) {
  const git = (args) => {
    const done = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (done.status !== 0) throw new Error(done.stderr.trim());
    return done.stdout.trim();
  };
  const dirs = commit ? git(['ls-tree', '-d', '--name-only', `${commit}:packages`]).split('\n')
    : readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const packages = dirs.map((name) => {
      const dir = join(root, 'packages', name);
      try { return { dir, ...JSON.parse(commit ? git(['show', `${commit}:packages/${name}/package.json`]) : readFileSync(join(dir, 'package.json'), 'utf8')) }; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    })
    .filter((pkg) => pkg && !pkg.private && pkg.publishConfig?.access === 'public'
      && (pkg.name.startsWith('@nimbus-sh/') || pkg.name === 'create-nimbus-app'));
  const names = new Set(packages.map((pkg) => pkg.name));
  const ordered = [];
  const done = new Set();
  while (ordered.length < packages.length) {
    const next = packages.find((pkg) => !done.has(pkg.name)
      && Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).every((dep) => !names.has(dep) || done.has(dep)));
    if (!next) throw new Error('published Nimbus packages contain a dependency cycle');
    done.add(next.name);
    ordered.push(next);
  }
  return ordered;
}
