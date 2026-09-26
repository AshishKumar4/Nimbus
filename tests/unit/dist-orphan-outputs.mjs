#!/usr/bin/env bun
// A package's dist is exactly what its src compiles to. tsc never deletes an
// output whose source is gone, so a removed module kept shipping (and a
// package's `./*.js` export kept loading it). Two guards, each checked here:
// - every package's build clears its dist first, so the build itself drops
//   an orphan: a src file is created, built, deleted and rebuilt, and its
//   outputs are gone;
// - dist-integrity refuses, naming the files, any output with no source
//   (and a versioned staged asset no generated artifact names), on every
//   path, the fixpoint record included.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILT_PACKAGES, orphanedOutputs } from '../../scripts/dist-integrity.mjs';

const repo = new URL('../../', import.meta.url).pathname;

// The build of every package clears dist before it compiles.
for (const pkg of BUILT_PACKAGES) {
  const scripts = JSON.parse(readFileSync(join(repo, 'packages', pkg, 'package.json'), 'utf8')).scripts;
  const build = scripts.build.startsWith('bun run clean:dist') ? scripts['clean:dist'] : scripts.build;
  assert.match(build, /^node \.\.\/\.\.\/scripts\/clean-dist\.mjs/, `${pkg}'s build clears its dist first`);
}

// A package built as the real ones are: create, build, delete, rebuild.
const root = mkdtempSync(join(repo, '.dist-orphan-'));
try {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(repo, 'scripts', 'clean-dist.mjs'), join(root, 'scripts', 'clean-dist.mjs'));
  const pkgDir = join(root, 'packages', 'core');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  const build = JSON.parse(readFileSync(join(repo, 'packages', 'core', 'package.json'), 'utf8')).scripts.build;
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { build } }));
  writeFileSync(join(pkgDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2022', moduleResolution: 'bundler', skipLibCheck: true }, include: ['src'] }));
  writeFileSync(join(pkgDir, 'src', 'kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(pkgDir, 'src', 'gone.ts'), 'export const gone = 1;\n');
  const tsc = join(repo, 'node_modules', '.bin');
  const run = () => execFileSync('sh', ['-c', build], { cwd: pkgDir, env: { ...process.env, PATH: `${tsc}:${process.env.PATH}` }, stdio: 'pipe' });
  run();
  assert.ok(existsSync(join(pkgDir, 'dist', 'gone.js')));
  rmSync(join(pkgDir, 'src', 'gone.ts'));

  // Before a rebuild the orphan is refused, by name.
  assert.deepEqual(orphanedOutputs({ root, packages: ['core'] }), [
    'packages/core/dist/gone.d.ts', 'packages/core/dist/gone.d.ts.map', 'packages/core/dist/gone.js',
  ]);

  // The rebuild removes it; kept.ts's outputs stay.
  run();
  assert.equal(existsSync(join(pkgDir, 'dist', 'gone.js')), false);
  assert.ok(existsSync(join(pkgDir, 'dist', 'kept.js')));
  assert.deepEqual(orphanedOutputs({ root, packages: ['core'] }), []);

  // A versioned staged asset no generated artifact names is refused too.
  const assets = join(root, 'packages', 'worker', 'public', '_assets');
  mkdirSync(join(assets, 'tool', '1.0.0'), { recursive: true });
  mkdirSync(join(assets, 'tool', '2.0.0'), { recursive: true });
  writeFileSync(join(assets, 'tool', '1.0.0', 'index.js'), '');
  writeFileSync(join(assets, 'tool', '2.0.0', 'index.js'), '');
  writeFileSync(join(assets, 'engine-0.1.0.wasm'), '');
  mkdirSync(join(root, 'packages', 'worker', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'worker', 'src', 'tool-artifact.generated.ts'), "export const PATH = '/_assets/tool/2.0.0/index.js';\n");
  assert.deepEqual(orphanedOutputs({ root, packages: [] }), [
    'packages/worker/public/_assets/engine-0.1.0.wasm',
    'packages/worker/public/_assets/tool/1.0.0/index.js',
  ]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// And the tree itself has none.
assert.deepEqual(orphanedOutputs(), []);
console.log('dist-orphan-outputs: ok');
