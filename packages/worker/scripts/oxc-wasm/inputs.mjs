/**
 * inputs.mjs — what the Oxc wasm is built from, as digests: build.mjs writes
 * them into the staged provenance.json, and bundle-oxc-wasm.mjs refuses to
 * stage a wasm whose recorded inputs are not the tree's (a source edited
 * without a rebuild).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATE = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Files outside src/ that decide the output, relative to the crate. */
const FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.mjs', 'inputs.mjs', '../napi-wasm/rustc-remap.sh'];

/** `{ <path>: <sha256> }` for every input, src/ file by file, sorted by path. */
export async function oxcWasmInputs(crate = CRATE) {
  const src = (await fs.readdir(path.join(crate, 'src'), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(crate, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  const paths = [...FILES, ...src].sort();
  const digests = await Promise.all(paths.map(async (file) => [file, sha256(await fs.readFile(path.join(crate, file)))]));
  return Object.fromEntries(digests);
}

/** The inputs that differ between two records, as `<path>` lines. */
export function changedInputs(recorded, current) {
  const paths = new Set([...Object.keys(recorded ?? {}), ...Object.keys(current)]);
  return [...paths].sort().filter((file) => recorded?.[file] !== current[file]);
}
