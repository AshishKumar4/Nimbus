#!/usr/bin/env bun
// X.5-drizzle regression: lock in that the *detector* (`detectFramework`)
// still returns `framework='vite', devCommand='vite-real'` for a generic
// vite project. Only the *aware-flag* derived from it narrows; the
// detector's pure-function output is unchanged.
//
// This is the anti-regression for the W11 detect-vite-generic.mjs
// invariant — paired with detect-aware-on-starter (which asserts
// frameworkAware=false post-fix), this probe asserts the detector
// itself is unchanged.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../../w11/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const { detectFramework } = await import(path.join(REPO, 'src', 'framework-detect.ts'));

await group('detect-vite-generic invariant', () => {
  const r = detectFramework({
    pkg: {
      dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: { vite: '5.4.0', '@vitejs/plugin-react': '4.3.0' },
    },
    files: new Set(['package.json', 'vite.config.ts', 'index.html']),
  });
  eq('framework=vite', r.framework, 'vite');
  eq('devCommand=vite-real', r.devCommand, 'vite-real');
  ok('confidence is 0.7 (step 8)', r.confidence === 0.7);
  ok('reason mentions vite', /vite/i.test(r.reason));
});

await summary('x5-drizzle/regression/w11-vite-generic-still-detects-as-vite');
