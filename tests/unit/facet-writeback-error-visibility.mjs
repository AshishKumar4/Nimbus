import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { withNamespace } from './lib/listing-supervisor.mjs';

const work = mkdtempSync(join(tmpdir(), 'writeback-diagnostics-'));
const error = new Error('Too many subrequests by single Worker invocation');
let exhausted = false, waves = 0;
try {
  const generated = await generateEntrypointCode(`
    const fs = require('fs');
    for (let i = 0; i < 10000; i++) fs.writeFileSync('/home/user/f' + i, 'saved');
  `, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
  const file = writeModuleSet(work, generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs');
  const runner = await import(file);
  const { supervisor, authority } = withNamespace({
    async writeBatchStream() { waves++; exhausted = true; throw error; },
    async stderr() { if (exhausted) throw error; },
    async reportExit() { if (exhausted) throw error; },
  });
  const response = await runner.default.fetch(new Request('http://facet/', {
    method: 'POST', body: JSON.stringify({
      vfsRoot: authority.root(), argv: [], env: {}, cwd: '/home/user', filename: '/home/user/writer.js', dirname: '/home/user',
      stdin: '', captureOutput: false, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    }),
  }), { SUPERVISOR: supervisor });
  const result = await response.json();
  assert.ok(waves > 0, 'the synchronous writes reached the publication boundary');
  assert.equal(result.exitCode, 1, 'unpublished writes cannot report success');
  assert.match(result.stderr, /Too many subrequests/, 'the response retains diagnostics when stderr and reportExit are also refused');
} finally { rmSync(work, { recursive: true, force: true }); }
