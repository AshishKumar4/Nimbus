// W11 functional: rule 0 — a SvelteKit-on-CF project (SK + wrangler.jsonc)
// detects framework=sveltekit BUT devCommand='wrangler-dev'. The framework's
// CF adapter is loaded by W10's wrangler-dev path. Per plan §4 step 0
// (reviewer comment 1).

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('SvelteKit + wrangler.jsonc → wrangler-dev', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: {},
      devDependencies: {
        '@sveltejs/kit': '2.7.0',
        '@sveltejs/adapter-cloudflare': '4.7.0',
        svelte: '5.0.0',
        vite: '5.4.0',
        wrangler: '3.78.0',
      },
    },
    files: new Set(['package.json', 'svelte.config.js', 'wrangler.jsonc']),
  });
  eq('framework=sveltekit (informational)', result.framework, 'sveltekit');
  eq('devCommand=wrangler-dev (overrides)', result.devCommand, 'wrangler-dev');
  ok('reason mentions wrangler', /wrangler/i.test(result.reason));
});

await group('Remix + wrangler.toml → wrangler-dev', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: { '@remix-run/cloudflare': '2.13.0', '@remix-run/react': '2.13.0' },
      devDependencies: { '@remix-run/dev': '2.13.0', vite: '5.4.0', wrangler: '3.78.0' },
    },
    files: new Set(['package.json', 'vite.config.ts', 'wrangler.toml']),
    fileContents: {
      'vite.config.ts': "import { vitePlugin as remix } from '@remix-run/dev';\nexport default { plugins: [remix()] };",
    },
  });
  eq('framework=remix (informational)', result.framework, 'remix');
  eq('devCommand=wrangler-dev (overrides)', result.devCommand, 'wrangler-dev');
});

await summary('w11/functional/detect-wrangler-on-framework');
