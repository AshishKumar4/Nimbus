#!/usr/bin/env bun
// preview/new/tabbed-preview-auto-focus-port — when a process exposes a new
// HTTP port while Markdown preview is active, the preview pane creates a port
// tab and focuses it.

import { makeAsserter, mintSession } from '../../_driver.mjs';
import { applyProbeCookies, exchangeAttachCookie, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'preview/new/tabbed-preview-auto-focus-port';
const a = makeAsserter(label);
console.log(`${label} — BASE=${process.env.BASE}`);

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
const page = await browser.newPage();
await applyProbeCookies(page);
await exchangeAttachCookie(page, sid);
const runtimeErrors = [];
let pid = 0;

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

  await page.waitForFunction(() => {
    const active = document.querySelector('#previewTabs .preview-tab.active');
    const md = document.getElementById('markdown-preview');
    return active?.textContent?.includes('welcome.md')
      && active.classList.contains('markdown')
      && md?.classList.contains('active');
  }, { timeout: 90_000 });

  await page.waitForFunction(() => {
    const text = document.getElementById('terminal-container')?.innerText || '';
    return /user@nimbus:/.test(text);
  }, { timeout: 30_000 });

  const serverJs = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('nimbus-preview-tab:' + req.url + '\\n');
});
server.listen(3000, '0.0.0.0', () => console.log('LISTENING 3000'));
`.trim();

  await sendShellInput([
    'mkdir -p /home/user/preview-tabs && cd /home/user/preview-tabs',
    "cat > server.js << 'NIMBUS_PREVIEW_TAB_EOF'",
    serverJs,
    'NIMBUS_PREVIEW_TAB_EOF',
    'node --watch server.js',
    '',
  ].join('\n'));

  await page.waitForFunction(() => {
    const active = document.querySelector('#previewTabs .preview-tab.active');
    const frame = document.getElementById('preview-frame');
    const url = document.getElementById('urlBar')?.value || '';
    return active?.textContent?.includes(':3000')
      && /\/port\/3000\/$/.test(url)
      && frame
      && getComputedStyle(frame).display !== 'none'
      && /nimbus-preview-tab:\//.test(frame.contentDocument?.body?.innerText || '');
  }, { timeout: 30_000 });

  const state = await page.evaluate(() => ({
    activeTab: document.querySelector('#previewTabs .preview-tab.active')?.textContent || '',
    tabs: Array.from(document.querySelectorAll('#previewTabs .preview-tab')).map((tab) => tab.textContent || ''),
    url: document.getElementById('urlBar')?.value || '',
    iframeHidden: getComputedStyle(document.getElementById('preview-frame')).display === 'none',
    iframeText: document.getElementById('preview-frame')?.contentDocument?.body?.innerText || '',
    terminalText: document.getElementById('terminal-container')?.innerText || '',
  }));
  pid = Number(state.terminalText.match(/pid=(\d+)/)?.[1] || 0);
  a.check('node --watch returns long-running pid', pid > 0, state.terminalText.slice(-500));
  a.check('new port tab is focused and rendered',
    state.activeTab.includes(':3000')
    && state.tabs.some((tab) => tab.includes('welcome.md'))
    && /\/port\/3000\/$/.test(state.url)
    && !state.iframeHidden
    && /nimbus-preview-tab:\//.test(state.iframeText),
    JSON.stringify(state));

  a.check('no browser runtime errors during preview tab switch',
    runtimeErrors.length === 0,
    runtimeErrors.slice(0, 5).join('\n'));
} finally {
  if (pid > 0) await sendShellInput(`kill ${pid}\r`).catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
