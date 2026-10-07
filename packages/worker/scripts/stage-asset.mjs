/**
 * stage-asset.mjs — how a bundler stages an artifact under public/_assets
 * for the Worker to fetch: write the bytes and remove every other build of
 * the same family, so the directory holds exactly the build the generated
 * pin names.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string | Uint8Array} bytes */
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Write `bytes` to `dir/name`, first removing every other entry of `dir`
 * that `sameFamily(entry)` claims.
 *
 * @param {string} dir
 * @param {string} name
 * @param {string | Uint8Array} bytes
 * @param {(entry: string) => boolean} sameFamily
 * @returns {string[]} the entries removed
 */
export function stageAsset(dir, name, bytes, sameFamily) {
  mkdirSync(dir, { recursive: true });
  const removed = [];
  for (const entry of readdirSync(dir)) {
    if (entry !== name && sameFamily(entry)) {
      unlinkSync(join(dir, entry));
      removed.push(entry);
    }
  }
  writeFileSync(join(dir, name), bytes);
  return removed;
}

/**
 * Stage a runtime script as public/_assets/runtime/<family>-<build id>.js,
 * named by a 16-hex prefix of its own sha256 so no cache layer can serve
 * another build's bytes under its name. A family's other builds are exactly
 * `<family>-<16 hex>.js`; `js-interpreter` never claims `js-interpreter-ops`.
 *
 * @param {string} workerRoot  packages/worker
 * @param {string} family
 * @param {string} source
 * @returns {{ assetName: string, assetPath: string, buildId: string, sha256: string }}
 */
export function stageRuntimeAsset(workerRoot, family, source) {
  const sha256 = sha256Hex(source);
  const buildId = sha256.slice(0, 16);
  const assetName = `${family}-${buildId}.js`;
  const build = /^[0-9a-f]{16}\.js$/;
  stageAsset(join(workerRoot, 'public', '_assets', 'runtime'), assetName, source,
    (entry) => entry.startsWith(`${family}-`) && build.test(entry.slice(family.length + 1)));
  return { assetName, assetPath: `/_assets/runtime/${assetName}`, buildId, sha256 };
}

/**
 * A version pin from @nimbus-sh/core src/constants.ts (`export const
 * <NAME> = '<version>'`), read from source so a bundle never names its
 * staged asset after a stale build of core.
 *
 * @param {string} constant
 * @returns {string}
 */
export function readCorePin(constant) {
  const constants = readFileSync(new URL('../../core/src/constants.ts', import.meta.url), 'utf8');
  const m = constants.match(new RegExp(`\\b${constant}\\s*=\\s*'([^']+)'`));
  if (!m) throw new Error(`${constant} not found in @nimbus-sh/core src/constants.ts`);
  return m[1];
}
