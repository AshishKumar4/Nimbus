import assert from 'node:assert/strict';

import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { assembleLoaderWorkerModuleSource } from '../../packages/worker/src/loaders/loader-pool.ts';
import {
  TAR_STREAM_PREAMBLE,
  W7_FRAME_PREAMBLE,
} from '../../packages/worker/src/loaders/generated-workers.ts';
import { serializeFunction } from '../../packages/worker/src/loaders/vendor/serialize.ts';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { parseJavaScriptModule } from '../../packages/worker/src/runtime/javascript-ast.ts';

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
