#!/usr/bin/env bun
// Run on CI: rebuild the pinned upstream source, then stage it with the same
// checked-in recipe a normal worker build uses. Return the staged assets'
// changes against the checkout's HEAD as remote-build's build.mjs returns
// dist's: { head, sourceCommit, assets, patch, blobs } (lib/output-patch.mjs),
// which scripts/ci/remote-opencode.mjs checks and applies.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { assertCurrentInputs, digestInputs } from '../../packages/worker/scripts/artifact-inputs.mjs';
import { OPENCODE_SOURCE, opencodeInputs } from '../../packages/worker/scripts/opencode/inputs.mjs';
import { modelsCatalogs } from '../../packages/worker/scripts/opencode/models-catalog.mjs';
import { sha256Hex } from '../../packages/worker/scripts/stage-asset.mjs';
import { outputPatch } from './lib/output-patch.mjs';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!out) throw new Error('--out is required');
const repo = process.cwd();
const inputs = await opencodeInputs();
const run = (command, args, cwd = repo, env = process.env, quiet = false) => {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 29 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  if (!quiet) process.stderr.write(result.stdout + result.stderr);
  return result.stdout.trim();
};
const scratch = mkdtempSync(join(tmpdir(), 'nimbus-opencode-build-'));
const upstream = join(scratch, 'source');
run('git', ['clone', '--depth', '1', '--branch', `v${OPENCODE_SOURCE.version}`, OPENCODE_SOURCE.url, upstream]);
const sourceCommit = run('git', ['rev-parse', 'HEAD'], upstream);
if (sourceCommit !== OPENCODE_SOURCE.commit) throw new Error(`OpenCode v${OPENCODE_SOURCE.version} source changed`);
run('bun', ['install', '--frozen-lockfile', '--ignore-scripts', '--linker=hoisted'], upstream);
const recipe = join(repo, 'packages/worker/scripts/opencode');
for (const patch of ['nimbus-defer-global-io.patch', 'nimbus-tree-sitter-exports.patch']) run('git', ['apply', join(recipe, patch)], upstream);
const packageRoot = join(upstream, 'packages/opencode');
// The CLI reports the version build-node.ts reads from this manifest.
const sourceVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
if (sourceVersion !== OPENCODE_SOURCE.version) throw new Error(`OpenCode's source says it is ${sourceVersion}, the recipe names ${OPENCODE_SOURCE.version}`);
for (const file of ['build-node.ts', 'bundle-patches.ts']) copyFileSync(join(recipe, file), join(packageRoot, file));
for (const file of readdirSync(join(recipe, 'stubs'))) copyFileSync(join(recipe, 'stubs', file), join(packageRoot, file));
// bundle-patches.ts parses with this tree's tsrs (its bun.lock entries are
// inputs): the package beside opencode's own, and its native package (the
// binary, which tsrs's own getExePath finds here, and the lib.*.d.ts files it
// reads beside itself), named inside the sandbox by TSRS_BINARY.
const tsrs = realpathSync(join(repo, 'node_modules/tsrs'));
cpSync(tsrs, join(upstream, 'node_modules/tsrs'), { recursive: true });
const { default: tsrsBinary } = await import(pathToFileURL(join(tsrs, 'lib/getExePath.js')).href);
const native = realpathSync(tsrsBinary());
cpSync(dirname(native), join(scratch, 'tsrs-native'), { recursive: true });

// Reuse the committed catalog snapshot, not whichever catalog models.dev
// happens to serve today: the literal in ModelsDev's sync thunk
// (opencode/models-catalog.mjs), exactly one in the whole pack.
const assetRoot = join(repo, 'packages/worker/public/_assets/opencode', OPENCODE_SOURCE.version);
const pack = JSON.parse(readFileSync(join(assetRoot, 'chunks.json'), 'utf8'));
const literal = node => {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(p => [p.key.name ?? p.key.value, literal(p.value)]));
  if (node.type === 'UnaryExpression' && node.operator === '-') return -literal(node.argument);
  if (node.type === 'UnaryExpression' && node.operator === '!') return !literal(node.argument);
  throw new Error(`unsupported models snapshot literal: ${node.type}`);
};
const catalogs = Object.values(pack).flatMap((source) => modelsCatalogs(source));
if (catalogs.length !== 1) throw new Error(`the committed ModelsDev catalog snapshot: ${catalogs.length} found, one expected`);
const snapshot = literal(catalogs[0].catalog);
const models = join(scratch, 'models.json');
writeFileSync(models, JSON.stringify(snapshot));
const dist = join(scratch, 'dist');
const env = { ...process.env, NIMBUS_OPENCODE_ROOT: packageRoot, NIMBUS_OPENCODE_DIST: dist, MODELS_DEV_API_JSON: models };
// Bun embeds CommonJS __dirname in its chunks. A random clone path changes
// those literals, and therefore every chunk hash that depends on them.
run('bwrap', [
  '--unshare-user', '--tmpfs', '/',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
  ...['/bin', '/sbin', '/lib', '/lib64'].flatMap(dir => ['--ro-bind-try', dir, dir]),
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  '--bind', upstream, '/src/opencode', '--bind', scratch, '/build',
  '--chdir', '/src/opencode/packages/opencode',
  '--setenv', 'NIMBUS_OPENCODE_ROOT', '/src/opencode/packages/opencode',
  '--setenv', 'NIMBUS_OPENCODE_DIST', '/build/dist', '--setenv', 'MODELS_DEV_API_JSON', '/build/models.json',
  '--setenv', 'HOME', '/tmp', '--setenv', 'BUN_INSTALL_CACHE_DIR', '/build/bun-cache',
  '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TSRS_BINARY', `/build/tsrs-native/${basename(native)}`,
  'bun', 'build-node.ts',
], repo, env);
assertCurrentInputs('OpenCode', inputs, await opencodeInputs(), 'bun scripts/ci/rebuild-opencode.mjs --out <file> (on armada)');
writeFileSync(join(dist, 'provenance.json'), JSON.stringify({
  artifact: 'opencode',
  source: { ...OPENCODE_SOURCE, inputs, catalogSnapshotSha256: sha256Hex(readFileSync(models)), upstreamInputs: await digestInputs(upstream, ['bun.lock', 'package.json']) },
  toolchain: { bun: Bun.version },
}, null, 2) + '\n');
run('node', ['packages/worker/scripts/bundle-opencode.mjs'], repo, env);
const assets = readdirSync(assetRoot).map(name => ({ name, bytes: Bun.file(join(assetRoot, name)).size }));
for (const asset of assets) if (asset.bytes > 25 * 1024 * 1024) throw new Error(`asset exceeds the Workers 25MiB limit: ${asset.name} (${asset.bytes})`);
const head = run('git', ['rev-parse', 'HEAD'], repo, process.env, true);
const { patch, blobs } = outputPatch(repo, ['packages/worker/public/_assets/opencode', 'packages/worker/src/opencode-artifact.generated.ts']);
writeFileSync(out, JSON.stringify({ head, sourceCommit, assets, patch, blobs }));
