// W11 functional: detectFramework recognizes an Astro project.

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('detect Astro', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: { astro: '4.16.0' },
      devDependencies: { '@astrojs/react': '3.6.0' },
    },
    files: new Set(['package.json', 'astro.config.mjs']),
  });
  eq('framework=astro', result.framework, 'astro');
  eq('devCommand=astro-cli', result.devCommand, 'astro-cli');
  ok('confidence high', result.confidence >= 0.7);
});

await summary('w11/functional/detect-astro');
