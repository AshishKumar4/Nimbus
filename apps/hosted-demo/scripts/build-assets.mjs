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
 * The docs live terminal's endpoint is this Worker's own
 * /api/demo/anon-session, given as a path: NimbusSandbox resolves it against
 * the page, so one build serves every origin the demo is deployed at, and
 * production gets the bytes staging verified.
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

const anonAttachUrl = '/api/demo/anon-session';

// `--docs <dir>`: assemble with a docs build made elsewhere (CI's, which
// scripts/ci/lib/release.mjs unpacks here before an upload), building
// nothing.
const docsAt = process.argv.indexOf('--docs');
const docsBuildDir = docsAt === -1 ? join(docsDir, 'dist', 'docs') : process.argv[docsAt + 1];
if (docsAt === -1) {
  console.log(`[build-assets] building docs (anon endpoint: ${anonAttachUrl})`);
  execFileSync('bun', ['run', 'build'], {
    cwd: docsDir,
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_NIMBUS_ANON_ATTACH_URL: anonAttachUrl },
  });
}

if (!existsSync(join(docsBuildDir, 'index.html'))) {
  throw new Error(`no docs build at ${docsBuildDir}: no index.html`);
}
if (!existsSync(join(workerPublicDir, 'index.html'))) {
  throw new Error(`worker public assets missing at ${workerPublicDir}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(workerPublicDir, outDir, { recursive: true, dereference: true });
cpSync(docsBuildDir, join(outDir, 'docs'), { recursive: true });

console.log(`[build-assets] assembled ${outDir}`);
