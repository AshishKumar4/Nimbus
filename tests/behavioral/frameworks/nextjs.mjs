#!/usr/bin/env bun
// frameworks/nextjs — Next.js probe.
//
// User flow:
//   npx create-next-app@latest mvp --ts --no-eslint --tailwind --app --src-dir --import-alias '@/*' --use-npm --yes
//   cd mvp
//   npm run dev
//
// Next.js dev server SSRs the home page; the response contains
// `__NEXT_DATA__` (the hydration JSON island) and a script tag pointing
// to /_next/static/chunks/.

import { runFrameworkProbe } from './_template.mjs';

const findings = await runFrameworkProbe({
  name: 'nextjs',
  workdir: 'fwprobe-nextjs',
  // --ts: TypeScript, --tailwind: tailwind, --app: app router,
  // --src-dir: src/ layout, --import-alias '@/*', --use-npm, --yes
  // accepts defaults non-interactively.
  createCmd:
    "npx --yes create-next-app@latest mvp --ts --no-eslint --tailwind --app --src-dir --import-alias '@/*' --use-npm --yes",
  createTimeoutMs: 360_000,
  cdInto: 'mvp',
  // create-next-app installs as part of create.
  installCmd: null,
  devCmd: 'npm run dev',
  devReadyMarkers: [
    'Next.js',
    'Ready in',
    'Local:',
    'localhost:3000',
    'compiled successfully',
  ],
  devReadyTimeoutMs: 180_000,
  previewMarkers: [
    '__NEXT_DATA__',
    '<script id="__NEXT_DATA__"',
    '/_next/',
    'next-route-announcer',
    '__next_f',  // app-router payload marker
  ],
  previewMustNotContain: [
    'NIMBUS_ERROR',
    '<title>Error</title>',
    '500 Internal Server Error',
  ],
});

process.exit(findings.verdict === 'PASS' ? 0 : 1);
