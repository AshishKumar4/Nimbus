import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCurrentInputs, digestInputs } from '../../scripts/artifact-inputs.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
export const PYTHON_OUTPUTS = ['python.wasm', 'python-sci.wasm', 'python313.zip', 'sci-packages.zip'];
export const PYTHON_REGENERATE = 'bun scripts/ci/remote-python-build.mjs';
/**
 * The stages of a complete build, build-in-bwrap.sh's default (`--stages`
 * prints them): every one that compiles what the artifacts hold, then assets. Only such a run
 * records provenance. A run of some of them (assets alone repacks the
 * interpreters an earlier build linked) cannot say what its cached objects
 * were built from, so the provenance stays as it was, and the gate refuses
 * the repacked artifacts until a complete build.
 */
export const PYTHON_COMPLETE_STAGES = ['fetch', 'deps', 'nimbus', 'hostpy', 'wasi', 'extenv', 'ext', 'sci', 'assets'];

export async function pythonInputs(root = HERE) {
  const sources = (await fs.readdir(root)).filter(name => /\.(?:c|py)$/.test(name));
  return digestInputs(root, [
    'Setup.local', 'config.site-nimbus-wasi', 'build-python.sh', 'build-in-bwrap.sh', 'inputs.mjs',
    'include', 'patches', ...sources,
    '../nimbus-libc/nimbus-fs.c', '../nimbus-libc/nimbus-fs.h', '../nimbus-libc/nimbus-netdb.h',
    '../nimbus-libc/nimbus-restart.c', '../nimbus-libc/nimbus-restart.h', '../nimbus-libc/nimbus-signal.c',
    '../nimbus-libc/verify-imports.mjs',
    '../../scripts/artifact-inputs.mjs', '../../scripts/stage-asset.mjs',
  ]);
}

export async function checkPythonInputs(root = HERE) {
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'provenance.json'), 'utf8'));
  assertCurrentInputs('CPython', provenance.source?.inputs, await pythonInputs(root), PYTHON_REGENERATE);
  assertCurrentInputs('CPython output', provenance.outputs, await digestInputs(root, PYTHON_OUTPUTS), PYTHON_REGENERATE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, snapshot] = process.argv.slice(2);
  if (mode === '--snapshot' && snapshot) {
    await fs.writeFile(snapshot, JSON.stringify(await pythonInputs()));
  } else if (mode === '--record' && snapshot) {
    const stages = process.argv.slice(4);
    if (stages.join(' ') !== PYTHON_COMPLETE_STAGES.join(' ')) {
      if (stages.includes('assets')) {
        console.error(`CPython: provenance is recorded only by a complete build (${PYTHON_COMPLETE_STAGES.join(' ')}); `
          + `stages ${stages.join(' ')} leave provenance.json as it was, and the gate refuses what they wrote until one: ${PYTHON_REGENERATE}`);
      }
      process.exit(0);
    }
    const inputs = JSON.parse(await fs.readFile(snapshot, 'utf8'));
    assertCurrentInputs('CPython', inputs, await pythonInputs(), PYTHON_REGENERATE);
    await fs.writeFile(path.join(HERE, 'provenance.json'), JSON.stringify({
      artifact: 'cpython', source: { inputs }, outputs: await digestInputs(HERE, PYTHON_OUTPUTS),
    }, null, 2) + '\n');
  } else if (mode === '--stages' && !snapshot) {
    console.log(PYTHON_COMPLETE_STAGES.join(' '));
  } else if (mode === '--check' && !snapshot) {
    await checkPythonInputs();
  } else throw new Error('usage: node wasm/python/inputs.mjs --check | --stages | --snapshot <file> | --record <file> <stage>...');
}
