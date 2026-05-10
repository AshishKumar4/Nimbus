#!/usr/bin/env bun
// frameworks/remix — Remix probe.
//
// User flow:
//   npx create-remix@latest mvp --template remix-run/remix/templates/remix --no-git-init --no-install --yes
//   cd mvp && npm install
//   npm run dev
//
// Remix v2 dev server uses Vite under the hood. The initial HTML
// contains a <div id="root"> + a /<assets-build> manifest script tag.

import { runFrameworkProbe } from './_template.mjs';

const findings = await runFrameworkProbe({
  name: 'remix',
  workdir: 'fwprobe-remix',
  createCmd:
    'npx --yes create-remix@latest mvp --template remix-run/remix/templates/remix --no-git-init --no-install --yes',
  createTimeoutMs: 300_000,
  cdInto: 'mvp',
  installCmd: 'npm install',
  installTimeoutMs: 600_000,
  devCmd: 'npm run dev',
  devReadyMarkers: [
    'Remix',
    'Local:',
    'localhost:3000',
    'localhost:5173',
    'ready in',
    'http://localhost',
  ],
  devReadyTimeoutMs: 180_000,
  previewMarkers: [
    '__remixContext',
    '/@id/__x00__virtual:',  // Vite-virtual modules in Remix v2
    '/@react-refresh',
    'remix-route',
    '<script type="module"',
  ],
  previewMustNotContain: [
    'NIMBUS_ERROR',
    '<title>Error</title>',
    '500 Internal Server Error',
  ],
});

process.exit(findings.verdict === 'PASS' ? 0 : 1);
