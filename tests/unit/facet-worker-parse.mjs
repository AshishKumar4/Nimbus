import assert from 'node:assert/strict';

import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { assembleLoaderWorkerModuleSource } from '../../packages/fabric/src/isolate-pool.ts';
import {
  TAR_STREAM_PREAMBLE,
  W7_FRAME_PREAMBLE,
} from '../../packages/worker/src/loaders/generated-workers.ts';
import { NPM_INSTALL_BATCH_TASK } from '../../packages/worker/src/loaders/compiled-bodies.generated.ts';
import { parseJavaScriptModule } from '../../packages/core/src/runtime/javascript-ast.ts';
import { buildCPythonPreamble } from '../../packages/core/src/runtime/cpython-runner.ts';
import { buildRubyPreamble } from '../../packages/core/src/runtime/ruby-runner.ts';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-resident.ts';

const facetWorkers = [
  {
    name: 'git network facet (the pack bundle and its worker)',
    source: assembleGitNetworkFacetSource(),
  },
  {
    name: 'npm install-batch facet + tar stream and W7 frame preambles',
    source: assembleLoaderWorkerModuleSource({
      fnSource: NPM_INSTALL_BATCH_TASK.source,
      preamble: TAR_STREAM_PREAMBLE + '\n' + W7_FRAME_PREAMBLE,
      hasBindings: true,
    }),
  },
  // The python/ruby process workers are assembled by string concatenation
  // inside a template literal, so an unescaped newline in a preamble line
  // silently emits an unterminated string and the runtime only fails at
  // dispatch ("Invalid or unexpected token"). Parse them here instead.
  {
    name: 'cpython facet preamble',
    source: buildCPythonPreamble(),
  },
  {
    name: 'ruby socket process worker + ruby preamble',
    source: buildRubySocketProcessWorker(buildRubyPreamble()),
  },
];

for (const facet of facetWorkers) {
  assert.doesNotThrow(
    () => parseJavaScriptModule(facet.source),
    `${facet.name} must be valid as one assembled JavaScript module`,
  );
}

assert.throws(
  () => parseJavaScriptModule(facetWorkers[1].source + '\nconst streamTarEntries = 1;'),
  /Identifier 'streamTarEntries' has already been declared/,
  'the parse guard must detect a facet declaration that collides with a preamble\'s export',
);
// A preamble's private names are its own: W7's CHUNK_SIZE is no name of the facet's.
assert.doesNotThrow(() => parseJavaScriptModule(facetWorkers[1].source + '\nconst CHUNK_SIZE = 1;'));

console.log(`facet worker parse guard: ok (${facetWorkers.length} assemblies)`);
