import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const destination = mkdtempSync(join(tmpdir(), 'nimbus-library-consumer-'));
console.log(`PACKED_CONSUMER=${destination}`);
const packages = ['platform', 'core', 'fabric', 'worker'];
const rootPackage = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const workerPackage = JSON.parse(readFileSync(join(repo, 'packages/worker/package.json'), 'utf8'));
const dependencies = {
  typescript: rootPackage.devDependencies.typescript,
  '@cloudflare/workers-types': rootPackage.devDependencies['@cloudflare/workers-types'],
  wrangler: rootPackage.devDependencies.wrangler,
  zod: workerPackage.dependencies.zod,
};

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

for (const name of packages) {
  const packageDir = join(repo, 'packages', name);
  const archive = join(destination, `${name}.tgz`);
  run('bun', ['pm', 'pack', '--ignore-scripts', '--filename', archive, '--quiet'], packageDir);
  assert.ok(existsSync(archive), `missing packed ${name}`);
  dependencies[`@nimbus-sh/${name}`] = `file:./${name}.tgz`;
}

writeFileSync(join(destination, 'package.json'), JSON.stringify({
  name: 'nimbus-library-consumer-proof',
  private: true,
  type: 'module',
  dependencies,
  overrides: Object.fromEntries(packages.map((name) => [`@nimbus-sh/${name}`, dependencies[`@nimbus-sh/${name}`]])),
}, null, 2));
cpSync(join(repo, 'tests/fixtures/library-host/index.ts'), join(destination, 'index.ts'));
cpSync(join(repo, 'tests/fixtures/library-host/wrangler.jsonc'), join(destination, 'wrangler.jsonc'));
writeFileSync(join(destination, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    strict: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2022'],
    types: ['@cloudflare/workers-types'],
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['index.ts'],
}, null, 2));

process.stdout.write(run('bun', ['install', '--ignore-scripts'], destination));
for (const name of packages) {
  const manifest = join(destination, 'node_modules', '@nimbus-sh', name, 'package.json');
  assert.ok(realpathSync(manifest).startsWith(destination), `${name} resolves back into the source checkout`);
  const packed = JSON.parse(readFileSync(manifest, 'utf8'));
  const checkTarget = (target) => {
    if (typeof target === 'string') {
      if (!target.startsWith('./') || target.includes('*')) return;
      assert.ok(existsSync(join(dirname(manifest), target)), `${packed.name}: export target ${target} is missing`);
    } else if (target !== null && typeof target === 'object') {
      for (const [condition, value] of Object.entries(target)) {
        if (condition !== 'workspace') checkTarget(value);
      }
    }
  };
  checkTarget(packed.exports);
}

process.stdout.write(run('bun', ['run', 'tsc', '--project', 'tsconfig.json'], destination));
process.stdout.write(run('bun', ['run', 'wrangler', 'deploy', '--dry-run', '--outdir', 'build'], destination));
console.log('PASS packed public exports, consumer types and workerd build');
