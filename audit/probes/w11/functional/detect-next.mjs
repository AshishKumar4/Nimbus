// W11 functional: detectFramework recognizes a Next.js project.
// RED on tip of main (no src/framework-detect.ts).

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('detect Next.js', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: { next: '14.2.0', react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: {},
    },
    files: new Set(['package.json', 'next.config.js', 'pages']),
  });
  eq('framework=next', result.framework, 'next');
  eq('devCommand=next-cli', result.devCommand, 'next-cli');
  ok('confidence high', result.confidence >= 0.7);
  ok('reason mentions next', /next/i.test(result.reason));
});

await summary('w11/functional/detect-next');
