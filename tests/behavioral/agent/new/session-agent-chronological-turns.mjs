#!/usr/bin/env bun
// agent/new/session-agent-chronological-turns — assistant turns render as
// chronological parts, and the backend agent loop has no step-count stop cap.

import { readFileSync } from 'node:fs';
import { BASE, makeAsserter, mintSession } from '../../_driver.mjs';
import { applyProbeCookies, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('agent/new/session-agent-chronological-turns');
console.log(`agent/new/session-agent-chronological-turns — BASE=${BASE}`);

const source = readFileSync(new URL('../../../../packages/worker/src/session/agent.ts', import.meta.url), 'utf8');
a.check('Agent loop uses unlimited AI SDK stop condition',
  /stopWhen:\s*isLoopFinished\(\)/.test(source),
  'isLoopFinished stop condition missing');
a.check('Agent loop does not keep a step-count cap',
  !/stepCountIs|MAX_TOOL_ROUNDS|MAX_MODEL_MESSAGES/.test(source),
  'step-count or context cap symbol still present');

const sid = await mintSession();
const browser = await launchBrowser();
let page = null;

try {
  page = await browser.newPage();
  await applyProbeCookies(page);
  const runtimeErrors = [];
  page.on('pageerror', (err) => runtimeErrors.push(err.message || String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') runtimeErrors.push(msg.text());
  });

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/s/${sid}/api/agent/status`) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          configured: true,
          connected: true,
          model: 'test-model',
          capabilities: ['chat', 'exec', 'files', 'runtimes', 'processes', 'ports'],
          oauth: { configured: false, connected: false, accounts: [] },
          ownerToken: { configured: true },
        }),
      });
      return;
    }
    if (url.pathname === `/s/${sid}/api/agent/messages`) {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { id: 'u1', role: 'user', content: 'Build the app', createdAt: 1 },
            {
              id: 'a1',
              role: 'assistant',
              content: 'I will inspect it.\nIt is ready.',
              createdAt: 2,
              parts: [
                { type: 'reasoning', text: 'Need to inspect files first.' },
                { type: 'text', text: 'I will inspect it.' },
                {
                  type: 'tool',
                  toolCallId: 't1',
                  toolName: 'list_files',
                  input: { path: '/home/user' },
                  output: { path: '/home/user', entries: [{ name: 'app', type: 'directory' }] },
                  status: 'done',
                },
                {
                  type: 'tool',
                  toolCallId: 't2',
                  toolName: 'exec',
                  input: { command: 'npm run build' },
                  output: { success: false, exitCode: 1, stderr: 'build failed' },
                  status: 'error',
                },
                { type: 'text', text: 'It is ready.' },
                {
                  type: 'tool',
                  toolCallId: 't3',
                  toolName: 'write_file',
                  input: { path: '/home/user/app.jsx' },
                  output: { ok: true, path: '/home/user/app.jsx' },
                  status: 'done',
                },
              ],
            },
          ],
        }),
      });
      return;
    }
    request.continue();
  });

  const response = await page.goto(`${BASE}/s/${sid}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  a.check('session shell page returns 200', response?.status() === 200, `status=${response?.status()}`);

  await page.waitForSelector('#btnAgent', { visible: true, timeout: 30_000 });
  await page.click('#btnAgent');
  await page.waitForFunction(() => {
    const items = Array.from(document.querySelectorAll('#agentMessages .agent-msg.assistant .agent-content > *'));
    return items.some((el) => el.textContent.includes('I will inspect it.'))
      && items.some((el) => el.textContent.includes('write_file'));
  }, { timeout: 30_000 });

  const ui = await page.evaluate(() => {
    const assistantRows = Array.from(document.querySelectorAll('#agentMessages .agent-msg.assistant'));
    const row = assistantRows[0];
    const ordered = Array.from(row.querySelectorAll('.agent-content > *'))
      .filter((el) => !el.classList.contains('agent-meta'))
      .map((el) => {
        if (el.classList.contains('agent-reasoning')) return 'reasoning';
        if (el.classList.contains('agent-bubble')) return `text:${el.textContent.trim()}`;
        if (el.classList.contains('agent-tool')) {
          const name = el.querySelector('.tool-name')?.textContent || '';
          const state = el.classList.contains('error') ? 'error' : el.classList.contains('done') ? 'done' : 'running';
          return `tool:${name}:${state}`;
        }
        return el.className || el.tagName;
      });
    return {
      assistantRowCount: assistantRows.length,
      ordered,
      toolCount: row.querySelectorAll('.agent-tool').length,
      errorToolCount: row.querySelectorAll('.agent-tool.error').length,
    };
  });

  const expected = [
    'reasoning',
    'text:I will inspect it.',
    'tool:list_files:done',
    'tool:exec:error',
    'text:It is ready.',
    'tool:write_file:done',
  ];
  a.check('Assistant turn stays in one rendered row',
    ui.assistantRowCount === 1,
    JSON.stringify(ui));
  a.check('Assistant parts render in chronological order',
    JSON.stringify(ui.ordered) === JSON.stringify(expected),
    JSON.stringify(ui.ordered));
  a.check('Tool cards render inline with failure status',
    ui.toolCount === 3 && ui.errorToolCount === 1,
    JSON.stringify(ui));
  a.check('No browser runtime errors while rendering chronological turn',
    runtimeErrors.length === 0,
    runtimeErrors.slice(0, 5).join('\n'));
} finally {
  if (page) await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
