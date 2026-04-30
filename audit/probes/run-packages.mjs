// Phase 2: top-30+ npm package compatibility on prod Nimbus.
// Per package: fresh session → npm install → smoke import via base64-loaded /tmp script.
// Output to audit/probes/packages/<name>.out.txt.

import { runProbe, nodeEvalBase64, runMany } from './_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'packages');

const TARGETS = [
  // Native bindings
  { name: 'sharp',                pkg: 'sharp',                smoke: `const m=require('sharp');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'fsevents',             pkg: 'fsevents',             smoke: `const m=require('fsevents');console.log('typeof:',typeof m)` },
  { name: 'bcrypt',               pkg: 'bcrypt',               smoke: `const m=require('bcrypt');console.log('hash:',m.hashSync('x',4))` },
  { name: 'better-sqlite3',       pkg: 'better-sqlite3',       smoke: `const m=require('better-sqlite3');console.log('typeof:',typeof m)` },
  { name: 'prisma',               pkg: 'prisma',               smoke: `const m=require('prisma');console.log('typeof:',typeof m)` },
  { name: 'swc-core',             pkg: '@swc/core',            smoke: `const m=require('@swc/core');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'tailwindcss-oxide',    pkg: '@tailwindcss/oxide',   smoke: `const m=require('@tailwindcss/oxide');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'node-canvas',          pkg: 'canvas',               smoke: `const m=require('canvas');console.log('keys:',Object.keys(m).slice(0,6))` },

  // Build tools
  { name: 'vite',                 pkg: 'vite',                 smoke: `const m=require('vite');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'webpack',              pkg: 'webpack',              smoke: `const m=require('webpack');console.log('typeof:',typeof m)` },
  { name: 'rollup',               pkg: 'rollup',               smoke: `const m=require('rollup');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'parcel',               pkg: 'parcel',               smoke: `const m=require('parcel');console.log('typeof:',typeof m)` },

  // Frameworks
  { name: 'next',                 pkg: 'next',                 smoke: `const m=require('next');console.log('typeof:',typeof m)` },
  { name: 'nuxt',                 pkg: 'nuxt',                 smoke: `const m=require('nuxt');console.log('typeof:',typeof m)` },
  { name: 'remix-react',          pkg: '@remix-run/react',     smoke: `const m=require('@remix-run/react');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'astro',                pkg: 'astro',                smoke: `const m=require('astro');console.log('typeof:',typeof m)` },

  // Polyfills
  { name: 'jsdom',                pkg: 'jsdom',                smoke: `const {JSDOM}=require('jsdom');console.log('title:',new JSDOM('<p>x</p>').window.document.querySelector('p').textContent)` },
  { name: 'puppeteer-core',       pkg: 'puppeteer-core',       smoke: `const m=require('puppeteer-core');console.log('keys:',Object.keys(m).slice(0,6))` },

  // Common deps
  { name: 'express',              pkg: 'express',              smoke: `const m=require('express');const a=m();console.log('app keys:',Object.keys(a).slice(0,6))` },
  { name: 'fastify',              pkg: 'fastify',              smoke: `const m=require('fastify');const a=m();console.log('keys:',Object.keys(a).slice(0,6))` },
  { name: 'axios',                pkg: 'axios',                smoke: `const m=require('axios');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'zod',                  pkg: 'zod',                  smoke: `const z=require('zod');console.log('parse:',z.string().parse('hi'))` },

  // React eco
  { name: 'framer-motion',        pkg: 'framer-motion react@18.3.1 react-dom@18.3.1', smoke: `const m=require('framer-motion');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'radix-react-dialog',   pkg: '@radix-ui/react-dialog react@18.3.1 react-dom@18.3.1', smoke: `const m=require('@radix-ui/react-dialog');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'react-remove-scroll',  pkg: 'react-remove-scroll react@18.3.1 react-dom@18.3.1', smoke: `const m=require('react-remove-scroll');console.log('keys:',Object.keys(m).slice(0,6))` },

  // Tests
  { name: 'vitest',               pkg: 'vitest',               smoke: `const m=require('vitest');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'jest',                 pkg: 'jest',                 smoke: `const m=require('jest');console.log('typeof:',typeof m)` },
  { name: 'ts-jest',              pkg: 'ts-jest jest typescript', smoke: `const m=require('ts-jest');console.log('keys:',Object.keys(m).slice(0,6))` },

  // DBs
  { name: 'pg',                   pkg: 'pg',                   smoke: `const m=require('pg');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'redis',                pkg: 'redis',                smoke: `const m=require('redis');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'drizzle-orm',          pkg: 'drizzle-orm',          smoke: `const m=require('drizzle-orm');console.log('keys:',Object.keys(m).slice(0,6))` },

  // Tools
  { name: 'ts-node',              pkg: 'ts-node typescript',   smoke: `const m=require('ts-node');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'tailwindcss-vite',     pkg: '@tailwindcss/vite tailwindcss', smoke: `const m=require('@tailwindcss/vite');console.log('typeof:',typeof m)` },
];

const skipExisting = process.argv.includes('--skip-existing');
const onlyName = process.argv.find(a => a.startsWith('--only='))?.split('=')[1];
const targets = onlyName ? TARGETS.filter(t => t.name === onlyName) : TARGETS;

const jobs = targets.map(t => async () => {
  const artifactPath = path.join(OUT_DIR, `${t.name}.out.txt`);
  if (skipExisting && fs.existsSync(artifactPath) && fs.statSync(artifactPath).size > 200) {
    console.log(`[SKIP] ${t.name}`);
    return { name: t.name, skipped: true };
  }
  fs.writeFileSync(artifactPath, '');
  fs.writeFileSync(path.join(OUT_DIR, `${t.name}.probe.js`), t.smoke);
  console.log(`[START] ${t.name}`);
  // Smoke step uses the file-write helper but the resulting `node /tmp/p_X.js`
  // runs with cwd=/tmp; require() walks up from /tmp and never sees the app's
  // node_modules. Fix: write the script directly inside ~/app so resolution
  // starts from the project root.
  const id = `pkgsmoke_${Date.now().toString(36)}`;
  const b64 = Buffer.from(t.smoke, 'utf8').toString('base64');
  const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const runCmd = `cd /home/user/app && node .${id}.js`;
  const r = await runProbe(t.name, [
    { kind: 'cmd', cmd: `cd app && npm install ${t.pkg}`, timeoutMs: 180_000 },
    { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 20_000 },
  ], { artifactPath, settleMs: 3000 });
  console.log(`[DONE] ${t.name} ok=${r.ok}`);
  return { name: t.name, ok: r.ok };
});

console.log(`Running ${jobs.length} package probes (concurrency=3)...`);
const results = await runMany(jobs, 3);
fs.writeFileSync(path.join(OUT_DIR, '_SUMMARY.json'), JSON.stringify(results, null, 2));
console.log('Done.');
