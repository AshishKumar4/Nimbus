#!/usr/bin/env node
/**
 * Assemble the hosted-demo deploy assets directory (dist/assets):
 *
 *   dist/assets/          ← @nimbus-sh/worker/public (session shell, landing page)
 *   dist/assets/docs/     ← apps/docs build (Astro/Starlight, base /docs)
 *
 * A Worker gets exactly one assets binding, so the docs site and the app
 * shell must ship as one directory. This script is the single source of
 * that directory — wrangler.jsonc points its assets binding here, and the
 * predev/predeploy hooks run it, so every deploy carries fresh docs.
 *
 * NIMBUS_DOCS_ORIGIN (default https://nimbus.ashishkumarsingh.com) selects
 * the deploy target's origin. The docs live terminal needs an absolute
 * endpoint URL at build time (NimbusSandbox resolves the returned wsUrl
 * against it), so staging probes must rebuild with their own origin.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostedDemoDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(hostedDemoDir));
const docsDir = join(repoRoot, 'apps', 'docs');
const workerPublicDir = join(hostedDemoDir, 'node_modules', '@nimbus-sh', 'worker', 'public');
const outDir = join(hostedDemoDir, 'dist', 'assets');

const origin = process.env.NIMBUS_DOCS_ORIGIN?.trim() || 'https://nimbus.ashishkumarsingh.com';
if (!/^https?:\/\/[^/]+$/.test(origin)) {
  throw new Error(`NIMBUS_DOCS_ORIGIN must be a bare http(s) origin, got: ${origin}`);
}
const anonAttachUrl = `${origin}/api/demo/anon-session`;

console.log(`[build-assets] building docs (anon endpoint: ${anonAttachUrl})`);
execFileSync('bun', ['run', 'build'], {
  cwd: docsDir,
  stdio: 'inherit',
  env: { ...process.env, PUBLIC_NIMBUS_ANON_ATTACH_URL: anonAttachUrl },
});

const docsBuildDir = join(docsDir, 'dist', 'docs');
if (!existsSync(join(docsBuildDir, 'index.html'))) {
  throw new Error(`docs build produced no ${docsBuildDir}/index.html`);
}
if (!existsSync(join(workerPublicDir, 'index.html'))) {
  throw new Error(`worker public assets missing at ${workerPublicDir}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(workerPublicDir, outDir, { recursive: true, dereference: true });
cpSync(docsBuildDir, join(outDir, 'docs'), { recursive: true });

console.log(`[build-assets] assembled ${outDir}`);
