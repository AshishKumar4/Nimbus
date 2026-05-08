#!/usr/bin/env bun
// X.5-drizzle regression: confirms the detector verdict for a
// Mossaic-shape project is unchanged (still framework=vite,
// devCommand=vite-real, confidence=0.7). The W11 detector contract is
// the load-bearing invariant; X.5-drizzle's fix lives in the resolver
// (npm-resolver.ts + npm-resolve-facet.ts), not in framework-detect,
// so this probe stays GREEN at all times.
//
// W11-retro §4 #8 stated intent: "Mossaic regression on prod ... W11
// changes to install path are gated by `frameworkAware` flag which is
// `false` for Mossaic". Per Phase A investigation 02 the current code
// returns aware=true for Mossaic — that's a separate hygiene issue
// surfaced but not fixed by X.5-drizzle (see retro §6).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../../w11/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const { detectFramework } = await import(path.join(REPO, 'src', 'runtime', 'framework-detect.ts'));

const MOSSAIC_LIKE = {
  pkg: {
    dependencies: {
      react: '18.3.1',
      'react-dom': '18.3.1',
      'react-router-dom': '6.26.0',
      zustand: '4.5.0',
      'lucide-react': '0.460.0',
    },
    devDependencies: {
      vite: '5.4.0',
      '@vitejs/plugin-react': '4.3.0',
      typescript: '5.5.0',
      tailwindcss: '3.4.17',
    },
    scripts: { dev: 'vite', build: 'vite build' },
  },
  files: new Set(['package.json', 'vite.config.ts', 'index.html', 'tsconfig.json']),
};

await group('Mossaic-shape detector verdict (W11 detector contract)', () => {
  const r = detectFramework(MOSSAIC_LIKE);
  eq('detector framework=vite', r.framework, 'vite');
  eq('detector devCommand=vite-real', r.devCommand, 'vite-real');
  ok('detector confidence=0.7', r.confidence === 0.7);
});

await summary('x5-drizzle/regression/mossaic-regression-coverage');
