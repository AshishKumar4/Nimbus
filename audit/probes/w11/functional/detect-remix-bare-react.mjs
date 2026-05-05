// W11 functional: bare `@remix-run/react` without `@remix-run/dev`
// must NOT trigger the Remix CLI bridge — falls through to generic
// vite (or unknown). Per plan §4 step 4 (reviewer comment 1).

import { detectFramework } from '../_detect-mock.mjs';
import { ok, neq, group, summary } from '../_tap.mjs';

await group('bare @remix-run/react alone is not Remix', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: { '@remix-run/react': '2.13.0', react: '18.3.1', vite: '5.4.0' },
      devDependencies: {},
    },
    files: new Set(['package.json', 'vite.config.ts']),
    fileContents: {
      'vite.config.ts': 'export default {};',
    },
  });
  neq('framework not remix', result.framework, 'remix');
  ok('framework is vite (or unknown)', result.framework === 'vite' || result.framework === 'unknown');
});

await summary('w11/functional/detect-remix-bare-react');
