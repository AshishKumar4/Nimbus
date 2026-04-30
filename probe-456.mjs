/**
 * probe-456.mjs — scale-up repro mimicking a personal-website-shaped install.
 *
 * Replaces the seed package.json with one whose transitive close to ~456
 * packages (next/react/typescript/tailwind/lots of utility libs), then runs
 * `npm install` and watches counters every 1s.
 *
 * Bet criteria:
 *   - WS stays open
 *   - vfs.files > 40000 (was wrong "4000" earlier, real bet is 40k+)
 *   - No banner reprint (DO restart)
 *   - counters confirm install ran in facet
 */

import WebSocket from 'ws';
import fs from 'node:fs';

const BASE = process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev';
const TIMEOUT_S = parseInt(process.env.TIMEOUT_S || '600', 10); // 10 min
const TARGET_FILES = 40000;

// Personal-website-shaped package.json. Mix of large libs known to fan
// out heavily: framer-motion, react-router, lucide, clsx, tailwind utilities,
// mdx, remark, rehype ecosystem, etc. The goal is a transitive count
// close to 456+ packages.
// Approximation of a real personal-website package.json. Targets ~456
// transitive packages to match the user's stated scale.
const PERSONAL_WEBSITE_PKG = {
  name: 'personal-website-repro',
  private: true,
  version: '0.1.0',
  type: 'module',
  dependencies: {
    'react': '^18.3.1',
    'react-dom': '^18.3.1',
    'react-router-dom': '^6.26.0',
    'framer-motion': '^11.11.0',
    'lucide-react': '^0.460.0',
    'clsx': '^2.1.1',
    'class-variance-authority': '^0.7.1',
    'tailwind-merge': '^2.5.4',
    '@radix-ui/react-dialog': '^1.1.2',
    '@radix-ui/react-tooltip': '^1.1.4',
    '@radix-ui/react-dropdown-menu': '^2.1.2',
    '@radix-ui/react-accordion': '^1.2.1',
    '@radix-ui/react-tabs': '^1.1.1',
    '@radix-ui/react-toast': '^1.2.2',
    '@radix-ui/react-select': '^2.1.2',
    '@radix-ui/react-popover': '^1.1.2',
    '@radix-ui/react-checkbox': '^1.1.2',
    '@radix-ui/react-switch': '^1.1.1',
    '@radix-ui/react-slider': '^1.2.1',
    '@radix-ui/react-progress': '^1.1.0',
    '@radix-ui/react-avatar': '^1.1.1',
    '@radix-ui/react-label': '^2.1.0',
    '@radix-ui/react-radio-group': '^1.2.1',
    '@radix-ui/react-separator': '^1.1.0',
    '@radix-ui/react-scroll-area': '^1.2.0',
    'date-fns': '^4.1.0',
    'zod': '^3.23.8',
    'next-themes': '^0.4.3',
    'sonner': '^1.7.0',
    'react-hook-form': '^7.53.2',
    '@hookform/resolvers': '^3.9.1',
    'react-markdown': '^9.0.1',
    'remark-gfm': '^4.0.0',
    'rehype-highlight': '^7.0.1',
    'cmdk': '^1.0.4',
    'embla-carousel-react': '^8.4.0',
    'recharts': '^2.13.3',
    'zustand': '^5.0.1',
    'jotai': '^2.10.3',
    // More fan-out
    '@tanstack/react-query': '^5.59.20',
    '@tanstack/react-table': '^8.20.6',
    '@tanstack/react-virtual': '^3.10.9',
    'react-day-picker': '^9.4.1',
    'react-resizable-panels': '^2.1.7',
    '@radix-ui/react-aspect-ratio': '^1.1.0',
    '@radix-ui/react-collapsible': '^1.1.1',
    '@radix-ui/react-context-menu': '^2.2.2',
    '@radix-ui/react-hover-card': '^1.1.2',
    '@radix-ui/react-menubar': '^1.1.2',
    '@radix-ui/react-navigation-menu': '^1.2.1',
    '@radix-ui/react-toggle': '^1.1.0',
    '@radix-ui/react-toggle-group': '^1.1.0',
    'mdast-util-from-markdown': '^2.0.2',
    'mdast-util-to-hast': '^13.2.0',
    'unified': '^11.0.5',
    'remark-parse': '^11.0.0',
    'rehype-stringify': '^10.0.1',
    'react-icons': '^5.3.0',
    'react-helmet-async': '^2.0.5',
    'react-intersection-observer': '^9.13.1',
    'embla-carousel-autoplay': '^8.4.0',
    'embla-carousel-fade': '^8.4.0',
    'react-error-boundary': '^4.1.2',
    'use-debounce': '^10.0.4',
  },
};

const r = await fetch(BASE + '/new', { method: 'POST', redirect: 'manual' });
const sid = r.headers.get('location').match(/\/s\/([^\/]+)/)[1];
console.log('sid=' + sid);
console.log('shell URL:', BASE + '/s/' + sid + '/');

