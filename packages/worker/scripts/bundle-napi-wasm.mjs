#!/usr/bin/env node
/**
 * bundle-napi-wasm.mjs — stage the threadless napi-rs bindings for Nimbus.
 *
 * rolldown (Vite 8, Nuxt), satteri (Astro 7's Markdown) and the Astro
 * compiler load native N-API bindings whose only published wasm build targets
 * wasm32-wasip1-threads, which a Worker isolate cannot run.
 * scripts/napi-wasm/build.mjs builds each for plain wasm32-wasip1 from pinned
 * upstream source (specs.mjs) and writes
 *
 *   <name>/<name>.wasm, <name>/provenance.json           one per binding
 *   napi-wasm/napi-wasm-loader.mjs                       N-API (emnapi) + WASI loader
 *   napi-wasm/wasi-trampoline.wasm                       sync/JSPI dispatch for fs imports
 *   napi-wasm/provenance.json
 *
 * This script does NOT rebuild (that needs the pinned toolchains and a bounded
 * 16 GB cgroup). It stages that directory into the static-assets layer and
 * pins every file's SHA-256 and size in src/napi-wasm-artifacts.generated.ts,
 * which runtime/staged-bindings.ts verifies on every fetch:
 *
 *   public/_assets/napi-wasm/loader/<build id>/<file>
 *   public/_assets/napi-wasm/<name>/<version>/<file>
 *
 * Source: NIMBUS_NAPI_WASM_ARTIFACTS (a build.mjs --out directory), else the
 * committed public/_assets/napi-wasm/ (the artifacts are tracked, so a
 * checkout without the Rust build re-derives the same generated module).
 *
 * Run via: node scripts/bundle-napi-wasm.mjs (wired into `bundle`).
 */

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECS } from './napi-wasm/specs.mjs';
import { sha256Hex as sha256 } from './stage-asset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', '_assets', 'napi-wasm');
const OUT_TS = path.join(ROOT, 'src', 'napi-wasm-artifacts.generated.ts');
const LOADER_FILES = ['napi-wasm-loader.mjs', 'wasi-trampoline.wasm', 'provenance.json'];

const fail = (message) => { throw new Error(`[bundle-napi-wasm] ${message}`); };

async function onlyChild(dir) {
  const entries = (await fs.readdir(dir).catch(() => [])).filter((e) => !e.startsWith('.'));
  if (entries.length !== 1) fail(`expected one staged directory under ${dir}, found ${JSON.stringify(entries)}; set NIMBUS_NAPI_WASM_ARTIFACTS`);
  return path.join(dir, entries[0]);
}

/** Where each input directory is: a build.mjs --out tree, or the committed stage. */
async function sources() {
  const built = process.env.NIMBUS_NAPI_WASM_ARTIFACTS;
  if (built) {
    const dir = path.resolve(built);
    return {
      loader: path.join(dir, 'napi-wasm'),
      binding: async (name) => path.join(dir, name),
    };
  }
  return {
    loader: await onlyChild(path.join(ASSETS, 'loader')),
    binding: async (name) => onlyChild(path.join(ASSETS, name)),
  };
}

/** Read, digest and check `files` against provenance; copy them to `targetDir`. */
async function stage(sourceDir, targetDir, files, provenance) {
  const facts = {};
  for (const file of files) {
    const bytes = await fs.readFile(path.join(sourceDir, file));
    facts[file] = { sha256: sha256(bytes), bytes: bytes.length };
    if (file !== 'provenance.json' && provenance.outputs[file]?.sha256 !== facts[file].sha256) {
      fail(`${sourceDir}/${file} sha256 ${facts[file].sha256} does not match its provenance.json (${provenance.outputs[file]?.sha256})`);
    }
  }
  if (path.resolve(sourceDir) !== path.resolve(targetDir)) {
    const parent = path.dirname(targetDir);
    for (const entry of await fs.readdir(parent).catch(() => [])) {
      if (entry !== path.basename(targetDir)) await fs.rm(path.join(parent, entry), { recursive: true, force: true });
    }
    await fs.mkdir(targetDir, { recursive: true });
    for (const file of files) await fs.copyFile(path.join(sourceDir, file), path.join(targetDir, file));
  }
  return facts;
}

