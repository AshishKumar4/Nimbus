#!/usr/bin/env bun
// X.5-drizzle functional — confirms current detectFramework on the
// starter pkg.json returns the generic-vite verdict (step 8 of
// framework-detect.ts). This is the *upstream* signal that VERIFY-9D4B61D
// §3 misattributed as the cause of the drizzle-orm regression.
// Phase A investigation (audit/probes/x5-drizzle/investigation/04-...)
// proved that the regression actually flows through drizzle-orm's
// optional peer `expo-sqlite` (X.5-J R2.5 enqueue) → expo →
// @expo/metro-config → lightningcss, NOT through the framework-detect
// vite pull-in. The fix is therefore in src/npm-resolver.ts +
// src/npm-resolve-facet.ts (best-effort soft-skip), NOT in the
// framework-detect heuristic.
//
// This probe stays GREEN through the src change — it only exercises
// the detector contract, which is unchanged.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../../w11/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const { detectFramework } = await import(path.join(REPO, 'src', 'runtime', 'framework-detect.ts'));

await group('starter-shape pkg.json triggers detectFramework=vite (step 8)', () => {
  const result = detectFramework({
    pkg: {
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        'react-router-dom': '^6.26.0',
      },
      devDependencies: {
        vite: '^5.4.0',
        tailwindcss: '^3.4.17',
      },
      scripts: { dev: 'vite' },
    },
    files: new Set(['package.json', 'index.html', 'vite.config.ts']),
  });
  eq('detector returns framework=vite', result.framework, 'vite');
  eq('detector returns devCommand=vite-real', result.devCommand, 'vite-real');
  ok('detector confidence=0.7 (step 8)', result.confidence === 0.7);
});

await summary('x5-drizzle/functional/detect-aware-on-starter');
