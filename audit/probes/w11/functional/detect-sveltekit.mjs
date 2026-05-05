// W11 functional: detectFramework recognizes SvelteKit.

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('detect SvelteKit', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: {},
      devDependencies: {
        '@sveltejs/kit': '2.7.0',
        '@sveltejs/vite-plugin-svelte': '4.0.0',
        svelte: '5.0.0',
        vite: '5.4.0',
      },
    },
    files: new Set(['package.json', 'svelte.config.js', 'vite.config.js']),
  });
  eq('framework=sveltekit', result.framework, 'sveltekit');
  eq('devCommand=sveltekit-vite', result.devCommand, 'sveltekit-vite');
  ok('confidence high', result.confidence >= 0.7);
});

await summary('w11/functional/detect-sveltekit');
