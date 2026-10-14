import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCurrentInputs, digestInputs } from '../../scripts/artifact-inputs.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
export const BASH_OUTPUTS = ['bash.async.wasm'];
export const BASH_REGENERATE = 'bun scripts/ci/remote-bash-build.mjs';

/** What bash.async.wasm is built from, beside the pinned sources build-in-bwrap.sh fetches. */
export async function bashInputs(root = HERE) {
  return digestInputs(root, [
    'build-bash.sh', 'build-in-bwrap.sh', 'inputs.mjs', 'cross.cache', 'nimbus-proc.c', 'nimbus-proc.h', 'include', 'patches',
    '../../scripts/artifact-inputs.mjs',
  ]);
}

export async function checkBashInputs(root = HERE) {
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'provenance.json'), 'utf8'));
  assertCurrentInputs('bash', provenance.source?.inputs, await bashInputs(root), BASH_REGENERATE);
  assertCurrentInputs('bash output', provenance.outputs, await digestInputs(root, BASH_OUTPUTS), BASH_REGENERATE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, snapshot] = process.argv.slice(2);
  if (mode === '--snapshot' && snapshot) {
    await fs.writeFile(snapshot, JSON.stringify(await bashInputs()));
  } else if (mode === '--record' && snapshot) {
    const inputs = JSON.parse(await fs.readFile(snapshot, 'utf8'));
    assertCurrentInputs('bash', inputs, await bashInputs(), BASH_REGENERATE);
    await fs.writeFile(path.join(HERE, 'provenance.json'), JSON.stringify({
      artifact: 'bash', source: { inputs }, outputs: await digestInputs(HERE, BASH_OUTPUTS),
    }, null, 2) + '\n');
  } else if (mode === '--check' && !snapshot) {
    await checkBashInputs();
  } else throw new Error('usage: node wasm/bash/inputs.mjs --check | --snapshot <file> | --record <file>');
}
