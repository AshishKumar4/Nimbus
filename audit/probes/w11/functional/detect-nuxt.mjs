// W11 functional: detectFramework recognizes a Nuxt project.

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('detect Nuxt', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: { nuxt: '3.13.0' },
      devDependencies: {},
    },
    files: new Set(['package.json', 'nuxt.config.ts']),
  });
  eq('framework=nuxt', result.framework, 'nuxt');
  eq('devCommand=nuxt-cli', result.devCommand, 'nuxt-cli');
  ok('confidence high', result.confidence >= 0.7);
});

await summary('w11/functional/detect-nuxt');
