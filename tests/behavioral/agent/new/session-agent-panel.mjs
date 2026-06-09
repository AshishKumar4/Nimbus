#!/usr/bin/env bun
// agent/new/session-agent-panel — the Agent surface is embedded inside the
// editor workspace and backed by session-scoped API routes. This probe drives
// the browser surface and safe API endpoints; it does not call Workers AI.

import { BASE, makeAsserter, mintSession, requestHeaders } from '../../_driver.mjs';
import { applyProbeCookies, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('agent/new/session-agent-panel');
console.log(`agent/new/session-agent-panel — BASE=${BASE}`);

const sid = await mintSession();
const browser = await launchBrowser();
let page = null;

try {
  page = await browser.newPage();
  await applyProbeCookies(page);
  const runtimeErrors = [];
  page.on('pageerror', (err) => runtimeErrors.push(err.message || String(err)));
  page.on('console', (msg) => {
    const location = msg.location?.() || {};
    if (msg.type() === 'error' && !String(location.url || '').endsWith('/favicon.ico')) {
      runtimeErrors.push(msg.text());
    }
  });

  const response = await page.goto(`${BASE}/s/${sid}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  a.check('session shell page returns 200', response?.status() === 200, `status=${response?.status()}`);

  await page.waitForSelector('#btnAgent', { visible: true, timeout: 30_000 });
  await page.click('#btnAgent');
  await page.waitForFunction(() => {
    const main = document.getElementById('mainPanel');
    const stack = document.getElementById('leftStack');
    const panel = document.getElementById('agentPanel');
    return !!main && !!panel
      && !!stack
      && main.classList.contains('editor')
      && stack.classList.contains('agent-surface')
      && getComputedStyle(panel).display !== 'none';
  }, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const text = document.getElementById('agentStatus')?.textContent || '';
    return text && text !== 'Checking...';
  }, { timeout: 30_000 });

  const ui = await page.evaluate(() => ({
    mainClass: document.getElementById('mainPanel')?.className || '',
    stackClass: document.getElementById('leftStack')?.className || '',
    activeButton: document.getElementById('btnAgent')?.classList.contains('active') || false,
    title: document.querySelector('#agentPanel .agent-title')?.textContent || '',
    status: document.getElementById('agentStatus')?.textContent || '',
    empty: document.getElementById('agentEmpty')?.textContent || '',
    hasClientApi: typeof window.NimbusAgent === 'object',
    inputDisabled: document.getElementById('agentInput')?.disabled ?? true,
    sendDisabled: document.getElementById('agentSend')?.disabled ?? true,
    treeDisplay: getComputedStyle(document.getElementById('treePanel')).display,
    terminalDisplay: getComputedStyle(document.querySelector('.panel-terminal')).display,
    previewDisplay: getComputedStyle(document.getElementById('previewPanel')).display,
    editorDisplay: getComputedStyle(document.getElementById('editorPanel')).display,
    agentDisplay: getComputedStyle(document.getElementById('agentPanel')).display,
  }));

  a.check('Agent toolbar button becomes active', ui.activeButton, JSON.stringify(ui));
  a.check('Workspace remains the editor layout', /\beditor\b/.test(ui.mainClass), JSON.stringify(ui));
  a.check('Agent surface is selected inside the center stack', /\bagent-surface\b/.test(ui.stackClass), JSON.stringify(ui));
  a.check('Agent panel replaces the editor pane only',
    ui.agentDisplay !== 'none'
    && ui.editorDisplay === 'none'
    && ui.treeDisplay !== 'none'
    && ui.terminalDisplay !== 'none'
    && ui.previewDisplay !== 'none',
    JSON.stringify(ui));
  a.check('Agent client module loads', ui.hasClientApi, JSON.stringify(ui));
  a.check('Agent panel names Nimbus Agent', ui.title === 'Nimbus Agent', JSON.stringify(ui));
  a.check('Agent status resolves from Checking', ui.status !== 'Checking...', JSON.stringify(ui));

  const statusResponse = await fetch(`${BASE}/s/${sid}/api/agent/status`, {
    headers: requestHeaders({ Accept: 'application/json', 'Cache-Control': 'no-store' }),
  });
  const status = await statusResponse.json();
  a.check('Agent status API returns ok JSON',
    statusResponse.status === 200 && status.ok === true,
    `status=${statusResponse.status} body=${JSON.stringify(status)}`);
  a.check('Agent capabilities include sandbox tools',
    Array.isArray(status.capabilities)
    && ['chat', 'exec', 'files', 'runtimes', 'processes', 'ports'].every((name) => status.capabilities.includes(name)),
    JSON.stringify(status.capabilities));

  const messagesResponse = await fetch(`${BASE}/s/${sid}/api/agent/messages`, {
    headers: requestHeaders({ Accept: 'application/json', 'Cache-Control': 'no-store' }),
  });
  const messages = await messagesResponse.json();
  a.check('Agent messages API starts empty',
    messagesResponse.status === 200 && Array.isArray(messages.messages),
    `status=${messagesResponse.status} body=${JSON.stringify(messages)}`);

  const startResponse = await fetch(`${BASE}/s/${sid}/api/agent/oauth/start`, {
    method: 'POST',
    headers: requestHeaders({ Accept: 'application/json', 'Cache-Control': 'no-store' }),
  });
  const start = await startResponse.json();
  if (status.oauth?.configured) {
    const authUrl = new URL(start.authUrl);
    a.check('OAuth start returns Cloudflare authorization URL',
      startResponse.status === 200
      && start.ok === true
      && authUrl.origin === 'https://dash.cloudflare.com'
      && authUrl.pathname === '/oauth2/auth'
      && !!authUrl.searchParams.get('state')
      && !!authUrl.searchParams.get('code_challenge'),
      `status=${startResponse.status} body=${JSON.stringify(start)}`);
  } else {
    a.check('OAuth start reports not configured cleanly',
      startResponse.status === 409 && start.code === 'E_AGENT_OAUTH_NOT_CONFIGURED',
      `status=${startResponse.status} body=${JSON.stringify(start)}`);
  }

  if (!status.connected) {
    const chatResponse = await fetch(`${BASE}/s/${sid}/api/agent/messages`, {
      method: 'POST',
      headers: requestHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ message: 'hello' }),
    });
    const chat = await chatResponse.json();
    a.check('Agent chat refuses unconfigured AI without side effects',
      chatResponse.status === 409 && chat.code === 'E_AGENT_AI_NOT_CONFIGURED',
      `status=${chatResponse.status} body=${JSON.stringify(chat)}`);
    a.check('Composer is disabled when AI is unavailable',
      ui.inputDisabled && ui.sendDisabled,
      JSON.stringify(ui));
  }

  a.check('No browser runtime errors while opening Agent surface',
    runtimeErrors.length === 0,
    runtimeErrors.slice(0, 5).join('\n'));
} finally {
  if (page) await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
