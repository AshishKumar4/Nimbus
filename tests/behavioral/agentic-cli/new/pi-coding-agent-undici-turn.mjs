#!/usr/bin/env bun
// agentic-cli/new/pi-coding-agent-undici-turn — pi completes a real turn.
//
// pi's dist/core/http-dispatcher.js constructs `undici.EnvHttpProxyAgent`,
// installs it with `setGlobalDispatcher`, and calls `undici.install?.()` at
// import time. Against the real undici that replaces globalThis.fetch with an
// implementation which throws `addAbortListenerNative is not a function` on
// its first call — which pi's user sees only as "Connection error" — and it
// also drops the session's own loopback and AI-egress routing along with it.
//
// The model here is an OpenAI-compatible server running in the same session,
// so the turn needs no external provider credential and exercises exactly the
// path undici.install() replaces: pi's HTTP client, through Nimbus's patched
// fetch, routed back into the session.

import {
  connectProcessTerminal,
  deleteSession,
  heredocCommand,
  makeAsserter,
  mintSession,
  sleep,
  stripAnsi,
  Terminal,
} from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('agentic-cli/new/pi-coding-agent-undici-turn');

const REPLY = 'NIMBUSOK';

const mockProvider = `
const http = require('http');
const chunk = (delta, finish, usage) => 'data: ' + JSON.stringify(Object.assign({
  id: 'chatcmpl-nimbus', object: 'chat.completion.chunk', created: 1, model: 'mock-1',
  choices: [{ index: 0, delta, finish_reason: finish }],
}, usage ? { usage } : {})) + '\\n\\n';

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!req.url.includes('chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(chunk({ role: 'assistant', content: '' }, null));
    res.write(chunk({ content: '${REPLY}' }, null));
    res.write(chunk({}, 'stop', { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }));
    res.write('data: [DONE]\\n\\n');
    res.end();
  });
}).listen(7411, '0.0.0.0', () => console.log('LISTENING 7411'));
`.trim();

const modelsJson = JSON.stringify({
  providers: {
    nimbusmock: {
      name: 'Nimbus Mock',
      baseUrl: 'http://127.0.0.1:7411/v1',
      apiKey: 'nimbus-mock-key',
      api: 'openai-completions',
      models: [{
        id: 'mock-1',
        name: 'Mock',
        api: 'openai-completions',
        input: ['text'],
        contextWindow: 32000,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  },
}, null, 2);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const install = stripAnsi((await t.run(
    'npm install -g --ignore-scripts @earendil-works/pi-coding-agent 2>&1 | tail -3', 420_000)).output);
  a.check('pi installs from npm',
    /added \d+ packages|Done!|up to date/.test(install), JSON.stringify(install.slice(-900)));

  await t.run(heredocCommand('/home/user/mock-provider.js', mockProvider), 30_000);
  const boot = stripAnsi((await t.run('node /home/user/mock-provider.js', 90_000)).output);
  a.check('in-session model server is listening',
    /LISTENING 7411|bin started \(long-running\)/.test(boot), JSON.stringify(boot.slice(-600)));
  await sleep(3000);

  await t.run('mkdir -p /home/user/.pi/agent', 30_000);
  await t.run(heredocCommand('/home/user/.pi/agent/models.json', modelsJson), 30_000);

  const launch = stripAnsi((await t.run(
    'cd /home/user && pi --model nimbusmock/mock-1 -p "say ok"', 120_000)).output);
  const pid = Number((launch.match(/bin started \(long-running\): pid=(\d+)/) || [])[1] || 0);
  a.check('pi starts', pid > 0 || /NIMBUSOK/.test(launch), JSON.stringify(launch.slice(-900)));

  let turn = launch;
  if (pid > 0) {
    const proc = await connectProcessTerminal(sid, pid);
    // A turn that never lands is the failure this probe exists to catch, so
    // the timeout is recorded as one rather than aborting the run.
    await proc.waitFor((out) => out.includes(REPLY), 240_000, 'pi turn output').catch(() => {});
    turn = `${launch}\n${proc.output}`;
    try { proc.ws.close(); } catch { /* probe teardown */ }
  }

  a.check('pi completes a turn against the in-session model',
    turn.includes(REPLY), JSON.stringify(turn.slice(-1500)));
  a.check('pi shows no undici failure',
    !/addAbortListenerNative|Connection error/i.test(turn), JSON.stringify(turn.slice(-1500)));

  // The fix must be the runtime mapping, not a shadowed module on disk.
  const shadow = stripAnsi((await t.run(
    "grep -l 'Nimbus' $(find / -path '*/node_modules/undici/index.js' 2>/dev/null) 2>/dev/null; echo SCANNED", 90_000)).output);
  a.check('no undici on disk was shadowed with a stub',
    /SCANNED/.test(shadow) && !/node_modules\/undici\/index\.js\s*$/m.test(shadow.split('SCANNED')[0]),
    JSON.stringify(shadow.slice(-900)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, `status=${cleanup.status}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
