#!/usr/bin/env bun
// frameworks/nuxt — Nuxt probe.
//
// User flow:
//   npx nuxi@latest init mvp --no-install --no-gitInit
//   cd mvp && npm install
//   npm run dev
//
// Nuxt dev server uses Vite under the hood; the response includes
// hydration data + the Vue runtime client.

import { runFrameworkProbe } from './_template.mjs';

const findings = await runFrameworkProbe({
  name: 'nuxt',
  workdir: 'fwprobe-nuxt',
  // nuxi init flags: --no-install (we control install), --no-gitInit
  createCmd: 'npx --yes nuxi@latest init mvp --no-install --no-gitInit --packageManager=npm',
  createTimeoutMs: 300_000,
  cdInto: 'mvp',
  installCmd: 'npm install',
  installTimeoutMs: 600_000,
  devCmd: 'npm run dev',
  devReadyMarkers: [
    'Nuxt',
    'Local:',
    'localhost:3000',
    'Vite client',
    'ready in',
  ],
  devReadyTimeoutMs: 180_000,
  previewMarkers: [
    '<div id="__nuxt"',
    '__NUXT__',
    '/_nuxt/',
    'nuxt-link',
    '<script type="module"',
  ],
  previewMustNotContain: [
    'NIMBUS_ERROR',
    '<title>Error</title>',
    '500 Internal Server Error',
  ],
});

process.exit(findings.verdict === 'PASS' ? 0 : 1);
