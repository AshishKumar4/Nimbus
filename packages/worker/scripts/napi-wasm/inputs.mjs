import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
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
    ...await lockfileInputs(root, 'bun.lock', ['esbuild']),
    ...manifestInputs,
  };
}

/** Only this binding's spec and wrapper, not an unrelated binding's source. */
export async function bindingInputs(key, root = REPO) {
  const spec = SPECS[key];
  if (!spec) throw new Error(`napi-wasm: no binding spec ${key}`);
  const names = [...RECIPE, `${HERE}/link-wasm.sh`, `${HERE}/rustc-remap.sh`];
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
