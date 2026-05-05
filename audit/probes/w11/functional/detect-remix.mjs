// W11 functional: detectFramework recognizes Remix v2 (vite-plugin path).

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('detect Remix v2 (vite plugin)', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: {
        '@remix-run/react': '2.13.0',
        '@remix-run/node': '2.13.0',
        react: '18.3.1',
      },
      devDependencies: {
        '@remix-run/dev': '2.13.0',
        vite: '5.4.0',
      },
    },
    files: new Set(['package.json', 'vite.config.ts']),
    // Remix gate (plan §4 step 4): vite.config must reference @remix-run/dev
    fileContents: {
      'vite.config.ts': "import { vitePlugin as remix } from '@remix-run/dev';\nexport default { plugins: [remix()] };",
    },
  });
  eq('framework=remix', result.framework, 'remix');
  eq('devCommand=remix-cli', result.devCommand, 'remix-cli');
  ok('confidence high', result.confidence >= 0.7);
});

await summary('w11/functional/detect-remix');
