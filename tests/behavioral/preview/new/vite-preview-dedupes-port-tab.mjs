#!/usr/bin/env bun
// preview/new/vite-preview-dedupes-port-tab — Vite's canonical /preview/
// tab should not be duplicated by its registered /port/<n>/ alias.

import { makeAsserter, mintSession } from '../../_driver.mjs';
import { launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'preview/new/vite-preview-dedupes-port-tab';
const a = makeAsserter(label);
console.log(`${label} — BASE=${process.env.BASE}`);

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
const page = await browser.newPage();
const runtimeErrors = [];

async function sendShellInput(data) {
  await page.waitForFunction(() => {
    try { return typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN; }
    catch { return false; }
  }, { timeout: 30_000 });
  await page.evaluate((input) => {
    ws.send(JSON.stringify({ type: 'input', data: input }));
  }, data);
}

page.on('pageerror', (err) => runtimeErrors.push(err.message || String(err)));
page.on('console', (msg) => {
  const location = msg.location?.() || {};
  if (msg.type() === 'error' && !String(location.url || '').endsWith('/favicon.ico')) {
    runtimeErrors.push(msg.text());
  }
});

try {
  const response = await page.goto(`${process.env.BASE}/s/${sid}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  a.check('session shell page returns 200', response?.status() === 200, `status=${response?.status()}`);

  await page.waitForFunction(() => /user@nimbus:/.test(document.getElementById('terminal-container')?.innerText || ''), {
    timeout: 30_000,
  });

  await sendShellInput([
    'mkdir -p /home/user/vite-dedupe',
    "cat > /home/user/vite-dedupe/index.html << 'NIMBUS_VITE_DEDUPE_EOF'",
    '<!doctype html>',
    '<title>Nimbus Vite Dedupe</title>',
    '<main id="dedupe-root">nimbus-vite-dedupe</main>',
    'NIMBUS_VITE_DEDUPE_EOF',
    'vite --root /home/user/vite-dedupe --host 0.0.0.0 --port 3000',
    '',
  ].join('\n'));

  await page.waitForFunction(async () => {
    const stats = await fetch('api/stats').then((r) => r.json()).catch(() => null);
    if (!stats?.vite?.running || Number(stats.vite.port) !== 3000) return false;
    const tabs = Array.from(document.querySelectorAll('#previewTabs .preview-tab')).map((tab) => tab.textContent || '');
    const active = document.querySelector('#previewTabs .preview-tab.active')?.textContent || '';
    const url = document.getElementById('urlBar')?.value || '';
    const frame = document.getElementById('preview-frame');
    return active.includes('Preview')
      && /\/preview\/$/.test(url)
      && tabs.filter((tab) => tab.includes(':3000')).length === 0
      && /nimbus-vite-dedupe/.test(frame?.contentDocument?.body?.innerText || '');
  }, { timeout: 45_000 });

  const state = await page.evaluate(async () => ({
    stats: await fetch('api/stats').then((r) => r.json()).catch(() => null),
    activeTab: document.querySelector('#previewTabs .preview-tab.active')?.textContent || '',
    tabs: Array.from(document.querySelectorAll('#previewTabs .preview-tab')).map((tab) => tab.textContent || ''),
    url: document.getElementById('urlBar')?.value || '',
    iframeText: document.getElementById('preview-frame')?.contentDocument?.body?.innerText || '',
  }));
  a.check('Vite port is represented only by the Preview tab',
    state.stats?.vite?.running
    && Number(state.stats.vite.port) === 3000
    && state.activeTab.includes('Preview')
    && /\/preview\/$/.test(state.url)
    && state.tabs.filter((tab) => tab.includes(':3000')).length === 0
    && /nimbus-vite-dedupe/.test(state.iframeText),
    JSON.stringify(state));

  a.check('no browser runtime errors during Vite preview tab dedupe',
    runtimeErrors.length === 0,
    runtimeErrors.slice(0, 5).join('\n'));
} finally {
  await sendShellInput('vite stop\r').catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
