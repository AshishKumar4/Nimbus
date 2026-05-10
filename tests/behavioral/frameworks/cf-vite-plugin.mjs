#!/usr/bin/env bun
// frameworks/cf-vite-plugin — CF Vite Plugin probe.
//
// User flow:
//   npm create vite@latest mvp -- --template react-ts --yes
//   cd mvp
//   npm install
//   npm install @cloudflare/vite-plugin
//   echo 'import { cloudflare } from "@cloudflare/vite-plugin"; export default { plugins: [cloudflare()] }' > vite.config.ts
//   npm run dev
//
// Preview markers: <div id="root"></div> + <script type="module">
// (Vite's default index.html for the react-ts template).
// CF Vite Plugin specifically: dev server should serve same SPA shell;
// difference vs vanilla vite is the plugin registers worker-style
// handlers for /api/* paths (which we don't exercise in v1).
//
// REQUIRED for vite+workers (Markflow-class). User priority #1.

import { runFrameworkProbe } from './_template.mjs';

const findings = await runFrameworkProbe({
  name: 'cf-vite-plugin',
  workdir: 'fwprobe-cf-vite',
  // Use non-interactive flags. The `--` separator passes flags to
  // the create-vite tool, not npm.
  createCmd: 'npm create vite@latest mvp -- --template react-ts --yes',
  createTimeoutMs: 240_000,
  cdInto: 'mvp',
  installCmd: 'npm install && npm install @cloudflare/vite-plugin',
  installTimeoutMs: 600_000,
  devCmd: 'npm run dev',
  devReadyMarkers: [
    'Local:',
    'ready in',
    'localhost:5173',
    'Network:',
    'Nimbus Vite Dev Server',
    'VITE v',
  ],
  devReadyTimeoutMs: 120_000,
  previewMarkers: [
    '<div id="root"',
    '<script type="module"',
    '/@vite/client',
  ],
  previewMustNotContain: [
    'Cannot GET',
    'Error: ',
    'NIMBUS_ERROR',
    '<title>Error</title>',
    '500 Internal Server Error',
  ],
  extraPreviewPaths: [
    '@vite/client',
    'src/main.tsx',
  ],
});

process.exit(findings.verdict === 'PASS' ? 0 : 1);
