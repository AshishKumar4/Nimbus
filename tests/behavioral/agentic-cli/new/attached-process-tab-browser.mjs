#!/usr/bin/env bun
// agentic-cli/new/attached-process-tab-browser — attached npm-bin process
// tabs open an xterm, focus it, and preserve TTY output.

import { deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { applyProbeCookies, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const label = 'agentic-cli/new/attached-process-tab-browser';
const a = makeAsserter(label);
console.log(`${label} — BASE=${process.env.BASE}`);

const sid = await mintSession();
const browser = await launchBrowser({ timeout: 60_000 });
const page = await browser.newPage();
await applyProbeCookies(page);
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
    if (/Failed to load resource: the server responded with a status of 502/.test(msg.text())) return;
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
    'mkdir -p /home/user/node_modules/.bin /home/user/node_modules/fake-tui',
    "cat > /home/user/node_modules/fake-tui/package.json << 'NIMBUS_FAKE_TUI_PKG'",
    JSON.stringify({
      name: 'fake-tui',
      version: '1.0.0',
      bin: { 'fake-tui': 'cli.js' },
      nimbus: { terminal: 'attached' },
    }),
    'NIMBUS_FAKE_TUI_PKG',
    "cat > /home/user/node_modules/fake-tui/cli.js << 'NIMBUS_FAKE_TUI_CLI'",
    "process.stdout.write('\\x1b[2J\\x1b[HFAKE_TUI_READY\\n');",
    'process.stdin.setRawMode?.(true);',
    'process.stdin.resume();',
    "process.stdin.on('data', (chunk) => {",
    '  const text = String(chunk);',
    "  process.stdout.write('KEY:' + text.replace(/\\r/g, '<CR>').replace(/\\n/g, '<LF>') + '\\n');",
    "  if (text.includes('q') || text.includes('\\x03')) process.exit(0);",
    '});',
    'setInterval(() => {}, 1000);',
    'NIMBUS_FAKE_TUI_CLI',
    "cat > /home/user/node_modules/.bin/fake-tui << 'NIMBUS_FAKE_TUI_BIN'",
    "#!/usr/bin/env node",
    "require('../fake-tui/cli.js');",
    'NIMBUS_FAKE_TUI_BIN',
    'fake-tui',
    '',
  ].join('\n'));

  await page.waitForFunction(() => {
    const activeTab = document.querySelector('.logs-tab.active');
    const activeView = document.querySelector('.logs-view.active.terminal-view');
    const rows = activeView?.querySelector('.xterm-rows')?.innerText || activeView?.innerText || '';
    const activeElement = document.activeElement;
    return (activeTab?.textContent || '').includes('fake-tui')
      && !!activeView?.querySelector('.xterm')
      && /FAKE_TUI_READY/.test(rows)
      && activeElement?.classList?.contains('xterm-helper-textarea')
      && activeView.contains(activeElement);
  }, { timeout: 75_000 });

  const state = await page.evaluate(() => {
    const activeTab = document.querySelector('.logs-tab.active');
    const activeView = document.querySelector('.logs-view.active.terminal-view');
    return {
      activeTab: activeTab?.textContent || '',
      hasXterm: !!activeView?.querySelector('.xterm'),
      focused: document.activeElement?.classList?.contains('xterm-helper-textarea') === true
        && activeView?.contains(document.activeElement) === true,
      text: activeView?.querySelector('.xterm-rows')?.innerText || activeView?.innerText || '',
    };
  });
  a.check('attached process tab renders and focuses its xterm',
    state.activeTab.includes('fake-tui')
      && state.hasXterm
      && state.focused
      && /FAKE_TUI_READY/.test(state.text)
      && !/process attached; no output captured yet/.test(state.text),
    JSON.stringify(state));

  a.check('no browser runtime errors during attached process tab smoke',
    runtimeErrors.length === 0,
    runtimeErrors.slice(0, 5).join('\n'));
} finally {
  await page.keyboard.type('q').catch(() => {});
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
