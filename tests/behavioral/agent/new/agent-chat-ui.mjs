#!/usr/bin/env bun
// agent/new/agent-chat-ui — the built agent-chat island: mount, seeded
// history rendering (markdown + syntax highlighting + tool cards + copy
// button), streaming send/stop, pin-to-bottom, error card + retry, and the
// unified markdown pipeline. Rendering fidelity is driven with intercepted
// agent APIs (no Workers AI spend); the live-send path honors the
// model-auth boundary honestly: with no connected credential it asserts
// the connect-gate UX instead of faking a turn.

import { BASE, makeAsserter, mintSession, requestHeaders } from '../../_driver.mjs';
import { applyProbeCookies, exchangeAttachCookie, launchBrowser } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('agent/new/agent-chat-ui');
console.log(`agent/new/agent-chat-ui — BASE=${BASE}`);

const sid = await mintSession();
const browser = await launchBrowser();
let page = null;

const seededMessages = [
  { id: 'u1', role: 'user', content: 'Scaffold the app and run the build', createdAt: 1 },
  {
    id: 'a1', role: 'assistant', createdAt: 2,
    content: 'Plan below.',
    parts: [
      { type: 'reasoning', text: 'Inspect first, then build.' },
      { type: 'text', text: 'Plan:\n\n```ts\nexport const answer: number = 42;\n```' },
      { type: 'tool', toolCallId: 't1', toolName: 'exec', input: { command: 'npm run build' }, output: { exitCode: 0, stdout: 'ok' }, status: 'done', durationMs: 1400 },
      { type: 'tool', toolCallId: 't2', toolName: 'read_file', input: { path: '/x' }, output: { error: 'ENOENT' }, error: 'ENOENT', status: 'error', durationMs: 200 },
      { type: 'text', text: 'Build green.' },
    ],
  },
  { id: 'u2', role: 'user', content: 'Continue the interrupted work', createdAt: 3 },
  {
    id: 'a2', role: 'assistant', content: 'Partial result', createdAt: 4,
    status: 'interrupted', parts: [{ type: 'text', text: 'Partial result' }],
  },
];

