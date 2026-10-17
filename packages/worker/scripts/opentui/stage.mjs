/**
 * stage.mjs — the OpenTUI wasm recipe's pins, and the check every bundle
 * makes of the staged build (bun run bundle:opentui).
 *
 * build-wasm.mjs builds from these pins and records them, with each patch's
 * sha256, in the staged manifest.json. The bundle holds the staged build to
 * this tree: the wasm must be the bytes its manifest names, the manifest's
 * pins this recipe's, and its patches this tree's patches, byte for byte. A
 * patch or a pin changed without a Zig rebuild fails here, naming what
 * changed. It then writes the generated loader from the manifest.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCurrentInputs, digestInputs } from '../artifact-inputs.mjs';
import { sha256Hex } from '../stage-asset.mjs';

export const OPENTUI_PINS = {
  version: '0.3.2',
  sourceCommit: '0d449d4c170a703197f0321f48c7e3bd38dcbd31',
  zigVersion: '0.15.2',
  target: 'wasm32-wasi',
  optimize: 'ReleaseSmall',
};
export const OPENTUI_PATCHES = ['nimbus-wasm-reactor-target.patch', 'nimbus-wasm-ffi-abi.patch'];

/** The staged build's place under a worker package root. */
export const opentuiAssetDir = (workerRoot) => path.join(workerRoot, 'public', '_assets', 'opentui', OPENTUI_PINS.version);
const generatedPath = (workerRoot) => path.join(workerRoot, 'src', 'opentui-wasm-artifact.generated.ts');
const REBUILD = 'node packages/worker/scripts/opentui/build-wasm.mjs (see scripts/opentui/README.md)';

/** Write the generated loader for the staged build whose wasm has sha256 `artifactSha`. */
export async function emitGenerated(workerRoot, artifactSha) {
  const version = OPENTUI_PINS.version;
  await fs.writeFile(generatedPath(workerRoot), `/**
 * opentui-wasm-artifact.generated.ts — AUTO-GENERATED from the staged build
 * by scripts/opentui (build-wasm.mjs, stage.mjs). DO NOT EDIT.
 *
 * Staged OpenTUI ${version} Zig core, built as a wasm32-wasi reactor
 * for the opencode TUI path. The artifact and its build manifest live in the
 * static-assets layer under public/_assets/opentui/${version}/.
 * See scripts/opentui/README.md for the build recipe and FFI ABI.
 *
 * Stage A: nothing consumes these constants yet; the facet module-map attach
 * path lands separately.
 *
 * OPENTUI_WASM_BUILD_ID is a content-hash prefix over the staged artifact so
 * cache layers keyed on it never serve stale bytes after a same-version
 * rebuild; OPENTUI_WASM_SHA256 is the full digest for integrity checks at
 * attach time.
 */

export const OPENTUI_WASM_VERSION: string = ${JSON.stringify(version)};
export const OPENTUI_WASM_BUILD_ID: string = ${JSON.stringify(artifactSha.slice(0, 16))};
export const OPENTUI_WASM_ENTRY: string = ${JSON.stringify(`/_assets/opentui/${version}/opentui.wasm`)};
export const OPENTUI_WASM_SHA256: string = ${JSON.stringify(artifactSha)};
`);
}

/** Hold the staged build under `workerRoot` to this tree's recipe, then write its loader. Throws naming what differs. */
export async function stageOpentui(workerRoot) {
  const dir = opentuiAssetDir(workerRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const wasmSha = sha256Hex(await fs.readFile(path.join(dir, manifest.artifact.file)));
  if (wasmSha !== manifest.artifact.sha256) {
    throw new Error(`[opentui] ${manifest.artifact.file} has sha256 ${wasmSha}, its manifest names ${manifest.artifact.sha256}. Rebuild with: ${REBUILD}`);
  }
  const pins = Object.entries(OPENTUI_PINS).filter(([key, value]) => manifest[key] !== value);
  if (pins.length > 0) {
    throw new Error(`[opentui] the staged build was made with other pins than this recipe's: ${pins.map(([key, value]) => `${key} ${JSON.stringify(manifest[key])}, recipe ${JSON.stringify(value)}`).join('; ')}. Rebuild with: ${REBUILD}`);
  }
  const recorded = Object.fromEntries(manifest.patches.map((patch) => [patch.file, patch.sha256]));
  assertCurrentInputs('the staged OpenTUI wasm', recorded, await digestInputs(path.join(workerRoot, 'scripts', 'opentui'), OPENTUI_PATCHES), REBUILD);
  await emitGenerated(workerRoot, wasmSha);
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifest = await stageOpentui(workerRoot);
  console.log(`[opentui] staged build ${manifest.artifact.sha256.slice(0, 16)} matches this tree's recipe and patches`);
}
