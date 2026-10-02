// Load the interpreter files buildInterpreterFiles wrote, as a launch loads
// them: the primordials first (a launch loads them at its start, before any
// program code), then the interpreter, which requires the same primordials
// module, and its host module.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { PRIMORDIALS_FILE } from '../../../packages/worker/scripts/interpreter-bundle.mjs';

const require = createRequire(import.meta.url);

/** The primordials module beside `interpreterFile`, loaded now. */
export function loadPrimordials(interpreterFile) {
  return require(join(dirname(interpreterFile), PRIMORDIALS_FILE));
}

/** An interpreter over the built files, its dynamic imports answered by `dynamicImport(parentUrl, specifier, options)`. */
export function loadInterpreter(interpreterFile, opsFile, dynamicImport) {
  const { LAUNCH_PRIMORDIALS } = loadPrimordials(interpreterFile);
  const { createInterpreter } = require(interpreterFile);
  return createInterpreter(require(opsFile), { dynamicImport, primordials: LAUNCH_PRIMORDIALS });
}
