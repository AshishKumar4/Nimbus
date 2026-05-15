#!/usr/bin/env bun
// monaco-wave-a/new/fs-read-binary-refused — fs-read on a binary
// (non-UTF-8) file returns binary:true with no content. The editor
// pane shows a friendly placeholder instead of mojibake.
//
// Setup: use the shell to write a known invalid UTF-8 sequence
// (`printf '\\xff\\xfe\\xfd' > path`). Then fs-read.

import WebSocket from 'ws';
import { mintSession, WS_BASE, Terminal, makeAsserter, sleep, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/fs-read-binary-refused');
console.log(`monaco-wave-a/new/fs-read-binary-refused — ${process.env.BASE}`);

const sid = await mintSession();

// Setup via shell-side Terminal. Plant invalid UTF-8 bytes by
// writing via node -e (more reliable than shell-level \xNN escape
// expansion, which varies across printf implementations).
{
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  // node -e writes raw bytes [0xff, 0xfe, 0xfd] via Buffer.
  await t.run(
    'node -e "require(\'fs\').writeFileSync(\'/home/user/probe-binary.bin\', Buffer.from([0xff,0xfe,0xfd]))"',
    20_000,
  );
  // Confirm it exists.
  const r = await t.run('wc -c /home/user/probe-binary.bin 2>&1', 10_000);
  a.check('binary file exists with non-UTF-8 content',
    /probe-binary\.bin/.test(stripAnsi(r.output)),
    `output=${JSON.stringify(stripAnsi(r.output))}`);
  await t.close();
}

// Now fetch via fs-read protocol.
const ws = new WebSocket(`${WS_BASE}/s/${sid}/ws`);
const messages = [];
ws.on('message', (data) => {
  try { messages.push(JSON.parse(data.toString('utf8'))); } catch {}
});
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('WS open timeout')), 15_000);
});

ws.send(JSON.stringify({ type: 'fs-read', path: '/home/user/probe-binary.bin', reqId: 1 }));
let result = null;
const t0 = Date.now();
while (Date.now() - t0 < 8_000) {
  result = messages.find(m => m.reqId === 1 && m.type === 'fs-read-result');
  if (result) break;
  await sleep(40);
}

a.check('fs-read on binary file returns a result frame',
  result !== null,
  `messages=${JSON.stringify(messages.slice(-5))}`);
if (result) {
  a.check('fs-read marks binary:true',
    result.binary === true,
    `result=${JSON.stringify(result)}`);
  a.check('fs-read leaves content undefined/empty for binary',
    !result.content,
    `result=${JSON.stringify(result)}`);
  a.check('fs-read error message mentions binary',
    /binary/i.test(result.error || ''),
    `error=${JSON.stringify(result.error)}`);
}

ws.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
