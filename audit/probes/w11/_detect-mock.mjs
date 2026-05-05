// _detect-mock.mjs — adapter that calls src/framework-detect.ts from .mjs
// probes. The detector is pure (no DO/CF dependencies) so we can compile
// it on the fly with esbuild-wasm — but we don't want to make every probe
// pay that latency, so we use a node-style require.
//
// On RED phase (file doesn't exist yet), we return a sentinel that lets
// probes fail with a readable assertion message rather than crashing on
// ERR_MODULE_NOT_FOUND. The reviewer flagged this in W11 plan review §5.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', 'src', 'framework-detect.ts');

let _detect = null;
let _loadError = null;

async function load() {
  if (_detect || _loadError) return;
  if (!fs.existsSync(SRC)) {
    _loadError = new Error('src/framework-detect.ts does not exist (RED phase)');
    return;
  }
  // Compile-on-demand. Bun can import .ts directly.
  try {
    const mod = await import(SRC);
    if (typeof mod.detectFramework !== 'function') {
      _loadError = new Error('src/framework-detect.ts loaded but exports no detectFramework function');
      return;
    }
    _detect = mod.detectFramework;
  } catch (e) {
    _loadError = e;
  }
}

export async function detectFramework(input) {
  await load();
  if (_detect) return _detect(input);
  // RED-phase sentinel — readable assertion failures, not crashes.
  return {
    framework: '__not-implemented__',
    confidence: 0,
    reason: 'src/framework-detect.ts not yet implemented: ' + (_loadError?.message || 'unknown'),
    devCommand: 'generic',
  };
}

export async function isImplemented() {
  await load();
  return _detect !== null;
}
