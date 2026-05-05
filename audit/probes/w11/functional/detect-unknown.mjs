// W11 functional: empty/no package.json → 'unknown' with low confidence.

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, lte, group, summary } from '../_tap.mjs';

await group('detect unknown project', async () => {
  const result = await detectFramework({
    pkg: { dependencies: {}, devDependencies: {} },
    files: new Set(['package.json']),
  });
  eq('framework=unknown', result.framework, 'unknown');
  eq('devCommand=generic', result.devCommand, 'generic');
  lte('confidence low', result.confidence, 0.5);
});

await summary('w11/functional/detect-unknown');
