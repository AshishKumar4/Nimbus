// agent/new/agent-tool-card-history — the chat island renders stored history
// as it was stored, through the built island with intercepted agent APIs:
//   - a running tool from a stored checkpoint counts its time from when it
//     started (its part's startedAt), not from when the card mounted; one
//     whose start is unknown shows no timer; once settled, its stored
//     duration;
//   - tool results written before parts (their own `tool`-role rows) render
//     as cards with the tool's name, input and output as stored.
// Red before: a running card started its own clock at mount, so a tool five
// seconds in showed 0.1s, and a tool with no known start showed one too.

import { BASE, makeAsserter, mintSession } from '../../_driver.mjs';
import { applyProbeCookies, exchangeAttachCookie, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('agent/new/agent-tool-card-history');
console.log(`agent/new/agent-tool-card-history — BASE=${BASE}`);

const sid = await mintSession();
const browser = await launchBrowser();
let page = null;

const STARTED_AGO_MS = 5000;
const legacyRows = [
  { id: 'u0', role: 'user', content: 'list and read', createdAt: 1 },
  { id: 'l1', role: 'tool', name: 'by-name', content: JSON.stringify({ tool: 'list_files', input: { dir: '.' }, output: ['a', 'b'] }), createdAt: 2 },
  { id: 'l2', role: 'tool', name: 'by-name', content: JSON.stringify({ output: 'only output' }), createdAt: 3 },
  { id: 'l3', role: 'tool', content: 'not json', createdAt: 4 },
];
/** The conversation with a turn still running: its exec started STARTED_AGO_MS before `now`; its read_file's start is unknown. */
const running = (now) => [
  ...legacyRows,
  { id: 'u1', role: 'user', content: 'build it', createdAt: now - STARTED_AGO_MS - 1000 },
  {
    id: 'a1', role: 'assistant', content: '', createdAt: now - STARTED_AGO_MS, status: 'streaming', replyTo: 'u1',
    parts: [
      { type: 'tool', toolCallId: 'r1', toolName: 'exec', input: { command: 'npm run build' }, status: 'running', startedAt: now - STARTED_AGO_MS },
      { type: 'tool', toolCallId: 'r2', toolName: 'read_file', input: { path: '/x' }, status: 'running' },
    ],
  },
];
const settled = (now) => running(now).map((message) => (message.id !== 'a1' ? message : {
  ...message, status: 'complete', content: 'Done.',
  parts: [
    { type: 'tool', toolCallId: 'r1', toolName: 'exec', input: { command: 'npm run build' }, output: { exitCode: 0 }, status: 'done', startedAt: now - 6200, durationMs: 6200 },
    { type: 'tool', toolCallId: 'r2', toolName: 'read_file', input: { path: '/x' }, output: 'x', status: 'done' },
    { type: 'text', text: 'Done.' },
  ],
}));

/** Seconds a duration label shows ('5.3s', '12s', '1m 3s'), or null. */
const seconds = (label) => {
  const m = /^(?:(\d+)m )?([\d.]+)s$/.exec(label || '');
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
};

try {
  page = await browser.newPage();
  await applyProbeCookies(page);
  await exchangeAttachCookie(page, sid);
  const runtimeErrors = [];
  page.on('pageerror', (err) => runtimeErrors.push(err.message || String(err)));

  let history = () => running(Date.now());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(`/s/${sid}/api/agent/`)) { request.continue(); return; }
    if (url.pathname.endsWith('/status')) {
      request.respond({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ok: true, configured: true, connected: true, model: 'test-model', gatewayId: 'default',
          oauth: { configured: false, connected: false, clientId: null, scopes: [], user: null, accounts: [], accountId: null, expiresAt: null },
          ownerToken: { configured: true, accountId: 'acct', disabledByUserOAuthRequired: false },
          capabilities: ['chat', 'exec', 'files', 'runtimes', 'processes', 'ports'],
        }),
      });
      return;
    }
    if (url.pathname.endsWith('/messages') && request.method() === 'GET') {
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: history() }) });
      return;
    }
    request.continue();
  });

  const response = await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  a.check('session shell page returns 200', response?.status() === 200, `status=${response?.status()}`);
  await page.waitForSelector('#btnAgent', { visible: true, timeout: 30_000 });
  await page.click('#btnAgent');
  await page.waitForSelector('#agentMessages .agent-tool.running', { timeout: 30_000 });
  // Two repaints' worth, so a mount clock would have shown its first ticks.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const cards = () => page.evaluate(() => Array.from(document.querySelectorAll('#agentMessages .agent-tool')).map((el) => ({
    name: el.querySelector('.tool-name')?.textContent || '',
    status: el.className.replace('agent-tool', '').trim(),
    duration: el.querySelector('.tool-duration')?.textContent || null,
  })));
  const live = await cards();
  const exec = live.find((card) => card.name === 'exec');
  const unknown = live.find((card) => card.name === 'read_file');
  const shown = seconds(exec?.duration);
  a.check('a running tool from a stored checkpoint counts from when it started',
    shown !== null && shown >= STARTED_AGO_MS / 1000 - 0.5 && shown < STARTED_AGO_MS / 1000 + 20, JSON.stringify(live));
  a.check('a running tool whose start is unknown shows no timer', unknown !== undefined && unknown.duration === null, JSON.stringify(live));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const later = seconds((await cards()).find((card) => card.name === 'exec')?.duration);
  a.check('its timer moves on while it runs', shown !== null && later !== null && later >= shown + 0.8, `${shown} → ${later}`);

  history = () => settled(Date.now());
  await page.evaluate(() => window.NimbusAgent.ensureLoaded());
  await page.waitForFunction(() => !document.querySelector('#agentMessages .agent-tool.running'), { timeout: 15_000 });
  const done = await cards();
  a.check('once settled, a tool shows its stored duration', done.find((card) => card.name === 'exec')?.duration === '6.2s', JSON.stringify(done));
  a.check('a settled tool with no stored duration shows none', done.find((card) => card.name === 'read_file')?.duration === null, JSON.stringify(done));

  // Tool results written before parts: one card each, as stored.
  const legacy = [];
  for (const id of ['l1', 'l2', 'l3']) {
    const index = legacyRows.findIndex((row) => row.id === id) - 1;
    const card = (await page.$$('#agentMessages .agent-tool'))[index];
    await card.$eval('.tool-head', (el) => el.click());
    legacy.push(await card.evaluate((el) => ({
      name: el.querySelector('.tool-name')?.textContent || '',
      status: el.className.replace('agent-tool', '').trim(),
      panes: Array.from(el.querySelectorAll('.tool-pane')).map((pane) => [pane.querySelector('.tool-pane-label')?.textContent, pane.querySelector('pre')?.textContent]),
    })));
  }
  a.check('tool results written before parts render as stored', JSON.stringify(legacy) === JSON.stringify([
    { name: 'list_files', status: 'done', panes: [['Input', '{\n  "dir": "."\n}'], ['Output', '[\n  "a",\n  "b"\n]']] },
    { name: 'by-name', status: 'done', panes: [['Output', 'only output']] },
    { name: 'tool', status: 'done', panes: [['Output', 'not json']] },
  ]), JSON.stringify(legacy));
  a.check('no page errors', runtimeErrors.length === 0, runtimeErrors.join('\n'));
} finally {
  await page?.close().catch(() => {});
  await browser.close().catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
