#!/usr/bin/env bun
// frameworks/astro — Astro probe.
//
// User flow:
//   npm create astro@latest mvp -- --template basics --no-install --no-git --skip-houston --yes
//   cd mvp && npm install
//   npm run dev
//
// Astro dev server SSRs the basics template's index.astro and emits
// an HTML page with <astro-island> custom elements + a runtime
// <script type="module" src="/@vite/client">. We assert these markers.

import { runFrameworkProbe } from './_template.mjs';

const findings = await runFrameworkProbe({
  name: 'astro',
  workdir: 'fwprobe-astro',
  createCmd: 'npm create astro@latest mvp -- --template basics --no-install --no-git --skip-houston --yes',
  createTimeoutMs: 300_000,
  cdInto: 'mvp',
  installCmd: 'npm install',
  installTimeoutMs: 600_000,
  devCmd: 'npm run dev',
  devReadyMarkers: [
    'astro',
    'localhost:4321',
    'localhost:3000',
    'Local:',
    'ready in',
    'Network:',
  ],
  devReadyTimeoutMs: 120_000,
  previewMarkers: [
    '<astro-',         // Astro-specific markers (astro-island, astro-slot, etc.)
    'astro:',          // astro: prefixed scripts
    '<!doctype html>',
    '<html',
  ],
  previewMustNotContain: [
    'Cannot GET',
    'NIMBUS_ERROR',
    '<title>Error</title>',
    '500 Internal Server Error',
  ],
});

process.exit(findings.verdict === 'PASS' ? 0 : 1);
