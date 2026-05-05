// W11 functional: a plain Vite + React project (no framework) detects as 'vite'.

import { detectFramework } from '../_detect-mock.mjs';
import { ok, eq, group, summary } from '../_tap.mjs';

await group('detect generic Vite project', async () => {
  const result = await detectFramework({
    pkg: {
      dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: { vite: '5.4.0', '@vitejs/plugin-react': '4.3.0' },
    },
    files: new Set(['package.json', 'vite.config.ts', 'index.html']),
  });
  eq('framework=vite', result.framework, 'vite');
  eq('devCommand=vite-real', result.devCommand, 'vite-real');
});

await summary('w11/functional/detect-vite-generic');