const src = await sources();

const loaderProvenance = JSON.parse(await fs.readFile(path.join(src.loader, 'provenance.json'), 'utf8'));
const loaderDigests = LOADER_FILES.filter((f) => f !== 'provenance.json').map((f) => loaderProvenance.outputs[f]?.sha256);
if (loaderDigests.some((d) => typeof d !== 'string')) fail(`${src.loader}/provenance.json lacks output digests`);
const buildId = sha256(loaderDigests.join('\n')).slice(0, 16);
const loaderDir = path.join(ASSETS, 'loader', buildId);
const loaderFacts = await stage(src.loader, loaderDir, LOADER_FILES, loaderProvenance);
const asset = (dir, file, facts) => ({
  path: `/_assets/napi-wasm/${path.relative(ASSETS, dir).split(path.sep).join('/')}/${file}`,
  sha256: facts[file].sha256,
  bytes: facts[file].bytes,
});

const bindings = [];
for (const spec of Object.values(SPECS)) {
  const sourceDir = await src.binding(spec.name);
  if (!existsSync(path.join(sourceDir, 'provenance.json'))) fail(`${sourceDir} has no provenance.json`);
  const provenance = JSON.parse(await fs.readFile(path.join(sourceDir, 'provenance.json'), 'utf8'));
  if (provenance.artifact !== spec.name || provenance.version !== spec.version) {
    fail(`${sourceDir} holds ${provenance.artifact}@${provenance.version}; specs.mjs pins ${spec.name}@${spec.version}`);
  }
  const file = `${spec.name}.wasm`;
  const dir = path.join(ASSETS, spec.name, spec.version);
  const facts = await stage(sourceDir, dir, [file, 'provenance.json'], provenance);
  bindings.push({
    name: spec.name,
    version: spec.version,
    owner: spec.npm.owner,
    requiredAs: spec.npm.requiredAs,
    memoryPages: provenance.wasm.memoryMinPages,
    wasm: asset(dir, file, facts),
  });
}

const ts = `/**
 * napi-wasm-artifacts.generated.ts — AUTO-GENERATED by scripts/bundle-napi-wasm.mjs
 * DO NOT EDIT.
 *
 * The threadless wasm32-wasip1 builds of napi-rs bindings
 * (scripts/napi-wasm/build.mjs, pins in scripts/napi-wasm/specs.mjs), staged
 * under public/_assets/napi-wasm/. runtime/staged-bindings.ts fetches each
 * file and verifies it against the digest below before it is compiled or
 * evaluated; PACKAGE_ABI_POLICY.stagedArtifacts routes each owner package and
 * the packages it requires the binding by to its entry.
 */

export interface NapiWasmAsset {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface StagedBindingArtifact {
  /** The binding's name (scripts/napi-wasm/specs.mjs). */
  readonly name: string;
  /** The one version of \`owner\` the binding is built from. */
  readonly version: string;
  /** The package whose JavaScript loads the binding. */
  readonly owner: string;
  /** The package names that JavaScript requires the binding by. */
  readonly requiredAs: readonly string[];
  /** Wasm pages the binding's imported memory starts at (its declared minimum). */
  readonly memoryPages: number;
  readonly wasm: NapiWasmAsset;
}

export const NAPI_WASM_LOADER: NapiWasmAsset = ${JSON.stringify(asset(loaderDir, 'napi-wasm-loader.mjs', loaderFacts))};
export const NAPI_WASM_TRAMPOLINE: NapiWasmAsset = ${JSON.stringify(asset(loaderDir, 'wasi-trampoline.wasm', loaderFacts))};
export const STAGED_BINDING_ARTIFACTS: readonly StagedBindingArtifact[] = ${JSON.stringify(bindings, null, 2)};
`;
await fs.writeFile(OUT_TS, ts);
console.log(`[bundle-napi-wasm] staged loader ${buildId} and ${bindings.map((b) => `${b.name}@${b.version}`).join(', ')} -> ${path.relative(ROOT, ASSETS)}`);
