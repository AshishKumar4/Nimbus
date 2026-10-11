#!/usr/bin/env bun
// Run on CI: rebuild the pinned upstream source, then stage it with the same
// checked-in recipe a normal worker build uses. Return tracked asset changes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!out) throw new Error('--out is required');
const repo = process.cwd();
const run = (command, args, cwd = repo, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 29 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  process.stderr.write(result.stdout + result.stderr);
  return result.stdout.trim();
};
const scratch = mkdtempSync(join(tmpdir(), 'nimbus-opencode-build-'));
const upstream = join(scratch, 'source');
run('git', ['clone', '--depth', '1', '--branch', 'v1.16.2', 'https://github.com/sst/opencode', upstream]);
const sourceCommit = run('git', ['rev-parse', 'HEAD'], upstream);
if (sourceCommit !== '76c631d198f9ff620e15468e45f3457d50481b57') throw new Error('OpenCode v1.16.2 source changed');
run('bun', ['install', '--ignore-scripts', '--linker=hoisted'], upstream);
const recipe = join(repo, 'packages/worker/scripts/opencode');
for (const patch of ['nimbus-defer-global-io.patch', 'nimbus-tree-sitter-exports.patch']) run('git', ['apply', join(recipe, patch)], upstream);
const packageRoot = join(upstream, 'packages/opencode');
for (const file of ['build-node.ts', 'bundle-patches.ts']) copyFileSync(join(recipe, file), join(packageRoot, file));
for (const file of readdirSync(join(recipe, 'stubs'))) copyFileSync(join(recipe, 'stubs', file), join(packageRoot, file));

// Reuse the committed catalog snapshot, not whichever catalog models.dev
// happens to serve today. Its single literal is inside ModelsDev's sync thunk.
const assetRoot = join(repo, 'packages/worker/public/_assets/opencode/1.16.2');
const pack = JSON.parse(readFileSync(join(assetRoot, 'chunks.json'), 'utf8'));
const literal = node => {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(p => [p.key.name ?? p.key.value, literal(p.value)]));
  if (node.type === 'UnaryExpression' && node.operator === '-') return -literal(node.argument);
  throw new Error(`unsupported models snapshot literal: ${node.type}`);
};
let snapshot;
for (const source of Object.values(pack)) {
  if (!source.includes('ModelsDev.fetchAndWrite')) continue;
  const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  walk.simple(ast, { ArrowFunctionExpression(node) {
    const body = node.body.type === 'ConditionalExpression' ? node.body.alternate : node.body;
    if (body.type === 'ObjectExpression' && body.end - body.start > 1024 * 1024) snapshot = literal(body);
  } });
}
if (!snapshot) throw new Error('the committed ModelsDev catalog snapshot was not found');
const models = join(scratch, 'models.json');
writeFileSync(models, JSON.stringify(snapshot));
const dist = join(scratch, 'dist');
const env = { ...process.env, NIMBUS_OPENCODE_ROOT: packageRoot, NIMBUS_OPENCODE_DIST: dist, MODELS_DEV_API_JSON: models };
run('bun', ['build-node.ts'], packageRoot, env);
run('node', ['packages/worker/scripts/bundle-opencode.mjs'], repo, env);
const assets = readdirSync(assetRoot).map(name => ({ name, bytes: Bun.file(join(assetRoot, name)).size }));
for (const asset of assets) if (asset.bytes > 25 * 1024 * 1024) throw new Error(`asset exceeds the Workers 25MiB limit: ${asset.name} (${asset.bytes})`);
const patch = run('git', ['diff', '--binary', '--', 'packages/worker/public/_assets/opencode', 'packages/worker/src/opencode-artifact.generated.ts']);
writeFileSync(out, JSON.stringify({ sourceCommit, assets, patch }));