const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/s/' + sid + '/ws');
let o = '';
let wsClosed = false;
let wsCloseInfo = null;
w.on('open', () => w.send(JSON.stringify({ type: 'resize', cols: 200, rows: 60 })));
w.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'output') o += m.data;
});
w.on('error', (e) => console.log('WS error:', e.message));
w.on('close', (code, reason) => {
  wsClosed = true;
  wsCloseInfo = { code, reason: String(reason) };
  console.log('WS closed:', code, String(reason));
});

const cmd = (c) => w.send(JSON.stringify({ type: 'input', data: c + '\r' }));
const strip = (s) => s.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, '');
const probe = async () => {
  try {
    const r = await fetch(BASE + '/s/' + sid + '/api/_diag/memory');
    return await r.json();
  } catch (e) { return null; }
};

await new Promise((r) => setTimeout(r, 4000));

// Overwrite the seed package.json. Strategy: use the API endpoint
// directly. The shell's `>` redirect / heredocs are fragile through
// the WS protocol — go around it via /api/write-file.
const pkgJsonContent = JSON.stringify(PERSONAL_WEBSITE_PKG, null, 2);
console.log('-- writing custom package.json via /api/write-file --');
const wresp = await fetch(BASE + '/s/' + sid + '/api/write-file', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: 'home/user/app/package.json',
    content: pkgJsonContent,
  }),
});
console.log('write-file:', wresp.status, await wresp.text());
await new Promise((r) => setTimeout(r, 500));
cmd('cd app && cat package.json | head -25');
await new Promise((r) => setTimeout(r, 1500));

console.log('-- npm install issued --');
cmd('npm install');

const startedAt = Date.now();
let succeeded = false;
let bannerReprinted = false;
let bestSnapshot = null;
let lastSnapshot = null;

const ticks = TIMEOUT_S;
for (let i = 0; i < ticks; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const m = await probe();
  if (!m) continue;
  lastSnapshot = m;
  const c = m.counters || {};
  const inst = c.installFacet || {};
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  if ((inst.tarballsCompleted || 0) >= (bestSnapshot?.installFacet?.tarballsCompleted ?? 0)) {
    bestSnapshot = c;
  }

  console.log(
    `[${elapsed}s] phase=${c.installPhase} ` +
    `resolver=${c.resolverPath}(pkts=${c.packumentsDecoded || 0}/${(c.cumulativePackumentBytesDecoded / 1048576 || 0).toFixed(1)}MiB) ` +
    `install=${inst.path}(${inst.tarballsCompleted || 0}t/${(inst.cumulativeBytesDecoded / 1048576 || 0).toFixed(1)}MiB pk=${inst.peakInFlight || 0}) ` +
    `files=${m.vfs?.files} ws=${wsClosed ? 'CLOSED' : '.'}`,
  );
  if (i % 10 === 0) {
    const tail = strip(o).slice(-200).replace(/\n/g, ' | ');
    console.log('  tail:', tail);
  }

  // Banner reprint = DO restart
  const occurrences = (strip(o).match(/Cloud Dev Environment/g) || []).length;
  if (occurrences > 1) {
    bannerReprinted = true;
    console.log('!!! DO RESTARTED at t=' + elapsed + 's');
    break;
  }

  if (wsClosed) {
    console.log('!!! WS closed at t=' + elapsed + 's');
    break;
  }

  if (c.installPhase === 'done') {
    succeeded = true;
    console.log('=== installPhase=done at t=' + elapsed + 's ===');
    await new Promise((r) => setTimeout(r, 3000));
    break;
  }

  if (/Done!\s+\d+ packages/.test(strip(o)) && i > 5) {
    succeeded = true;
    console.log('=== "Done!" line printed at t=' + elapsed + 's ===');
    await new Promise((r) => setTimeout(r, 3000));
    break;
  }
}

console.log('\n=== final terminal (last 2000 chars) ===');
console.log(strip(o).slice(-2000));
console.log('\n=== best (highest tarballsCompleted) snapshot ===');
console.log(JSON.stringify(bestSnapshot, null, 2));
console.log('\n=== final snapshot ===');
console.log(JSON.stringify(lastSnapshot?.counters, null, 2));
console.log('=== final vfs.files:', lastSnapshot?.vfs?.files, '===');
console.log('=== ws status:', wsClosed ? `closed ${JSON.stringify(wsCloseInfo)}` : 'open', '===');
console.log('=== bannerReprinted:', bannerReprinted, '===');

try { w.close(); } catch {}

const finalFiles = lastSnapshot?.vfs?.files || 0;
let exitCode = 0;
if (bannerReprinted) { console.log('\n!!! ASSERTION FAILED: banner reprinted (DO restart)'); exitCode = 1; }
if (wsClosed && !succeeded) { console.log('\n!!! ASSERTION FAILED: WS closed before install completed'); exitCode = 1; }
if (finalFiles < TARGET_FILES) {
  console.log(`\n!!! ASSERTION FAILED: vfs.files=${finalFiles}, expected >${TARGET_FILES}`);
  exitCode = 1;
}

const installedLine = strip(o).match(/Done! (\d+) packages, (\d+) files/);
if (installedLine && exitCode === 0) {
  console.log(`\nINSTALL OK: ${installedLine[1]} packages, ${installedLine[2]} files`);
}
process.exit(exitCode);
