import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';
import { digestInputs, lockfileInputs } from '../artifact-inputs.mjs';
import { sha256Hex } from '../stage-asset.mjs';
import { EMNAPI, SPECS } from './specs.mjs';

export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const HERE = 'packages/worker/scripts/napi-wasm';
const RECIPE = [`${HERE}/build.mjs`, `${HERE}/inputs.mjs`, 'packages/worker/scripts/artifact-inputs.mjs', 'packages/worker/scripts/stage-asset.mjs'];

/** Repository inputs plus every repository module the loader's esbuild metafile names. */
export async function loaderInputs(graph, root = REPO) {
  const configs = new Set(['tsconfig.base.json']);
  const manifests = new Set();
  for (const file of graph) {
    let dir = path.dirname(file);
    for (;;) {
      for (const name of ['tsconfig.json', 'package.json']) {
        const relative = path.join(dir, name);
        if (await fs.stat(path.join(root, relative)).then(stat => stat.isFile(), () => false)) {
          (name === 'package.json' ? manifests : configs).add(relative);
        }
      }
      if (dir === '.') break;
      dir = path.dirname(dir);
    }
  }
  const manifestInputs = Object.fromEntries(await Promise.all([...manifests].sort().map(async file => {
    const manifest = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    // esbuild never reads version; pin every other field without staling the loader on a release bump.
    delete manifest.version;
    return [file, sha256Hex(JSON.stringify(manifest))];
  })));
  return {
    ...await digestInputs(root, [...RECIPE, `${HERE}/specs.mjs`, `${HERE}/loader/napi-wasm-loader.ts`, `${HERE}/loader/wasi-trampoline.mjs`, ...configs, ...graph]),
    ...await lockfileInputs(root, 'bun.lock', await lockfileClosure(root, 'bun.lock', ['esbuild'])),
    ...manifestInputs,
  };
}

/**
 * The lockfile records `packages` and everything they depend on resolve to,
 * optional dependencies too: the esbuild that compiles the loader runs as its
 * optional native package (@esbuild/linux-x64 on CI), whose integrity is that
 * package's own record, not esbuild's. Resolved as bun resolves: a package's
 * own nested record (`esbuild/@esbuild/linux-x64`) before its ancestors'.
 */
async function lockfileClosure(root, lockfile, packages) {
  const errors = [];
  const lock = parseTree(await fs.readFile(path.join(root, lockfile), 'utf8'), errors, { allowTrailingComma: true });
  if (!lock || errors.length) throw new Error(`cannot read dependency pins in ${lockfile}`);
  const recordOf = (key) => { const entry = findNodeAtLocation(lock, ['packages', key]); return entry && getNodeValue(entry); };
  const resolve = (from, name) => {
    const names = from === null ? [] : packageNames(from);
    for (let depth = names.length; depth >= 0; depth--) {
      const key = [...names.slice(0, depth), name].join('/');
      if (recordOf(key) !== undefined) return key;
    }
    throw new Error(`${lockfile} has no pin for ${name}${from === null ? '' : ` (a dependency of ${from})`}`);
  };
  const keys = new Set();
  const visit = (from, name, optional) => {
    let key;
    try { key = resolve(from, name); } catch (error) { if (optional) return; throw error; }
    if (keys.has(key)) return;
    keys.add(key);
    const info = [].concat(recordOf(key)).find((part) => part !== null && typeof part === 'object' && !Array.isArray(part));
    for (const dependency of Object.keys(info?.dependencies ?? {})) visit(key, dependency, false);
    for (const dependency of Object.keys(info?.optionalDependencies ?? {})) visit(key, dependency, true);
  };
  for (const name of packages) visit(null, name, false);
  return [...keys];
}

/** The package names a lockfile key nests (`vite/esbuild/@esbuild/linux-x64`: vite, esbuild, @esbuild/linux-x64). */
function packageNames(key) {
  const names = [];
  const parts = key.split('/');
  for (let at = 0; at < parts.length; at++) names.push(parts[at].startsWith('@') ? `${parts[at]}/${parts[++at]}` : parts[at]);
  return names;
}

/** Only this binding's spec and wrapper, not an unrelated binding's source. */
export async function bindingInputs(key, root = REPO) {
  const spec = SPECS[key];
  if (!spec) throw new Error(`napi-wasm: no binding spec ${key}`);
  const names = [...RECIPE, 'packages/worker/scripts/rust-build-env.mjs', `${HERE}/link-wasm.sh`, `${HERE}/rustc-remap.sh`];
  if (spec.build.mode === 'wrapper') {
    names.push(`${HERE}/${spec.build.wrapper}/Cargo.toml`, `${HERE}/${spec.build.wrapper}/binding`);
  }
  if (spec.build.lockfile && spec.build.lockfile !== 'upstream') names.push(`${HERE}/${spec.build.lockfile}`);
  return {
    ...await digestInputs(root, names),
    [`${HERE}/specs.mjs#${key}`]: sha256Hex(JSON.stringify(spec)),
    [`${HERE}/specs.mjs#emnapi-link`]: sha256Hex(JSON.stringify({ packages: EMNAPI.packages, source: SPECS[EMNAPI.lockfileFrom].source })),
  };
}

/**
 * An esbuild plugin that resolves every @emnapi/* the loader imports from the
 * pinned, integrity-checked, seamed packages under `npmDir`, and refuses one
 * that resolves anywhere else. A copy installed in the workspace (for its
 * types, say) lies on the loader's own resolution path before nodePaths.
 */
export function pinnedEmnapi(npmDir) {
  return {
    name: 'pinned-emnapi',
    setup(build) {
      build.onResolve({ filter: /^@emnapi\// }, async (args) => {
        if (args.pluginData === 'pinned') return undefined;
        const pinned = await build.resolve(args.path, { kind: args.kind, resolveDir: npmDir, pluginData: 'pinned' });
        if (pinned.errors.length > 0) return { errors: pinned.errors };
        if (path.relative(npmDir, pinned.path).startsWith('..')) return { errors: [{ text: `${args.path} resolved outside the pinned emnapi: ${pinned.path}` }] };
        return { path: pinned.path, namespace: pinned.namespace, sideEffects: pinned.sideEffects };
      });
    },
  };
}

/** Stable npm paths for fetched modules; repository paths for the rest. */
export function loaderGraph(metafile, npmDir, root = REPO) {
  const npmRoot = path.join(npmDir, 'node_modules');
  const repository = [], npm = {};
  for (const input of Object.keys(metafile.inputs)) {
    // esbuild lists the generated define array as a virtual module. Its
    // bytes come from build.mjs and wasi-trampoline.mjs, both recorded inputs.
    if (input === '<define:__NIMBUS_NAPI_WASM_DISPATCHED__>') continue;
    const file = path.resolve(root, input);
    const external = path.relative(npmRoot, file);
    if (!external.startsWith(`..${path.sep}`) && external !== '..' && !path.isAbsolute(external)) {
      npm[`npm/${external.split(path.sep).join('/')}`] = file;
    } else {
      const relative = path.relative(root, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`napi-wasm: unpinned loader input outside the repository: ${file}`);
      }
      repository.push(relative.split(path.sep).join('/'));
    }
  }
  return { repository: repository.sort(), npm };
}
