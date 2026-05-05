// W11 functional: detection precedence is deterministic — when multiple
// framework markers are present, the higher-priority framework wins.
// Per plan §4 resolution order.

import { detectFramework } from '../_detect-mock.mjs';
import { eq, group, summary } from '../_tap.mjs';

// Next > Astro > Nuxt > Remix > SvelteKit > vite > unknown.
// We don't test all 21 pairwise comparisons — enough cases to lock the order.

await group('next + vite → next', async () => {
  const r = await detectFramework({
    pkg: {
      dependencies: { next: '14.2.0', react: '18.3.1' },
      devDependencies: { vite: '5.4.0' },
    },
    files: new Set(['package.json', 'next.config.js']),
  });
  eq('framework=next', r.framework, 'next');
});

await group('astro + vite → astro', async () => {
  const r = await detectFramework({
    pkg: {
      dependencies: { astro: '4.16.0' },
      devDependencies: { vite: '5.4.0' },
    },
    files: new Set(['package.json', 'astro.config.mjs']),
  });
  eq('framework=astro', r.framework, 'astro');
});

await group('nuxt + vite → nuxt', async () => {
  const r = await detectFramework({
    pkg: {
      dependencies: { nuxt: '3.13.0' },
      devDependencies: {},
    },
    files: new Set(['package.json', 'nuxt.config.ts']),
  });
  eq('framework=nuxt', r.framework, 'nuxt');
});

await group('@sveltejs/kit + vite → sveltekit', async () => {
  const r = await detectFramework({
    pkg: {
      dependencies: {},
      devDependencies: { '@sveltejs/kit': '2.7.0', vite: '5.4.0' },
    },
    files: new Set(['package.json', 'svelte.config.js']),
  });
  eq('framework=sveltekit', r.framework, 'sveltekit');
});

await summary('w11/functional/detect-precedence');
