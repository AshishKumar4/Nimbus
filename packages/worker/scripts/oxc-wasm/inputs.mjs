/**
 * inputs.mjs — what the Oxc wasm is built from, as digests: build.mjs writes
 * them into the staged provenance.json, and bundle-oxc-wasm.mjs refuses to
 * stage a wasm whose recorded inputs are not the tree's (a source edited
 * without a rebuild).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestInputs } from '../artifact-inputs.mjs';
export { changedInputs } from '../artifact-inputs.mjs';

const CRATE = path.dirname(fileURLToPath(import.meta.url));

/** Files outside src/ that decide the output, relative to the crate. */
const FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.mjs', 'inputs.mjs', '../artifact-inputs.mjs', '../stage-asset.mjs', '../rust-build-env.mjs', '../napi-wasm/rustc-remap.sh'];

/** `{ <path>: <sha256> }` for every input, src/ file by file, sorted by path. */
export async function oxcWasmInputs(crate = CRATE) {
  const src = (await fs.readdir(path.join(crate, 'src'), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(crate, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  const paths = [...FILES, ...src].sort();
  return digestInputs(crate, paths);
}
