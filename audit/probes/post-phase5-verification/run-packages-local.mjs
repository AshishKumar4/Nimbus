#!/usr/bin/env bun
// Post-Phase-5 verification: top-30 (33) package compat probe LOCALLY against
// `wrangler dev` on http://127.0.0.1:8787. Same TARGETS list as
// audit/probes/run-packages-prod-w26a.mjs (the W2.6a baseline) so the result
// is trivially comparable.
//
// Output: audit/probes/post-phase5-verification/packages-local/<name>.out.txt
//         + _SUMMARY.json
//
// Tally is computed by classify-packages.mjs convention: ✅ if the smoke
// command's stdout matches the expected pattern (keys/typeof/etc), ⚠ if
// install succeeds but smoke fails, ❌ if install fails.

import { runProbe, runMany } from '../_driver.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'packages-local');
fs.mkdirSync(OUT_DIR, { recursive: true });

// TARGETS list copied verbatim from run-packages-prod-w26a.mjs.
const TARGETS = [
  { name: 'sharp',                pkg: 'sharp',                smoke: `const m=require('sharp');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'fsevents',             pkg: 'fsevents',             smoke: `const m=require('fsevents');console.log('typeof:',typeof m)` },
  { name: 'bcrypt',               pkg: 'bcrypt',               smoke: `const m=require('bcrypt');console.log('hash:',m.hashSync('x',4))` },
  { name: 'better-sqlite3',       pkg: 'better-sqlite3',       smoke: `const m=require('better-sqlite3');console.log('typeof:',typeof m)` },
  { name: 'prisma',               pkg: 'prisma',               smoke: `const m=require('prisma');console.log('typeof:',typeof m)` },
  { name: 'swc-core',             pkg: '@swc/core',            smoke: `const m=require('@swc/core');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'tailwindcss-oxide',    pkg: '@tailwindcss/oxide',   smoke: `const m=require('@tailwindcss/oxide');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'node-canvas',          pkg: 'canvas',               smoke: `const m=require('canvas');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'vite',                 pkg: 'vite',                 smoke: `const m=require('vite');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'webpack',              pkg: 'webpack',              smoke: `const m=require('webpack');console.log('typeof:',typeof m)` },
  { name: 'rollup',               pkg: 'rollup',               smoke: `const m=require('rollup');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'parcel',               pkg: 'parcel',               smoke: `const m=require('parcel');console.log('typeof:',typeof m)` },
  { name: 'next',                 pkg: 'next',                 smoke: `const m=require('next');console.log('typeof:',typeof m)` },
  { name: 'nuxt',                 pkg: 'nuxt',                 smoke: `const m=require('nuxt');console.log('typeof:',typeof m)` },
  { name: 'remix-react',          pkg: '@remix-run/react',     smoke: `const m=require('@remix-run/react');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'astro',                pkg: 'astro',                smoke: `const m=require('astro');console.log('typeof:',typeof m)` },
  { name: 'jsdom',                pkg: 'jsdom',                smoke: `const m=require('jsdom');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'puppeteer-core',       pkg: 'puppeteer-core',       smoke: `const m=require('puppeteer-core');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'express',              pkg: 'express',              smoke: `const m=require('express');const a=m();console.log('app keys:',Object.keys(a).slice(0,6))` },
  { name: 'fastify',              pkg: 'fastify',              smoke: `const m=require('fastify');const a=m();console.log('app title:',a.constructor && a.constructor.name)` },
  { name: 'axios',                pkg: 'axios',                smoke: `const m=require('axios');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'zod',                  pkg: 'zod',                  smoke: `const m=require('zod');console.log('parse:',m.string().parse('hi'))` },
  { name: 'framer-motion',        pkg: 'framer-motion',        smoke: `const m=require('framer-motion');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'radix-react-dialog',   pkg: '@radix-ui/react-dialog', smoke: `const m=require('@radix-ui/react-dialog');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'react-remove-scroll',  pkg: 'react-remove-scroll',  smoke: `const m=require('react-remove-scroll');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'vitest',               pkg: 'vitest',               smoke: `const m=require('vitest');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'jest',                 pkg: 'jest',                 smoke: `const m=require('jest');console.log('typeof:',typeof m)` },
  { name: 'ts-jest',              pkg: 'ts-jest',              smoke: `const m=require('ts-jest');console.log('typeof:',typeof m)` },
  { name: 'pg',                   pkg: 'pg',                   smoke: `const m=require('pg');console.log('keys:',Object.keys(m).slice(0,6))` },
  { name: 'redis',                pkg: 'redis',                smoke: `const m=require('redis');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'drizzle-orm',          pkg: 'drizzle-orm',          smoke: `const m=require('drizzle-orm');console.log('keys:',Object.keys(m).slice(0,8))` },
  { name: 'ts-node',              pkg: 'ts-node',              smoke: `const m=require('ts-node');console.log('typeof:',typeof m)` },
  { name: 'tailwindcss-vite',     pkg: '@tailwindcss/vite',    smoke: `const m=require('@tailwindcss/vite');console.log('typeof:',typeof m)` },
];

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8787 explicitly so we hit local wrangler-dev, not prod.');
  process.exit(2);
}

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
  const id = `pkgsmoke_${Date.now().toString(36)}`;
  const b64 = Buffer.from(t.smoke, 'utf8').toString('base64');
  const writeCmd = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const runCmd = `cd /home/user/app && node .${id}.js`;
  const r = await runProbe(t.name, [
    { kind: 'cmd', cmd: `cd app && npm install ${t.pkg}`, timeoutMs: 240_000 },
    { kind: 'cmd', cmd: `${writeCmd} && ${runCmd}`, timeoutMs: 30_000 },
  ], { artifactPath, settleMs: 3000 });
  console.log(`[DONE] ${t.name} ok=${r.ok}`);
  return { name: t.name, ok: r.ok };
});

// Concurrency=1 — local wrangler-dev can't comfortably handle 2× parallel
// install+facet workloads (verification-wave initial run died after ~10
// packages with concurrency=2). Trade more wall-clock for stability.
console.log(`Running ${jobs.length} package probes (concurrency=1) → ${OUT_DIR}`);
const results = await runMany(jobs, 1);
fs.writeFileSync(path.join(OUT_DIR, '_SUMMARY.json'), JSON.stringify(results, null, 2));
console.log('Done.');
