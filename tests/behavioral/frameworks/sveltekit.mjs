#!/usr/bin/env bun
// frameworks/sveltekit — SvelteKit probe.
//
// User flow:
//   npm create svelte@latest mvp -- --template skeleton --types ts --no-add-prettier --no-add-eslint --no-add-playwright --no-add-vitest --no-add-svelte5
//   cd mvp && npm install
//   npm run dev
//
// SvelteKit dev server uses Vite. Initial HTML contains a
// <div data-sveltekit-...> root + /@vite/client + /@id/__sveltekit/.

import { runFrameworkProbe } from './_template.mjs';

const findings = await runFrameworkProbe({
  name: 'sveltekit',
  workdir: 'fwprobe-sveltekit',
  // create-svelte@latest is now `sv create`; npm create svelte@latest
  // still works as a compat alias.
  createCmd:
    'npm create svelte@latest mvp -- --template skeleton --types ts --no-add-prettier --no-add-eslint --no-add-playwright --no-add-vitest',
  createTimeoutMs: 300_000,
  cdInto: 'mvp',
  installCmd: 'npm install',
  installTimeoutMs: 600_000,
  devCmd: 'npm run dev',
  devReadyMarkers: [
    'SvelteKit',
    'Local:',
    'localhost:5173',
    'localhost:3000',
    'ready in',
    'VITE v',
  ],
  devReadyTimeoutMs: 180_000,
  previewMarkers: [
    '<div style="display: contents">',
    'data-sveltekit',
    '__sveltekit',
    '/@vite/client',
    '<script type="module"',
  ],
  previewMustNotContain: [
    'NIMBUS_ERROR',
    '<title>Error</title>',
    '500 Internal Server Error',
  ],
});

process.exit(findings.verdict === 'PASS' ? 0 : 1);
