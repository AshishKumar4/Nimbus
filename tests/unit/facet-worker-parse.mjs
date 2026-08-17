import assert from 'node:assert/strict';

import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { assembleLoaderWorkerModuleSource } from '../../packages/fabric/src/loader-pool.ts';
import {
  TAR_STREAM_PREAMBLE,
  W7_FRAME_PREAMBLE,
} from '../../packages/worker/src/loaders/generated-workers.ts';
import { serializeFunction } from '../../packages/fabric/src/vendor/serialize.ts';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { parseJavaScriptModule } from '../../packages/core/src/runtime/javascript-ast.ts';
import { buildCPythonPreamble } from '../../packages/core/src/runtime/cpython-runner.ts';
import { buildRubyPreamble } from '../../packages/core/src/runtime/ruby-runner.ts';
import { buildRubySocketProcessWorker } from '../../packages/worker/src/runtime/ruby-resident.ts';

const facetWorkers = [
  {
    name: 'git network facet + W7 frame preamble',
    source: assembleGitNetworkFacetSource(),
  },
  {
    name: 'npm install-batch facet + tar stream and W7 frame preambles',
    source: assembleLoaderWorkerModuleSource({
      fnSource: serializeFunction(installPackagesInFacet),
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
  () => parseJavaScriptModule(facetWorkers[0].source + '\nconst CHUNK_SIZE = 1;'),
  /Identifier 'CHUNK_SIZE' has already been declared/,
  'the parse guard must detect a facet declaration that collides with its preamble',
);

console.log(`facet worker parse guard: ok (${facetWorkers.length} assemblies)`);
