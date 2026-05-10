#!/usr/bin/env bun
// frameworks/cloudflare-pages — Cloudflare Pages / create-cloudflare probe.
//
// User flow:
//   npm create cloudflare@latest mvp -- --type=hello-world --no-deploy --no-git --no-open --no-ts --yes
//
// `create-cloudflare` (a.k.a. `c3`) supports CLI flags for fully
// non-interactive scaffold. Output is typically a wrangler-only
// (no framework) Worker project for `--type=hello-world`. Dev runs
// via `wrangler dev`.
//
// Preview markers: depends on the template; for hello-world the
// dev server returns a plain "Hello World!" text response.

import { runFrameworkProbe } from './_template.mjs';

const findings = await runFrameworkProbe({
  name: 'cloudflare-pages',
  workdir: 'fwprobe-cf-pages',
  createCmd: 'npm create cloudflare@latest mvp -- --type=hello-world --no-deploy --no-git --no-open --no-ts --yes',
  createTimeoutMs: 300_000,
  cdInto: 'mvp',
  installCmd: null, // c3 installs as part of create
  devCmd: 'npm run dev',
  devReadyMarkers: [
    'Ready on',
    'Listening on',
    'localhost:8787',
    'http://localhost',
    'wrangler',
    'Local:',
  ],
  devReadyTimeoutMs: 120_000,
  previewMarkers: [
    'Hello',
    '<html',
    'wrangler',
  ],
  previewMustNotContain: [
    'NIMBUS_ERROR',
    '<title>Error</title>',
    '500 Internal Server Error',
  ],
});

process.exit(findings.verdict === 'PASS' ? 0 : 1);
