#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCfGitPatched } from '../../packages/worker/scripts/cf-git-patch.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const root = mkdtempSync(join(tmpdir(), 'install-source-free-'));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  for (const dir of ['scripts', 'packages/worker/scripts', 'packages/worker/patches', 'packages/worker/src', 'packages/worker/public/_assets/runtime']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(join(REPO, 'scripts/install-deps.mjs'), join(root, 'scripts/install-deps.mjs'));
  for (const file of ['patch-install-deps.mjs', 'cf-git-patch.mjs']) {
    copyFileSync(join(REPO, 'packages/worker/scripts', file), join(root, 'packages/worker/scripts', file));
  }
  copyFileSync(join(REPO, 'packages/worker/patches/@ashishkumar472+cf-git+1.0.5.patch'), join(root, 'packages/worker/patches/@ashishkumar472+cf-git+1.0.5.patch'));
  const lifecycle = "node -e \"require('fs').writeFileSync('source-derived.js','a lifecycle script read source')\"";
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'install-fixture', private: true,
    dependencies: { 'isomorphic-git': 'npm:@ashishkumar472/cf-git@1.0.5' },
    scripts: { preinstall: lifecycle, postinstall: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts.postinstall },
  }));
  copyFileSync(join(REPO, 'bunfig.toml'), join(root, 'bunfig.toml'));
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'packages/worker/src/changed.ts'), 'source differs from its recorded bundle\n');
  writeFileSync(join(root, 'packages/worker/public/_assets/runtime/oxc-facet-old.js'), 'the committed old artifact\n');
  run(process.execPath, ['install', '--ignore-scripts']);
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  run('git', ['init', '-q']);
  run('git', ['add', '-A']);
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'stale source with locked dependencies']);

  run(process.execPath, ['scripts/install-deps.mjs']);
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all']), '', 'installation leaves a clean checkout even with stale source-derived assets');
  assertCfGitPatched(root);
  assert.equal(readFileSync(join(root, 'packages/worker/public/_assets/runtime/oxc-facet-old.js'), 'utf8'), 'the committed old artifact\n');

  writeFileSync(join(root, 'packages/worker/src/changed.ts'), 'an unrelated new source revision\n');
  run('git', ['add', '-A']);
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'source changes independently of dependencies']);
  run(process.execPath, ['scripts/install-deps.mjs']);
  run(process.execPath, ['run', 'postinstall']);
  assertCfGitPatched(root);
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all']), '', 'the installer and patch-only root hook do not build either source revision');

  const locked = readFileSync(join(root, 'bun.lock'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  delete manifest.dependencies['isomorphic-git'];
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  const refused = spawnSync(process.execPath, ['scripts/install-deps.mjs'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'a changed manifest cannot silently replace the frozen lockfile');
  assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8'), locked);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('install-source-free OK');
