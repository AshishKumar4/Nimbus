// W11 functional: a plain wrangler.toml project (no framework) → 'wrangler'.

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('detect plain wrangler project', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: {},
      devDependencies: { wrangler: '3.78.0', '@cloudflare/workers-types': '4.20240924.0' },
    },
    files: new Set(['package.json', 'wrangler.jsonc', 'src']),
  });
  eq('framework=wrangler', result.framework, 'wrangler');
  eq('devCommand=wrangler-dev', result.devCommand, 'wrangler-dev');
});

await summary('w11/functional/detect-wrangler');
