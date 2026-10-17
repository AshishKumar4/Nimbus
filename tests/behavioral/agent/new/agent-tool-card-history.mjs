// agent/new/agent-tool-card-history — the chat island renders stored history
// as it was stored, through the built island with intercepted agent APIs:
//   - a running tool from a stored checkpoint counts its time from when it
//     started (its part's startedAt), not from when the card mounted: its
//     label is the browser clock less that start; one whose start is
//     unknown, or still ahead of the clock, shows no timer; once settled,
//     its stored duration;
//   - tool results written before parts (their own `tool`-role rows) render
//     as cards with the tool's name (a string, else the row's), input and
//     output as stored.
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
  { id: 'l4', role: 'tool', name: 'by-name', content: JSON.stringify({ tool: 7, output: 'x' }), createdAt: 5 },
];
/** The exec's start, as the last history served said it. */
let execStartedAt = 0;
/** The conversation with a turn still running: its exec started STARTED_AGO_MS before `now`; its read_file's start is unknown; its fetch's is ahead of the clock. */
const running = (now) => [
  ...legacyRows,
  { id: 'u1', role: 'user', content: 'build it', createdAt: now - STARTED_AGO_MS - 1000 },
  {
    id: 'a1', role: 'assistant', content: '', createdAt: now - STARTED_AGO_MS, status: 'streaming', replyTo: 'u1',
    parts: [
      { type: 'tool', toolCallId: 'r1', toolName: 'exec', input: { command: 'npm run build' }, status: 'running', startedAt: (execStartedAt = now - STARTED_AGO_MS) },
      { type: 'tool', toolCallId: 'r2', toolName: 'read_file', input: { path: '/x' }, status: 'running' },
      { type: 'tool', toolCallId: 'r3', toolName: 'fetch', input: { url: 'https://example.com' }, status: 'running', startedAt: now + 60_000 },
    ],
  },
];
const settled = (now) => running(now).map((message) => (message.id !== 'a1' ? message : {
  ...message, status: 'complete', content: 'Done.',
  parts: [
    { type: 'tool', toolCallId: 'r1', toolName: 'exec', input: { command: 'npm run build' }, output: { exitCode: 0 }, status: 'done', startedAt: now - 6200, durationMs: 6200 },
    { type: 'tool', toolCallId: 'r2', toolName: 'read_file', input: { path: '/x' }, output: 'x', status: 'done' },
    { type: 'tool', toolCallId: 'r3', toolName: 'fetch', input: { url: 'https://example.com' }, output: 'x', status: 'done' },
    { type: 'text', text: 'Done.' },
  ],
}));

try {
  page = await browser.newPage();
  await applyProbeCookies(page);
  await exchangeAttachCookie(page, sid);
  const runtimeErrors = [];
  page.on('pageerror', (err) => runtimeErrors.push(err.message || String(err)));

  // One running conversation, made at the first request for it: its starts stay put across refreshes.
  let runningHistory = null;
  let history = () => (runningHistory ??= running(Date.now()));
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

  const cards = () => page.evaluate(() => Array.from(document.querySelectorAll('#agentMessages .agent-tool')).map((el) => ({
    name: el.querySelector('.tool-name')?.textContent || '',
    status: el.className.replace('agent-tool', '').trim(),
    duration: el.querySelector('.tool-duration')?.textContent || null,
  })));
  /**
   * The exec card's label and the browser clock, read together: the first
   * reading, within 15 s, of at least `atLeast` seconds that is the clock
   * less the start, to the label's precision (tenths below 10 s, whole
   * seconds above) give or take one 100 ms repaint; else the last reading.
   */
  const execTimer = async (atLeast) => {
    const read = (min, startedAt, final) => {
      const label = [...document.querySelectorAll('#agentMessages .agent-tool')]
        .find((el) => el.querySelector('.tool-name')?.textContent === 'exec')?.querySelector('.tool-duration')?.textContent ?? null;
      const m = /^(?:(\d+)m )?([\d.]+)s$/.exec(label || '');
      const now = Date.now();
      const shown = m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
      const expected = (now - startedAt) / 1000;
      const anchored = shown !== null && shown >= min && Math.abs(shown - expected) <= (m[2].includes('.') ? 0.05 : 0.5) + 0.15;
      return anchored || final ? { now, label, shown, expected, anchored } : false;
    };
    try {
      return await (await page.waitForFunction(read, { timeout: 15_000, polling: 50 }, atLeast, execStartedAt, false)).jsonValue();
    } catch {
      return page.evaluate(read, atLeast, execStartedAt, true);
    }
  };
  const first = await execTimer(0);
  a.check('a running tool from a stored checkpoint counts from when it started',
    first.anchored && first.shown >= STARTED_AGO_MS / 1000 - 0.2, JSON.stringify(first));
  const live = await cards();
  a.check('a running tool whose start is unknown shows no timer', live.find((card) => card.name === 'read_file')?.duration === null, JSON.stringify(live));
  a.check('a running tool whose start is ahead of the clock shows no timer', live.find((card) => card.name === 'fetch')?.duration === null, JSON.stringify(live));
  const later = await execTimer((first.shown ?? 0) + 1);
  a.check('its timer moves on with the clock while it runs', later.anchored, JSON.stringify(later));

  history = () => settled(Date.now());
  await page.evaluate(() => window.NimbusAgent.ensureLoaded());
  await page.waitForFunction(() => !document.querySelector('#agentMessages .agent-tool.running'), { timeout: 15_000 });
  const done = await cards();
  a.check('once settled, a tool shows its stored duration', done.find((card) => card.name === 'exec')?.duration === '6.2s', JSON.stringify(done));
  a.check('a settled tool with no stored duration shows none',
    done.find((card) => card.name === 'read_file')?.duration === null && done.find((card) => card.name === 'fetch')?.duration === null, JSON.stringify(done));

  // Tool results written before parts: one card each, as stored.
  const legacy = [];
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
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
    { name: 'by-name', status: 'done', panes: [['Output', 'x']] },
  ]), JSON.stringify(legacy));
  a.check('no page errors', runtimeErrors.length === 0, runtimeErrors.join('\n'));
} finally {
  await page?.close().catch(() => {});
  await browser.close().catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
