import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';
import { sha256Hex } from './stage-asset.mjs';

/** Files under the named input roots, including missing files so a deletion is reported. */
/** @param {string} root @param {string[]} names @returns {Promise<string[]>} */
export async function inputFiles(root, names) {
  const files = [];
  for (const name of names) {
    const file = path.resolve(root, name);
    let stat;
    try { stat = await fs.stat(file); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (stat?.isDirectory()) {
      files.push(...await inputFiles(root, (await fs.readdir(file)).map(entry => path.join(name, entry))));
    } else files.push(name.split(path.sep).join('/'));
  }
  return [...new Set(files)].sort();
}

/** Content digests, never mtimes or absolute build paths. */
/** @param {string} root @param {string[]} names @returns {Promise<Record<string, string | null>>} */
export async function digestInputs(root, names) {
  const entries = await Promise.all((await inputFiles(root, names)).map(async name => {
    let bytes;
    try { bytes = await fs.readFile(path.resolve(root, name)); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    return [name, bytes === undefined ? null : sha256Hex(bytes)];
  }));
  return Object.fromEntries(entries);
}

/** The input paths whose content changed, was added, or disappeared. */
/** @param {Record<string, string | null> | undefined} recorded @param {Record<string, string | null>} current */
export function changedInputs(recorded, current) {
  const names = new Set([...Object.keys(recorded ?? {}), ...Object.keys(current)]);
  return [...names].sort().filter(name => current[name] === null || recorded?.[name] !== current[name]);
}

/** @param {string} artifact @param {Record<string, string | null> | undefined} recorded @param {Record<string, string | null>} current @param {string} regenerate */
export function assertCurrentInputs(artifact, recorded, current, regenerate) {
  const changed = changedInputs(recorded, current);
  if (changed.length) {
    throw new Error(`${artifact} was built from other inputs than this tree's:\n  ${changed.join('\n  ')}\nRegenerate with: ${regenerate}`);
  }
}

/** A dependency's full lockfile record, including its dependency and integrity pins. */
/** @param {string} root @param {string} lockfile @param {string[]} packages */
export async function lockfileInputs(root, lockfile, packages) {
  const errors = [];
  const lock = parseTree(await fs.readFile(path.join(root, lockfile), 'utf8'), errors, { allowTrailingComma: true });
  if (!lock || errors.length) throw new Error(`cannot read dependency pins in ${lockfile}`);
  return Object.fromEntries(packages.sort().map(name => {
    const entry = findNodeAtLocation(lock, ['packages', name]);
    if (!entry) throw new Error(`${lockfile} has no pin for ${name}`);
    return [`${lockfile}#${name}`, sha256Hex(JSON.stringify(getNodeValue(entry)))];
  }));
}