function ndjsonBody(events) {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

try {
  page = await browser.newPage();
  await applyProbeCookies(page);
  await exchangeAttachCookie(page, sid);
  const runtimeErrors = [];
  page.on('pageerror', (err) => runtimeErrors.push(err.message || String(err)));
  page.on('console', (msg) => {
    const location = msg.location?.() || {};
    if (msg.type() === 'error' && !String(location.url || '').endsWith('/favicon.ico')) {
      runtimeErrors.push(msg.text());
    }
  });

  // ── Phase 1: rendering fidelity with intercepted agent APIs ─────────
  let interceptAgentApis = true;
  let postMode = 'stream'; // 'stream' | 'error' | 'eof'
  const postBodies = [];
  let mockMessages = structuredClone(seededMessages);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!interceptAgentApis || !url.pathname.startsWith(`/s/${sid}/api/agent/`)) {
      request.continue();
      return;
    }
    if (url.pathname.endsWith('/status')) {
      request.respond({
        status: 200,
        contentType: 'application/json',
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
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ messages: mockMessages }),
      });
      return;
    }
    if (url.pathname.endsWith('/messages') && request.method() === 'POST') {
      const requestBody = JSON.parse(request.postData() || '{}');
      postBodies.push(requestBody);
      const history = structuredClone(mockMessages);
      let user;
      if (requestBody.retry === true) {
        if (history.at(-1)?.role === 'assistant') history.pop();
        user = history.at(-1);
      } else {
        user = {
          id: `u-live-${postBodies.length}`,
          role: 'user',
          content: requestBody.message,
          createdAt: Date.now(),
        };
        history.push(user);
      }
      const complete = {
        id: `a-live-${postBodies.length}`,
        role: 'assistant',
        content: 'Streamed **answer**.',
        createdAt: Date.now(),
        status: 'complete',
        parts: [{ type: 'text', text: 'Streamed **answer**.' }],
      };
      const interrupted = {
        id: complete.id,
        role: 'assistant',
        content: 'Recovered partial text.',
        createdAt: complete.createdAt,
        status: 'interrupted',
        parts: [{ type: 'text', text: 'Recovered partial text.' }],
      };
      const base = [
        { type: 'start', messages: history },
        { type: 'message', message: user },
        { type: 'assistant-start', messageId: complete.id, createdAt: complete.createdAt },
      ];
      let events;
      if (postMode === 'error') {
        const failed = { ...interrupted, content: '', parts: [], error: 'provider exploded' };
        mockMessages = [...history, failed];
        events = [...base, {
          type: 'error', error: 'provider exploded', code: 'E_AGENT_TURN_FAILED', messages: mockMessages,
        }];
      } else if (postMode === 'eof') {
        mockMessages = [...history, interrupted];
        events = [...base, { type: 'text-delta', delta: 'Recovered partial text.' }];
      } else {
        mockMessages = [...history, complete];
        events = [...base,
            { type: 'text-delta', delta: 'Streamed **answer**.' },
            { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 11000, outputTokens: 1300, totalTokens: 12_300 } },
            {
              type: 'done',
              message: complete,
              messages: mockMessages,
            },
          ];
      }
      request.respond({
        status: 200,
        contentType: 'application/x-ndjson',
        body: ndjsonBody(events),
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
  await page.waitForSelector('#agentPanel .agent-title', { timeout: 30_000 });
  await page.waitForSelector('#agentMessages .agent-msg.assistant', { timeout: 30_000 });

  const history = await page.evaluate(() => {
    const content = document.querySelector('#agentMessages .agent-msg.assistant .agent-content');
    return {
      kinds: Array.from(content.children).map((el) => el.className.split(' ')[0]),
      userBubble: document.querySelector('.agent-msg.user .agent-bubble')?.textContent || '',
      codeLang: content.querySelector('.code-block-lang')?.textContent || '',
      copyButton: !!content.querySelector('.code-copy'),
      highlighted: content.querySelectorAll('.code-block .hljs-keyword').length > 0,
      toolNames: Array.from(content.querySelectorAll('.tool-name')).map((el) => el.textContent),
      toolClasses: Array.from(content.querySelectorAll('.agent-tool')).map((el) => el.className),
      duration: content.querySelector('.tool-duration')?.textContent || '',
      title: document.querySelector('#agentPanel .agent-title')?.textContent || '',
      hasClientApi: typeof window.NimbusAgent === 'object',
    };
  });
  a.check('island mounts and exposes the client API', history.hasClientApi && history.title === 'Nimbus Agent', JSON.stringify(history));
  a.check('assistant parts render chronologically',
    JSON.stringify(history.kinds) === JSON.stringify(['agent-reasoning', 'agent-text', 'agent-tool', 'agent-tool', 'agent-text', 'agent-meta']),
    JSON.stringify(history.kinds));
  a.check('user message renders as a bubble', history.userBubble.includes('Scaffold the app'), history.userBubble);
  a.check('code block renders with language label, highlighting, and copy button',
    history.codeLang === 'ts' && history.copyButton && history.highlighted,
    JSON.stringify(history));
  a.check('tool cards render names and settled statuses',
    JSON.stringify(history.toolNames) === JSON.stringify(['exec', 'read_file'])
    && history.toolClasses[0].includes('done') && history.toolClasses[1].includes('error'),
    JSON.stringify(history));
  a.check('stored tool duration is shown', history.duration.includes('1.4s'), history.duration);
  a.check('persisted interrupted turn renders its badge and Retry affordance',
    await page.$eval('.agent-msg.assistant:last-child', (el) => (
      el.querySelector('.agent-interrupted')?.textContent === 'interrupted'
      && el.querySelector('.agent-message-retry')?.textContent === 'Retry'
  )));
  await page.click('.agent-msg.assistant:last-child .agent-message-retry');
  await page.waitForFunction(() => {
    const last = document.querySelector('.agent-msg.assistant:last-child');
    return document.getElementById('agentSend')?.textContent === 'Send'
      && last?.querySelector('.agent-text')?.textContent.includes('Streamed answer.')
      && !last?.querySelector('.agent-interrupted');
  }, { timeout: 15_000 });
  a.check('persisted interruption Retry uses the existing server retry path',
    postBodies.length === 1 && postBodies[0].retry === true, JSON.stringify(postBodies));
  a.check('retry reuses the existing user turn without duplication',
    await page.$$eval('.agent-msg.user .agent-bubble', (rows) => (
      rows.filter((row) => row.textContent === 'Continue the interrupted work').length === 1
    )));
  a.check('retry replaces the interrupted assistant instead of retaining it',
    await page.$$eval('.agent-msg.assistant .agent-text', (rows) => (
      rows.every((row) => !row.textContent.includes('Partial result'))
    )));

  // Streaming send round-trip against the intercepted NDJSON endpoint.
  await page.type('#agentInput', 'live question');
  await page.click('#agentSend');
  await page.waitForFunction(() => {
    const last = document.querySelector('.agent-thread')?.lastElementChild;
    return document.getElementById('agentSend')?.textContent === 'Send'
      && last?.matches('.agent-msg.assistant')
      && last.querySelector('.agent-text')?.textContent.includes('Streamed answer.');
  }, { timeout: 15_000 });
  const streamed = await page.evaluate(() => ({
    bold: document.querySelector('.agent-thread')?.lastElementChild?.querySelector('.agent-text strong')?.textContent === 'answer',
    usage: document.querySelector('.agent-thread')?.lastElementChild?.querySelector('.agent-usage')?.textContent || '',
    sendLabel: document.getElementById('agentSend')?.textContent || '',
  }));
  a.check('streamed turn renders markdown and settles', streamed.bold && streamed.sendLabel === 'Send', JSON.stringify(streamed));
  a.check('per-turn usage chip renders', streamed.usage.includes('12.3k'), streamed.usage);

  // Pin-to-bottom: a scrolled-up reader is not yanked by new content.
  const yank = await page.evaluate(async () => {
    const el = document.getElementById('agentMessages');
    el.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    window.NimbusAgent.ensureLoaded(); // triggers refresh -> re-render
    await new Promise((resolve) => setTimeout(resolve, 400));
    return el.scrollTop;
  });
  a.check('scrolled-up reader is not yanked on re-render', yank < 40, String(yank));

  // Terminal error -> ErrorCard -> retry round-trip.
  postMode = 'error';
  await page.type('#agentInput', 'trigger failure');
  await page.click('#agentSend');
  await page.waitForSelector('.agent-error-card', { timeout: 15_000 });
  a.check('terminal error renders the honest error card',
    await page.$eval('.error-body', (el) => el.textContent.includes('provider exploded')));
  postMode = 'stream';
  await page.click('.error-retry');
  await page.waitForFunction(() => {
    const last = document.querySelector('.agent-thread')?.lastElementChild;
    return !document.querySelector('.agent-error-card')
      && document.getElementById('agentSend')?.textContent === 'Send'
      && last?.matches('.agent-msg.assistant')
      && last.querySelector('.agent-text')?.textContent.includes('Streamed answer.')
      && !last.querySelector('.agent-interrupted');
  }, { timeout: 15_000 });
  a.check('retry clears the error card and completes', !(await page.$('.agent-error-card')));

  // Clean EOF after live parts is an interrupted turn, never a silent drop.
  postMode = 'eof';
  await page.type('#agentInput', 'trigger clean eof');
  await page.click('#agentSend');
  await page.waitForFunction(() => {
    const last = document.querySelector('.agent-msg.assistant:last-child');
    return last?.querySelector('.agent-text')?.textContent.includes('Recovered partial text.')
      && last?.querySelector('.agent-interrupted')?.textContent === 'interrupted'
      && last?.querySelector('.agent-message-retry')?.textContent === 'Retry';
  }, { timeout: 15_000 });
  a.check('clean EOF commits the live partial with interrupted badge and Retry', true);
  postMode = 'stream';
  const postsBeforeEofRetry = postBodies.length;
  await page.click('.agent-msg.assistant:last-child .agent-message-retry');
  await page.waitForFunction(() => {
    const last = document.querySelector('.agent-msg.assistant:last-child');
    return document.getElementById('agentSend')?.textContent === 'Send'
      && last?.querySelector('.agent-text')?.textContent.includes('Streamed answer.')
      && !last?.querySelector('.agent-interrupted');
  }, { timeout: 15_000 });
  a.check('clean EOF Retry uses one retry request and settles the same user turn',
    postBodies.length === postsBeforeEofRetry + 1 && postBodies.at(-1)?.retry === true,
    JSON.stringify(postBodies));
  a.check('clean EOF retry replaces the partial without duplicating its user turn',
    await page.evaluate(() => {
      const users = Array.from(document.querySelectorAll('.agent-msg.user .agent-bubble'));
      const assistants = Array.from(document.querySelectorAll('.agent-msg.assistant .agent-text'));
      return users.filter((row) => row.textContent === 'trigger clean eof').length === 1
        && assistants.every((row) => !row.textContent.includes('Recovered partial text.'));
    }));

  // Unified markdown pipeline serves the preview pane too (the shell uses
  // the same module export; no window global).
  const md = await page.evaluate(async () => {
    const island = await import('/_assets/agent-chat/agent-chat.js');
    const html = island.renderMarkdown('```js\nconst x = 1;\n```');
    return { hasHighlight: html.includes('hljs-keyword'), hasCopy: html.includes('code-copy') };
  });
  a.check('module renderMarkdown produces highlighted, copyable code', md.hasHighlight && md.hasCopy, JSON.stringify(md));

  // ── Phase 2: real backend, model-auth boundary honored honestly ─────
  interceptAgentApis = false;
  const statusResponse = await fetch(`${BASE}/s/${sid}/api/agent/status`, {
    headers: requestHeaders({ Accept: 'application/json', 'Cache-Control': 'no-store' }),
  });
  const status = await statusResponse.json();
  a.check('agent status API returns ok', statusResponse.status === 200 && status.ok === true, JSON.stringify(status));

  const expectedStatusText = status.connected
    ? `${status.oauth?.connected ? 'Cloudflare connected' : status.ownerToken?.configured ? 'Owner token' : 'Ready'} · ${status.model}`
    : status.configured
      ? 'Connect Cloudflare'
      : 'AI not configured';
  const expectedConnectVisible = !!status.oauth?.configured && !status.oauth.connected;

  await page.evaluate(() => window.NimbusAgent.ensureLoaded());
  await page.waitForFunction((expected) => (
    document.getElementById('agentStatus')?.textContent === expected
  ), { timeout: 30_000 }, expectedStatusText);

  const readGate = () => page.evaluate(() => ({
    inputDisabled: document.getElementById('agentInput')?.disabled ?? false,
    sendDisabled: document.getElementById('agentSend')?.disabled ?? false,
    composerDisabled: document.querySelector('.composer-card')?.classList.contains('disabled') ?? false,
    connectVisible: !!document.getElementById('agentConnect'),
    statusText: document.getElementById('agentStatus')?.textContent || '',
  }));

  if (!status.connected) {
    const gate = await readGate();
    a.check('connect gate disables the composer when AI is unavailable',
      gate.inputDisabled && gate.sendDisabled && gate.composerDisabled, JSON.stringify(gate));
    if (status.oauth?.configured) {
      a.check('OAuth mode surfaces the Connect affordance',
        gate.connectVisible && gate.statusText === expectedStatusText, JSON.stringify(gate));
    } else {
      a.check('unconfigured mode surfaces the configuration warning',
        !gate.connectVisible && gate.statusText === expectedStatusText, JSON.stringify(gate));
    }

    // Stop/abort against the real backend needs a live model turn; without
    // credentials the endpoint must refuse cleanly instead.
    const chatResponse = await fetch(`${BASE}/s/${sid}/api/agent/messages`, {
      method: 'POST',
      headers: requestHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ message: 'hello' }),
    });
    const chat = await chatResponse.json();
    a.check('unauthenticated chat refuses without side effects',
      chatResponse.status === 409 && chat.code === 'E_AGENT_AI_NOT_CONFIGURED',
      `status=${chatResponse.status} body=${JSON.stringify(chat)}`);
    const retryResponse = await fetch(`${BASE}/s/${sid}/api/agent/messages`, {
      method: 'POST',
      headers: requestHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({ retry: true }),
    });
    a.check('unauthenticated retry also refuses cleanly', retryResponse.status === 409, `status=${retryResponse.status}`);
  } else {
    await page.type('#agentInput', 'mode check');
    const gate = await readGate();
    a.check('configured credential mode enables the composer',
      !gate.inputDisabled && !gate.sendDisabled && !gate.composerDisabled,
      JSON.stringify(gate));
    a.check('configured credential mode shows only the applicable OAuth affordance and identifies the active mode',
      gate.connectVisible === expectedConnectVisible && gate.statusText === expectedStatusText,
      JSON.stringify(gate));
    await page.$eval('#agentInput', (input) => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('agentSend')?.disabled === true);

    // Live credentials: exercise a real send + stop; the backend must
    // persist the partial turn (or a complete one if it finished first).
    await page.evaluate(() => window.NimbusAgent.ensureLoaded());
    await page.type('#agentInput', 'Reply with a long paragraph about Nimbus.');
    await page.click('#agentSend');
    await page.waitForFunction(() => (document.getElementById('agentSend')?.textContent || '') === 'Stop', { timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await page.click('#agentSend'); // Stop
    await page.waitForFunction(() => (document.getElementById('agentSend')?.textContent || '') === 'Send', { timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const messagesResponse = await fetch(`${BASE}/s/${sid}/api/agent/messages`, {
      headers: requestHeaders({ Accept: 'application/json', 'Cache-Control': 'no-store' }),
    });
    const persisted = await messagesResponse.json();
    const last = persisted.messages[persisted.messages.length - 1];
    a.check('stopped turn leaves truthful history (user turn, or partial assistant marked aborted)',
      last && (last.role === 'user' || (last.role === 'assistant' && (last.aborted === true || (last.parts || []).length > 0))),
      JSON.stringify(last));
  }

  a.check('no browser runtime errors across the chat experience',
    runtimeErrors.length === 0,
    runtimeErrors.slice(0, 5).join('\n'));
} finally {
  if (page) await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
